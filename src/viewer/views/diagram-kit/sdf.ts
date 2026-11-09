// Diagram kit: a signed distance field from a glyph's coverage bitmap (the
// Felzenszwalb–Huttenlocher distance transform, run on squared distances
// outward and inward). The text layer keeps glyphs as distance fields, so one
// small atlas draws crisp text at any zoom. Pure: no canvas, no DOM.

const INF = 1e20

/**
 * The distance field of a coverage bitmap (0–255, row by row), as bytes: 128
 * on the outline, rising inside and falling outside, `radius` pixels to 0 or
 * 255.
 */
export function distanceField(alpha: ArrayLike<number>, w: number, h: number, radius: number): Uint8Array {
  const n = w * h
  const outer = new Float64Array(n)
  const inner = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = alpha[i] / 255
    // a partly covered pixel's outline lies inside it: start from that sub-pixel distance
    outer[i] = a >= 1 ? 0 : a <= 0 ? INF : Math.max(0, 0.5 - a) ** 2
    inner[i] = a >= 1 ? INF : a <= 0 ? 0 : Math.max(0, a - 0.5) ** 2
  }
  transform2d(outer, w, h)
  transform2d(inner, w, h)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i])
    out[i] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - d / (2 * radius))))
  }
  return out
}

/** Squared Euclidean distances to the nearest zero, in place: columns, then rows. */
function transform2d(grid: Float64Array, w: number, h: number) {
  const size = Math.max(w, h)
  const f = new Float64Array(size)
  const d = new Float64Array(size)
  const v = new Int32Array(size)
  const z = new Float64Array(size + 1)
  for (let x = 0; x < w; x++) transform1d(grid, x, w, h, f, d, v, z)
  for (let y = 0; y < h; y++) transform1d(grid, y * w, 1, w, f, d, v, z)
}

/** The 1D transform along `n` cells from `start`, `stride` apart: the lower envelope of parabolas. */
function transform1d(grid: Float64Array, start: number, stride: number, n: number, f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array) {
  for (let q = 0; q < n; q++) f[q] = grid[start + q * stride]
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = intersection(f, q, v[k])
    // z[0] is -INF, so this stops at the first parabola at the latest
    while (s <= z[k]) s = intersection(f, q, v[--k])
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const r = q - v[k]
    d[q] = r * r + f[v[k]]
  }
  for (let q = 0; q < n; q++) grid[start + q * stride] = d[q]
}

/** Where the parabolas rooted at q and p cross. */
function intersection(f: Float64Array, q: number, p: number): number {
  return (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p)
}
