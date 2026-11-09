// arc42 kit: the drawing every arc42 view builds its diagram from. A Sketch
// collects primitives (boards, rounded boxes and slabs, frames, connectors
// with arrowheads, discs and rings, any three.js solid, tubes along curves)
// and builds them into one Drawing: two merged meshes, lit solids and flat
// ink. Each primitive has a tone (a color's name, resolved when painting, so
// the theme and the selection recolor without rebuilding) and an owner (the
// caller's number for what it stands for: picking and dimming; -1 = nothing).
//
// Flat primitives lie on a Surface: a 2D (u, v) plane placed in 3D. GROUND
// for a diagram on the floor, `level(y)` for one floating at height y, and
// `wall(z)` for an upright one facing the home camera. `lift` raises a
// primitive off its surface; flat ink is drawn in the order it was added
// (later on top), so add what lies underneath first.
import * as THREE from 'three'

export type P2 = readonly [number, number]
export type V3 = readonly [number, number, number]

/** A drawing plane: point (u, v) is origin + u·U + v·V, and lift goes along N. */
export interface Surface {
  origin: V3
  u: V3
  v: V3
  n: V3
}

/** The floor: u → +x, v → +z (toward the home camera), lift → up. */
export const GROUND: Surface = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] }

/** A plane parallel to the floor at height y. */
export const level = (y: number): Surface => ({ ...GROUND, origin: [0, y, 0] })

/** An upright plane at depth z facing the home camera: u → +x, v → down from height y, lift → toward the camera. */
export const wall = (z: number, y = 0): Surface => ({ origin: [0, y, z], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] })

/** The world point of (u, v) on a surface, `lift` off it. */
export function at(s: Surface, u: number, v: number, lift = 0): THREE.Vector3 {
  return new THREE.Vector3(
    s.origin[0] + u * s.u[0] + v * s.v[0] + lift * s.n[0],
    s.origin[1] + u * s.u[1] + v * s.v[1] + lift * s.n[1],
    s.origin[2] + u * s.u[2] + v * s.v[2] + lift * s.n[2],
  )
}

/** A rectangle on a surface: its center (u, v) and its size along u (w) and v (h). */
export interface Rect {
  u: number
  v: number
  w: number
  h: number
}

/** What a primitive is painted as and stands for. */
export interface Ink2 {
  tone: string
  /** The caller's number for the thing drawn (picking, dimming); -1 or left out: nothing. */
  owner?: number
}

export interface Dash {
  /** Lengths drawn and skipped, in world units. */
  on: number
  off: number
}

export interface RibbonOptions {
  width: number
  lift?: number
  /** Round the corners with this radius (0: sharp). */
  round?: number
  dash?: Dash
  /** Arrowheads (their tip is where the path ends). */
  head?: 'end' | 'start' | 'both'
  /** Arrowhead length and width (default 3.4 and 3 times the ribbon's width). */
  headLength?: number
  headWidth?: number
  /** The path is a loop. */
  closed?: boolean
}

const CORNER_STEPS = 6

/** A rounded rectangle's outline, counter-clockwise in (u, v), CORNER_STEPS + 1 points per corner (also when r is 0). */
export function roundedRect(rect: Rect, r: number): P2[] {
  const hw = rect.w / 2
  const hh = rect.h / 2
  const radius = Math.max(0, Math.min(r, hw, hh))
  const corners: [number, number, number][] = [
    [rect.u + hw - radius, rect.v + hh - radius, 0],
    [rect.u - hw + radius, rect.v + hh - radius, 0.5],
    [rect.u - hw + radius, rect.v - hh + radius, 1],
    [rect.u + hw - radius, rect.v - hh + radius, 1.5],
  ]
  const points: P2[] = []
  for (const [cu, cv, start] of corners)
    for (let k = 0; k <= CORNER_STEPS; k++) {
      const a = (start + (k / CORNER_STEPS) * 0.5) * Math.PI
      points.push([cu + radius * Math.cos(a), cv + radius * Math.sin(a)])
    }
  return points
}

