// Terrain view: the heightfield. Each file's treemap cell raises the ground
// by its level (0–1, from a metric): a hill over the cell, on a plain that
// rises into a massif where hard files crowd, so calm code stays flat and hard
// code becomes mountain ranges. Below the water line, inside the city, the
// ground is water. Pure and deterministic (tests/viewer/views/terrain.test.ts).
import type { Rect } from '../../layouts/city.ts'
import type { Box } from '../../layouts/types.ts'

/** Where calm files lie: the plain, just above the water. */
export const PLAIN = 0.08
/** Ground below this, inside the city, is water (folder borders in the lowlands). */
export const WATER = 0.045
/** A hill reaches this far past its cell (as a share of the cell's half-size) … */
const SPREAD = 1.2
/** … and at least this far from its center at level 1 (as a share of the field's side). */
const FOOT = 0.09
/** How high a crowd of the hardest files lifts the ground under their hills. */
const MASSIF = 0.8

export interface Heightfield {
  /** Vertices per side. */
  n: number
  /** The square covered: [-size/2, size/2] in x and z. */
  size: number
  /** Distance between neighbouring vertices. */
  step: number
  /** Ground levels 0–1, row-major (rows along z, columns along x), water already flattened. */
  heights: Float32Array
  /** How deep the water is, 0 (land) to 1 (well below the line): tints the shore softly. */
  water: Float32Array
}

export interface FieldCell {
  rect: Rect
  /** 0–1 */
  level: number
}

/** Grid vertices per side: finer with more files, 256 at most. */
export const resolutionFor = (files: number) => Math.min(256, Math.max(96, Math.round(Math.sqrt(files) * 12)))

/**
 * Metric values as levels 0–1: mostly by rank (cubed, so the calm half stays
 * low and the top tenth stands out) with a little log scale, so a few giants
 * don't flatten the rest. Equal values share a level, the largest value is 1,
 * the smallest 0; all equal is all 0.
 */
export function levels(values: readonly number[]): number[] {
  const clean = values.map(v => (Number.isFinite(v) ? Math.max(0, v) : 0))
  const sorted = [...clean].sort((a, b) => a - b)
  const min = sorted[0] ?? 0
  const max = sorted.at(-1) ?? 0
  if (max === min) return clean.map(() => 0)
  const top = lowerBound(sorted, max)
  const logMax = Math.log1p(max - min)
  return clean.map(v => {
    const rank = lowerBound(sorted, v) / top
    return 0.85 * rank * rank * rank + 0.15 * (Math.log1p(v - min) / logMax)
  })
}

/**
 * The ground over a `size` square. `land` is where water can form (the
 * city's inner area); around it the ground slopes down to 0 at the edge.
 */