/** A polyline with its corners rounded (a quadratic curve through each, radius at most half the shorter side). */
export function roundCorners(points: readonly P2[], radius: number, steps = 6): P2[] {
  if (points.length < 3 || radius <= 0) return [...points]
  const out: P2[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const [a, p, b] = [points[i - 1], points[i], points[i + 1]]
    const la = Math.hypot(a[0] - p[0], a[1] - p[1])
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1])
    const r = Math.min(radius, la / 2, lb / 2)
    if (r < 1e-3) {
      out.push(p)
      continue
    }
    const p1: P2 = [p[0] + ((a[0] - p[0]) / la) * r, p[1] + ((a[1] - p[1]) / la) * r]
    const p2: P2 = [p[0] + ((b[0] - p[0]) / lb) * r, p[1] + ((b[1] - p[1]) / lb) * r]
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      const s = 1 - t
      out.push([s * s * p1[0] + 2 * s * t * p[0] + t * t * p2[0], s * s * p1[1] + 2 * s * t * p[1] + t * t * p2[1]])
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** Pieces of a polyline: `on` long, `off` apart, along its length. */
export function dashes(points: readonly P2[], dash: Dash): P2[][] {
  const period = dash.on + dash.off
  if (dash.on <= 0 || dash.off <= 0) return [points.slice()]
  const out: P2[][] = []
  let along = 0
  let piece: P2[] | null = null
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const point = (d: number): P2 => [a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len]
    for (let d = 0; d < len - 1e-9; ) {
      const phase = (along + d) % period
      const drawing = phase < dash.on
      // how far to the next switch between drawn and skipped
      const switchIn = Math.max(1e-9, (drawing ? dash.on : period) - phase)
      const step = Math.min(switchIn, len - d)
      if (drawing) {
        piece ??= [point(d)]
        piece.push(point(d + step))
        if (switchIn <= len - d) {
          out.push(piece)
          piece = null
        }
      }
      d += step
    }
    along += len
  }
  if (piece && piece.length > 1) out.push(piece)
  return out
}

/** A polyline cut short by `cut` at its end, and the direction it had there. */
function shorten(points: readonly P2[], cut: number): { points: P2[]; tip: P2; dir: P2 } {
  const tip = points[points.length - 1]
  let left = cut
  for (let i = points.length - 1; i > 0; i--) {
    const [a, b] = [points[i - 1], points[i]]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len >= left || i === 1) {
      const t = len > 0 ? Math.max(0, 1 - left / len) : 0
      const end: P2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const dir: P2 = len > 0 ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : [1, 0]
      return { points: [...points.slice(0, i), end], tip, dir }
    }
    left -= len
  }
  return { points: [...points], tip, dir: [1, 0] }
}

/** Per point: the offset direction across a polyline (mitered at bends, limited at sharp ones). */
function miters(points: readonly P2[], closed: boolean): P2[] {
  const n = points.length
  const normal = (a: P2, b: P2): P2 => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]
  }
  return points.map((p, i) => {
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)]
    const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)]
    const a = prev === p ? normal(p, next) : normal(prev, p)
    const b = next === p ? normal(prev, p) : normal(p, next)
    const m: P2 = [a[0] + b[0], a[1] + b[1]]
    const len = Math.hypot(m[0], m[1])
    if (len < 1e-6) return a
    const scale = 1 / Math.max(0.4, (m[0] * a[0] + m[1] * a[1]) / len)
    return [(m[0] / len) * scale, (m[1] / len) * scale]
  })
}

interface Bucket {
  positions: number[]
  normals: number[]
  tones: number[]
  owners: number[]
}

const bucket = (): Bucket => ({ positions: [], normals: [], tones: [], owners: [] })

export class Sketch {
  private readonly tones: string[] = []
  private readonly toneIndex = new Map<string, number>()
  private readonly lit = bucket()
  private readonly flat = bucket()
  private readonly n = new THREE.Vector3()

  // ── flat ink ──────────────────────────────────────────────────────────────

  /** A filled rounded rectangle. */
  plate(paint: Ink2, s: Surface, rect: Rect, o: { r?: number; lift?: number } = {}) {
    this.fan(paint, s, roundedRect(rect, o.r ?? 0), [rect.u, rect.v], o.lift ?? 0)
  }

  /** A rounded rectangle's outline, `width` wide (centered on the edge), dashed or not. */
  frame(paint: Ink2, s: Surface, rect: Rect, o: { r?: number; lift?: number; width: number; dash?: Dash }) {
    this.ribbon(paint, s, roundedRect(rect, o.r ?? 0), { width: o.width, lift: o.lift, dash: o.dash, closed: true })
  }

  /** A connector: a flat band along a polyline, with rounded bends, dashes and arrowheads as asked. */
  ribbon(paint: Ink2, s: Surface, points: readonly P2[], o: RibbonOptions) {
    if (points.length < 2) return
    const lift = o.lift ?? 0
    let path = o.round ? roundCorners(points, o.round) : [...points]
    const headLength = o.headLength ?? o.width * 3.4
    const headWidth = o.headWidth ?? o.width * 3
    const heads: { tip: P2; dir: P2 }[] = []
    if (!o.closed && (o.head === 'end' || o.head === 'both')) {
      const cut = shorten(path, headLength * 0.85)
      path = cut.points
      heads.push({ tip: cut.tip, dir: cut.dir })
    }
    if (!o.closed && (o.head === 'start' || o.head === 'both')) {
      const cut = shorten([...path].reverse(), headLength * 0.85)
      path = cut.points.reverse()
      heads.push({ tip: cut.tip, dir: cut.dir })
    }
    const closedPath = o.closed ? [...path, path[0]] : path
    const pieces = o.dash ? dashes(closedPath, o.dash) : [closedPath]
    for (const piece of pieces) this.band(paint, s, piece, o.width, lift, !!o.closed && !o.dash)
    for (const { tip, dir } of heads) {
      const base: P2 = [tip[0] - dir[0] * headLength, tip[1] - dir[1] * headLength]
      const side: P2 = [-dir[1] * (headWidth / 2), dir[0] * (headWidth / 2)]
      this.polygon(paint, s, [tip, [base[0] + side[0], base[1] + side[1]], [base[0] - side[0], base[1] - side[1]]], { lift })
    }
  }

  /** A filled disc. */
  disc(paint: Ink2, s: Surface, center: P2, r: number, o: { lift?: number; segments?: number } = {}) {
    const k = o.segments ?? 32
    const points: P2[] = []
    for (let i = 0; i < k; i++) points.push([center[0] + r * Math.cos((i / k) * Math.PI * 2), center[1] + r * Math.sin((i / k) * Math.PI * 2)])
    this.fan(paint, s, points, center, o.lift ?? 0)
  }