export function buildHeightfield(size: number, cells: readonly FieldCell[], land: Rect | null, n = resolutionFor(cells.length)): Heightfield {
  const step = size / (n - 1)
  const half = size / 2
  const at = (v: number) => (v + half) / step // world → fractional grid index
  const first = (v: number) => Math.max(0, Math.ceil(at(v) - 1e-9))
  const last = (v: number) => Math.min(n - 1, Math.floor(at(v) + 1e-9))
  const area = cells.reduce((a, c) => a + c.rect.w * c.rect.d, 0)
  const typical = cells.length ? Math.sqrt(area / cells.length) : size
  // a taller hill has a wider foot, so a small hard file is a mountain rather than a needle; but a
  // foot spans two or three cells at most: with thousands of files hills stay lower, and the
  // massif (below) carries the relief
  const reach = Math.min(size * FOOT, typical * 2.5)
  const tall = reach / (size * FOOT)
  const inCell = new Float32Array(n * n)
  const levelOf = new Float32Array(n * n)
  const hills = new Float32Array(n * n)
  for (const cell of cells) {
    const { rect } = cell
    const level = Math.min(1, Math.max(0, cell.level))
    for (let j = first(rect.z); j <= last(rect.z + rect.d); j++)
      for (let i = first(rect.x); i <= last(rect.x + rect.w); i++) {
        inCell[j * n + i] = 1
        levelOf[j * n + i] = Math.max(levelOf[j * n + i], level)
      }
    // a hill over the cell, a little wider than it and at least a few vertices across
    const top = PLAIN + (1 - PLAIN) * level * tall
    const cx = rect.x + rect.w / 2
    const cz = rect.z + rect.d / 2
    const foot = Math.max(top * size * FOOT, step * 1.5)
    const rx = Math.max((rect.w / 2) * SPREAD, foot)
    const rz = Math.max((rect.d / 2) * SPREAD, foot)
    for (let j = first(cz - rz); j <= last(cz + rz); j++) {
      const v = (j * step - half - cz) / rz
      for (let i = first(cx - rx); i <= last(cx + rx); i++) {
        const u = (i * step - half - cx) / rx
        const d2 = u * u + v * v
        if (d2 >= 1) continue
        // half a dome (broad shoulders merge neighbours into ranges), half a cone (a peak)
        const cone = 1 - Math.sqrt(d2)
        const h = top * 0.5 * ((1 - d2) * (1 - d2) + cone * cone)
        if (h > hills[j * n + i]) hills[j * n + i] = h
      }
    }
  }
  // under the hills, blurred over most of a typical cell: the plain wherever there are files (gaps
  // between folders sink), raised into a massif where hard files crowd (squared: scattered ones don't)
  const sigma = Math.min(Math.max((0.8 * typical) / step, 1.5), n / 20)
  const filled = blur(inCell, n, sigma)
  const crowd = blur(levelOf, n, sigma)
  const ground = new Float32Array(n * n)
  for (let k = 0; k < n * n; k++) ground[k] = Math.max(PLAIN * filled[k] + (1 - PLAIN) * MASSIF * crowd[k] * crowd[k], hills[k])
  const heights = blur(ground, n, 1)
  // outside the land the ground falls to 0 at the edge, so the landscape always meets the plane
  const shore = land ? Math.max(Math.min(land.x + half, land.z + half), step) : step * 3
  const water = new Float32Array(n * n)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      const x = i * step - half
      const z = j * step - half
      const edge = Math.min(x + half, half - x, z + half, half - z) / shore
      let h = Math.min(1, Math.max(0, heights[k])) * (edge < 1 ? edge * edge * (3 - 2 * edge) : 1)
      if (land && h < WATER && x >= land.x && x <= land.x + land.w && z >= land.z && z <= land.z + land.d) {
        water[k] = Math.min(1, (WATER - h) / (WATER * 0.4))
        h = WATER
      }
      heights[k] = h
    }
  return { n, size, step, heights, water }
}

/**
 * Gaussian blur of an n×n grid, edges extended: a weighted mean, so values
 * stay in range. Wide ones as three box blurs (running sums: as fast for
 * any sigma), narrow ones with the exact kernel.
 */
export function blur(src: Float32Array, n: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice()
  const line = new Float64Array(n)
  const passes: ((line: Float64Array) => void)[] = sigma < 1.5 ? [gaussianPass(n, sigma)] : boxWidths(sigma).map(w => boxPass(n, (w - 1) / 2))
  const out = src.slice()
  for (const pass of passes) {
    // rows, then columns
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) line[i] = out[j * n + i]
      pass(line)
      for (let i = 0; i < n; i++) out[j * n + i] = line[i]
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) line[j] = out[j * n + i]
      pass(line)
      for (let j = 0; j < n; j++) out[j * n + i] = line[j]
    }
  }
  return out
}

/** Three box widths (odd) whose repeated blur approximates a Gaussian of sigma (Kovesi). */
function boxWidths(sigma: number) {
  let low = Math.floor(Math.sqrt(4 * sigma * sigma + 1))
  if (low % 2 === 0) low--
  const lowCount = Math.round((12 * sigma * sigma - 3 * low * low - 12 * low - 9) / (-4 * low - 4))
  return [0, 1, 2].map(i => (i < lowCount ? low : low + 2))
}