  /** A ring from radius r0 to r1. */
  ring(paint: Ink2, s: Surface, center: P2, r0: number, r1: number, o: { lift?: number; segments?: number } = {}) {
    const k = o.segments ?? 40
    const lift = o.lift ?? 0
    for (let i = 0; i < k; i++) {
      const [a, b] = [(i / k) * Math.PI * 2, ((i + 1) / k) * Math.PI * 2]
      const p = (r: number, t: number): P2 => [center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)]
      this.quad2(paint, s, p(r0, a), p(r1, a), p(r1, b), p(r0, b), lift)
    }
  }

  /** A filled convex polygon. */
  polygon(paint: Ink2, s: Surface, points: readonly P2[], o: { lift?: number } = {}) {
    if (points.length < 3) return
    const lift = o.lift ?? 0
    for (let i = 1; i < points.length - 1; i++) this.flatTriangle(paint, s, points[0], points[i], points[i + 1], lift)
  }

  // ── lit solids ────────────────────────────────────────────────────────────

  /**
   * A rounded box standing on a surface: its top `height` above `lift`,
   * walls all round; `top` paints the top face in another tone, and `bottom`
   * closes it underneath (for boxes seen from below).
   */
  slab(paint: Ink2, s: Surface, rect: Rect, o: { r?: number; lift?: number; height: number; top?: string; bottom?: boolean }) {
    const outline = roundedRect(rect, o.r ?? 0)
    const lift = o.lift ?? 0
    const topLift = lift + o.height
    const up: V3 = s.n
    const topPaint = o.top ? { tone: o.top, owner: paint.owner } : paint
    for (let i = 0; i < outline.length; i++) {
      const [a, b] = [outline[i], outline[(i + 1) % outline.length]]
      this.litTriangle(topPaint, [at(s, rect.u, rect.v, topLift), at(s, a[0], a[1], topLift), at(s, b[0], b[1], topLift)], [up, up, up])
      if (o.bottom) {
        const down: V3 = [-up[0], -up[1], -up[2]]
        this.litTriangle(paint, [at(s, rect.u, rect.v, lift), at(s, b[0], b[1], lift), at(s, a[0], a[1], lift)], [down, down, down])
      }
    }
    // walls, with smooth normals round the corners
    const normals = miters(outline, true).map(([du, dv]) => {
      const len = Math.hypot(du, dv) || 1
      return this.worldDir(s, -du / len, -dv / len)
    })
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length
      const [a, b] = [outline[i], outline[j]]
      const [na, nb] = [normals[i], normals[j]]
      const [a0, a1, b0, b1] = [at(s, a[0], a[1], lift), at(s, a[0], a[1], topLift), at(s, b[0], b[1], lift), at(s, b[0], b[1], topLift)]
      this.litTriangle(paint, [a0, b0, b1], [na, nb, nb])
      this.litTriangle(paint, [a0, b1, a1], [na, nb, na])
    }
  }

  /** Any three.js geometry (a cylinder for a database, a sphere and a cone for a person …), placed by `matrix`. */
  solid(paint: Ink2, geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    if (matrix) g.applyMatrix4(matrix)
    const pos = g.getAttribute('position')
    const nor = g.getAttribute('normal')
    const tone = this.tone(paint.tone)
    for (let i = 0; i < pos.count; i++) {
      this.lit.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      this.lit.normals.push(nor.getX(i), nor.getY(i), nor.getZ(i))
      this.lit.tones.push(tone)
      this.lit.owners.push(paint.owner ?? -1)
    }
    g.dispose()
  }

  /** A tube along a smooth curve through world points (connectors in 3D, rings round pillars). */
  tube(paint: Ink2, points: readonly V3[], radius: number, o: { closed?: boolean; samples?: number; radial?: number } = {}) {
    if (points.length < 2) return
    const curve = new THREE.CatmullRomCurve3(
      points.map(p => new THREE.Vector3(...p)),
      !!o.closed,
      'centripetal',
    )
    const geometry = new THREE.TubeGeometry(curve, o.samples ?? Math.max(8, points.length * 8), radius, o.radial ?? 8, !!o.closed)
    this.solid(paint, geometry)
    geometry.dispose()
  }

  /** The drawing, ready to paint and add to the scene. */
  build(): Drawing {
    return new Drawing(this.lit, this.flat, [...this.tones])
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private tone(name: string) {
    let i = this.toneIndex.get(name)
    if (i === undefined) {
      i = this.tones.length
      this.tones.push(name)
      this.toneIndex.set(name, i)
    }
    return i
  }

  private worldDir(s: Surface, du: number, dv: number): V3 {
    this.n.set(du * s.u[0] + dv * s.v[0], du * s.u[1] + dv * s.v[1], du * s.u[2] + dv * s.v[2]).normalize()
    return [this.n.x, this.n.y, this.n.z]
  }

  private fan(paint: Ink2, s: Surface, outline: readonly P2[], center: P2, lift: number) {
    for (let i = 0; i < outline.length; i++) this.flatTriangle(paint, s, center, outline[i], outline[(i + 1) % outline.length], lift)
  }

  private band(paint: Ink2, s: Surface, path: readonly P2[], width: number, lift: number, loop: boolean) {
    const pts = loop ? path.slice(0, -1) : path
    const across = miters(pts, loop)
    const h = width / 2
    const side = (i: number, sign: number): P2 => [pts[i][0] + across[i][0] * h * sign, pts[i][1] + across[i][1] * h * sign]
    const count = loop ? pts.length : pts.length - 1
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % pts.length
      this.quad2(paint, s, side(i, 1), side(i, -1), side(j, -1), side(j, 1), lift)
    }
  }

  private quad2(paint: Ink2, s: Surface, a: P2, b: P2, c: P2, d: P2, lift: number) {
    this.flatTriangle(paint, s, a, b, c, lift)
    this.flatTriangle(paint, s, a, c, d, lift)
  }

  private flatTriangle(paint: Ink2, s: Surface, a: P2, b: P2, c: P2, lift: number) {
    const tone = this.tone(paint.tone)
    const points = facing([at(s, a[0], a[1], lift), at(s, b[0], b[1], lift), at(s, c[0], c[1], lift)], s.n)
    for (const w of points) {
      this.flat.positions.push(w.x, w.y, w.z)
      this.flat.normals.push(s.n[0], s.n[1], s.n[2])
      this.flat.tones.push(tone)
      this.flat.owners.push(paint.owner ?? -1)
    }
  }

  private litTriangle(paint: Ink2, points: THREE.Vector3[], normals: V3[]) {
    const tone = this.tone(paint.tone)
    const mean: V3 = [0, 1, 2].map(k => normals[0][k] + normals[1][k] + normals[2][k]) as unknown as V3
    const swapped = facing(points, mean) !== points
    const order = swapped ? [0, 2, 1] : [0, 1, 2]
    for (const i of order) {
      const p = points[i]
      this.lit.positions.push(p.x, p.y, p.z)
      this.lit.normals.push(...normals[i])
      this.lit.tones.push(tone)
      this.lit.owners.push(paint.owner ?? -1)
    }
  }
}

const ab = new THREE.Vector3()
const ac = new THREE.Vector3()

/**
 * A triangle wound so its front faces `up` (a surface's lift direction, or
 * a solid's outward normal): seen from behind, a double-sided material lights
 * it from the wrong side. The same array when it already does.
 */
function facing(points: THREE.Vector3[], up: V3): THREE.Vector3[] {
  ab.subVectors(points[1], points[0])
  ac.subVectors(points[2], points[0])
  const n = ab.cross(ac)
  return n.x * up[0] + n.y * up[1] + n.z * up[2] < 0 ? [points[0], points[2], points[1]] : points
}

/** A built sketch: lit solids and flat ink, painted by tone and owner, pickable by owner. */
export class Drawing {
  readonly object = new THREE.Group()
  private readonly meshes: { mesh: THREE.Mesh; tones: Uint16Array; owners: Int32Array }[] = []
  private readonly litMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  // flat ink is pulled toward the camera in the depth test, so ink lying on a solid's face never fights it
  private readonly flatMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  })
  private readonly toneNames: string[]

  constructor(lit: Bucket, flat: Bucket, tones: string[]) {
    this.toneNames = tones
    for (const [b, material, order] of [
      [lit, this.litMaterial, 0],
      [flat, this.flatMaterial, 1],
    ] as const) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3))
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(b.positions.length), 3))
      geometry.computeBoundingSphere()
      const mesh = new THREE.Mesh(geometry, material)
      mesh.renderOrder = order
      mesh.visible = b.positions.length > 0
      this.object.add(mesh)
      this.meshes.push({ mesh, tones: Uint16Array.from(b.tones), owners: Int32Array.from(b.owners) })
    }
  }

  /** Color every vertex: by its tone, and by its owner (to fade what isn't selected, say). */
  paint(color: (tone: string, owner: number) => THREE.Color) {
    const memo = new Map<string, THREE.Color>()
    for (const { mesh, tones, owners } of this.meshes) {
      const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute
      for (let i = 0; i < tones.length; i++) {
        const key = `${tones[i]}:${owners[i]}`
        let c = memo.get(key)
        if (!c) memo.set(key, (c = color(this.toneNames[tones[i]], owners[i])))
        attr.setXYZ(i, c.r, c.g, c.b)
      }
      attr.needsUpdate = true
    }
  }

  /** The owner of what the ray meets first; -1 for something without one; undefined when it meets nothing. */
  pick(raycaster: THREE.Raycaster): number | undefined {
    const hit = raycaster.intersectObjects(
      this.meshes.filter(m => m.mesh.visible).map(m => m.mesh),
      false,
    )[0]
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return undefined
    const owners = this.meshes.find(m => m.mesh === hit.object)!.owners
    return owners[hit.faceIndex * 3]
  }

  /** Fade the whole drawing in or out (1: opaque). */
  setOpacity(k: number) {
    this.litMaterial.transparent = k < 1
    this.litMaterial.opacity = k
    this.flatMaterial.opacity = k
    this.litMaterial.needsUpdate = true
  }

  stats() {
    return { triangles: this.meshes.reduce((n, m) => n + m.tones.length / 3, 0) }
  }

  dispose() {
    for (const { mesh } of this.meshes) mesh.geometry.dispose()
    this.litMaterial.dispose()
    this.flatMaterial.dispose()
  }
}