/** A running-sum box blur of radius r over one line, in place. */
function boxPass(n: number, r: number) {
  const width = 2 * r + 1
  const padded = new Float64Array(n + width)
  return (line: Float64Array) => {
    for (let i = 0; i < padded.length; i++) padded[i] = line[Math.min(n - 1, Math.max(0, i - r))]
    let sum = 0
    for (let k = 0; k < width; k++) sum += padded[k]
    for (let i = 0; i < n; i++) {
      line[i] = sum / width
      sum += padded[i + width] - padded[i]
    }
  }
}

/** The exact kernel over one line, in place. */
function gaussianPass(n: number, sigma: number) {
  const r = Math.ceil(sigma * 3)
  const kernel = new Float64Array(2 * r + 1)
  let total = 0
  for (let k = -r; k <= r; k++) {
    kernel[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma))
    total += kernel[k + r]
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= total
  const padded = new Float64Array(n + 2 * r)
  return (line: Float64Array) => {
    for (let i = 0; i < padded.length; i++) padded[i] = line[Math.min(n - 1, Math.max(0, i - r))]
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let k = 0; k < kernel.length; k++) acc += kernel[k] * padded[i + k]
      line[i] = acc
    }
  }
}

/** The ground level at a point (bilinear between vertices; 0 outside the square). */
export function heightAt(f: Heightfield, x: number, z: number): number {
  const u = (x + f.size / 2) / f.step
  const v = (z + f.size / 2) / f.step
  if (!(u >= 0 && v >= 0 && u <= f.n - 1 && v <= f.n - 1)) return 0
  const i = Math.min(Math.floor(u), f.n - 2)
  const j = Math.min(Math.floor(v), f.n - 2)
  const fx = u - i
  const fz = v - j
  const h = f.heights
  const k = j * f.n + i
  const near = h[k] + (h[k + 1] - h[k]) * fx
  const far = h[k + f.n] + (h[k + f.n + 1] - h[k + f.n]) * fx
  return near + (far - near) * fz
}

/**
 * Lowest and highest ground level over a rectangle. Between vertices the
 * ground is bilinear, so the extremes are at vertices inside, at the corners,
 * or where grid lines cross the edges.
 */
export function rangeIn(f: Heightfield, r: Rect): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  const see = (h: number) => {
    if (h < lo) lo = h
    if (h > hi) hi = h
  }
  const half = f.size / 2
  const x1 = r.x + r.w
  const z1 = r.z + r.d
  for (const [x, z] of [
    [r.x, r.z],
    [x1, r.z],
    [r.x, z1],
    [x1, z1],
  ])
    see(heightAt(f, x, z))
  const i0 = Math.max(0, Math.ceil((r.x + half) / f.step))
  const i1 = Math.min(f.n - 1, Math.floor((x1 + half) / f.step))
  const j0 = Math.max(0, Math.ceil((r.z + half) / f.step))
  const j1 = Math.min(f.n - 1, Math.floor((z1 + half) / f.step))
  for (let i = i0; i <= i1; i++) {
    see(heightAt(f, i * f.step - half, r.z))
    see(heightAt(f, i * f.step - half, z1))
  }
  for (let j = j0; j <= j1; j++) {
    see(heightAt(f, r.x, j * f.step - half))
    see(heightAt(f, x1, j * f.step - half))
    for (let i = i0; i <= i1; i++) see(f.heights[j * f.n + i])
  }
  return [lo, hi]
}

/**
 * A building's treemap cell. The city insets a building by 14% of its cell's
 * shorter side (layouts/city.ts), so the cell is the box grown back by that.
 */
export function cellOf(b: Box): Rect {
  const margin = (Math.min(b.w, b.d) / 0.72) * 0.14
  return { x: b.x - b.w / 2 - margin, z: b.z - b.d / 2 - margin, w: b.w + 2 * margin, d: b.d + 2 * margin }
}

/** The last of `rects` containing the point, or -1 (regions ordered outer to inner, files last). */
export function lastContaining(rects: readonly Rect[], x: number, z: number): number {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]
    if (x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d) return i
  }
  return -1
}

/** For each vertex, the last of `rects` containing it (-1: none): which region colors it. */
export function owners(f: Heightfield, rects: readonly Rect[]): Int32Array {
  const out = new Int32Array(f.n * f.n).fill(-1)
  const half = f.size / 2
  rects.forEach((r, index) => {
    const i0 = Math.max(0, Math.ceil((r.x + half) / f.step - 1e-9))
    const i1 = Math.min(f.n - 1, Math.floor((r.x + r.w + half) / f.step + 1e-9))
    const j0 = Math.max(0, Math.ceil((r.z + half) / f.step - 1e-9))
    const j1 = Math.min(f.n - 1, Math.floor((r.z + r.d + half) / f.step + 1e-9))
    for (let j = j0; j <= j1; j++) out.fill(index, j * f.n + i0, j * f.n + i1 + 1)
  })
  return out
}

/**
 * For each vertex outside the regions from `first` on (the files), the
 * nearest one's index and how many vertices away it is (a breadth-first walk
 * from every file vertex at once); -1 where none is within `reach`.
 */
export function nearest(n: number, owner: Int32Array, first: number, reach: number): { index: Int32Array; distance: Uint8Array } {
  const index = new Int32Array(n * n).fill(-1)
  const distance = new Uint8Array(n * n)
  let frontier: number[] = []
  for (let k = 0; k < n * n; k++)
    if (owner[k] >= first) {
      index[k] = owner[k]
      frontier.push(k)
    }
  for (let d = 1; d <= reach && frontier.length; d++) {
    const next: number[] = []
    const visit = (from: number, m: number) => {
      if (m < 0 || m >= n * n || index[m] >= 0) return
      index[m] = index[from]
      distance[m] = d
      next.push(m)
    }
    for (const k of frontier) {
      if (k % n > 0) visit(k, k - 1)
      if (k % n < n - 1) visit(k, k + 1)
      visit(k, k - n)
      visit(k, k + n)
    }
    frontier = next
  }
  return { index, distance }
}

export type Vec3 = { x: number; y: number; z: number }

/**
 * Where a ray first meets the ground y = scale × level, or null. Marches in
 * half-vertex steps through the field's box, then bisects.
 */
export function raycastField(f: Heightfield, scale: number, o: Vec3, d: Vec3): Vec3 | null {
  const half = f.size / 2
  let t0 = 0
  let t1 = Infinity
  for (const [p, v, lo, hi] of [
    [o.x, d.x, -half, half],
    [o.y, d.y, 0, scale * 1.001],
    [o.z, d.z, -half, half],
  ]) {
    if (Math.abs(v) < 1e-12) {
      if (p < lo || p > hi) return null
      continue
    }
    const a = (lo - p) / v
    const b = (hi - p) / v
    t0 = Math.max(t0, Math.min(a, b))
    t1 = Math.min(t1, Math.max(a, b))
  }
  if (!(t0 <= t1)) return null
  const flat = Math.hypot(d.x, d.z)
  const dt = Math.min(flat > 1e-9 ? f.step / 2 / flat : Infinity, Math.abs(d.y) > 1e-9 ? scale / 64 / Math.abs(d.y) : Infinity)
  const below = (t: number) => o.y + d.y * t <= scale * heightAt(f, o.x + d.x * t, o.z + d.z * t)
  if (below(t0)) return point(o, d, t0)
  for (let t = t0; t < t1; ) {
    const next = Math.min(t + dt, t1)
    if (below(next)) {
      let a = t
      let b = next
      for (let k = 0; k < 12; k++) {
        const m = (a + b) / 2
        if (below(m)) b = m
        else a = m
      }
      return point(o, d, b)
    }
    t = next
  }
  return null
}

const point = (o: Vec3, d: Vec3, t: number): Vec3 => ({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t })

/**
 * The highest of `tops`, at most `count`, each at least `apart` from those
 * already taken (so one massif doesn't take every label); indexes, highest first.
 */
export function peaks(centers: readonly { x: number; z: number }[], tops: readonly number[], count: number, apart: number): number[] {
  const order = tops.map((_, i) => i).sort((a, b) => tops[b] - tops[a] || a - b)
  const taken: number[] = []
  for (const i of order) {
    if (taken.length >= count) break
    if (taken.every(j => Math.hypot(centers[i].x - centers[j].x, centers[i].z - centers[j].z) >= apart)) taken.push(i)
  }
  return taken
}

function lowerBound(sorted: number[], v: number) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}
