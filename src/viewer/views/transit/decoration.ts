// Transit view, part 3: what the engine's boxes don't draw. The lines as
// flat colored ribbons with a casing, rounded at their bends (one merged mesh,
// later triangles over earlier ones, so a highlighted line is on top), the
// column bands under them, the rings that mark interchanges, and the label
// styles (line colors). A ribbon picks its line's entry file; a selected
// station dims the lines that don't pass it.
import * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import type { Theme } from '../../scene/engine.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { DIM, isLight, lineColorOn, litLines, maps } from './model.ts'
import type { TransitMap } from './model.ts'
import { RIBBON, ROW } from './schematic.ts'
import type { Point } from './schematic.ts'

/** Stations stand this high (their discs); rings lie just on top. */
export const STATION_Y = 0.1
export const STATION_H = 0.35
const RING_Y = STATION_Y + STATION_H + 0.02
const LINE_Y = 0.05
const BAND_Y = 0.02
const CASING = 0.55
const BEND_RADIUS = 2.4
const BEND_STEPS = 6
const FADE_MS = 700
/** Ring proportions: from 0.8 to 1 of its radius; an interchange's outline is this much wider than its white ring. */
const RING = new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2)
const OUTLINE_SCALE = 1.16

// who a vertex belongs to besides a line
const BAND = -2
const CASE = -1
// what a ring is besides a line's
const RING_OUTLINE = -2
const RING_WHITE = -1

/** Vertex indices, three per triangle. */
interface Strip {
  triangles: number[]
}

export class TransitDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
  private readonly mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
  private rings: THREE.InstancedMesh | null = null
  /** Each ring's station, kind (RING_OUTLINE, RING_WHITE, or the line whose color it takes) and radius, in drawing order. */
  private ringKinds: { id: string; kind: number; r: number }[] = []
  private readonly style = document.createElement('style')
  private map: TransitMap | null = null
  private theme: Theme | null = null
  private lit: Set<number> | null = null
  /** Per vertex: the line it belongs to, CASE or BAND. */
  private owner = new Int16Array(0)
  private strips: Strip[] = []
  /** Per triangle as drawn: the line, or -1. */
  private triangleLine = new Int16Array(0)
  private fadeFrom = -1
  private readonly still = matchMedia('(prefers-reduced-motion: reduce)').matches
  private readonly point = new THREE.Vector3()
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(STATION_Y + STATION_H / 2))

  constructor() {
    this.object.add(this.mesh)
    this.material.opacity = this.ringMaterial.opacity = this.still ? 1 : 0
    this.style.dataset.view = 'transit'
    document.head.appendChild(this.style)
  }

  update(ctx: ViewContext, layout: Layout) {
    const map = maps.get(layout)
    if (!map) return
    const lit = litLines(ctx, map)
    const themeChanged = this.theme?.background !== ctx.theme.background || this.theme?.ground !== ctx.theme.ground
    this.theme = ctx.theme
    if (map !== this.map) {
      this.map = map
      this.build(map)
    }
    this.lit = lit
    this.paint()
    if (themeChanged || this.style.dataset.lines !== String(map.network.lines.length)) this.writeStyles(map)
  }

  animate(time: number) {
    if (this.still) return false
    if (this.fadeFrom < 0) this.fadeFrom = time
    const k = Math.min(1, (time - this.fadeFrom) / FADE_MS)
    this.material.opacity = this.ringMaterial.opacity = k * k * (3 - 2 * k)
    return k < 1
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    const map = this.map
    if (!map) return undefined
    // a station (its disc or its ring) first, then a ribbon: its line's entry
    if (raycaster.ray.intersectPlane(this.plane, this.point))
      for (const s of map.schematic.stations.values())
        if (Math.hypot(this.point.x - s.x, this.point.z - s.z) <= s.radius * (s.interchange ? OUTLINE_SCALE * 1.1 : 1.25)) return { id: s.id, kind: 'building' }
    for (const hit of raycaster.intersectObject(this.mesh, false)) {
      const line = hit.faceIndex === undefined || hit.faceIndex === null ? -1 : this.triangleLine[hit.faceIndex]
      if (line >= 0) return { id: map.shown[line].id, kind: 'building' }
    }
    return undefined
  }

  stats(): Record<string, number> {
    const m = this.map
    if (!m) return {}
    const stations = [...m.schematic.stations.values()]
    return {
      lines: m.shown.length,
      candidates: m.network.lines.length,
      stations: stations.length,
      interchanges: stations.filter(s => s.interchange).length,
      branches: m.shown.reduce((n, l) => n + l.branches.length, 0),
      segments: m.schematic.segments.length,
      highlighted: this.lit?.size ?? 0,
      triangles: this.triangleLine.length,
    }
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.ringMaterial.dispose()
    this.rings?.dispose()
    this.style.remove()
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  private build(map: TransitMap) {
    const s = map.schematic
    const positions: number[] = []
    const owner: number[] = []
    const strips: Strip[] = []
    const vertex = (x: number, y: number, z: number, who: number) => {
      positions.push(x, y, z)
      owner.push(who)
      return owner.length - 1
    }
    // every other column band a shade lighter, from the headers to below the last row
    const top = s.minZ - ROW * 2.2
    const bottom = s.maxZ + ROW * 1.2
    const bands: Strip = { triangles: [] }
    s.bands.forEach((b, i) => {
      if (i % 2) return
      const [a, c, d, e] = [vertex(b.x0, BAND_Y, top, BAND), vertex(b.x1, BAND_Y, top, BAND), vertex(b.x1, BAND_Y, bottom, BAND), vertex(b.x0, BAND_Y, bottom, BAND)]
      bands.triangles.push(a, c, d, a, d, e)
    })
    strips.push(bands)
    // per line: its casing (a margin in the background color that sets it apart where lines cross) and its ribbon
    for (let line = 0; line < map.shown.length; line++) {
      const segments = s.segments.filter(g => g.line === line)
      const casing: Strip = { triangles: [] }
      const ribbon: Strip = { triangles: [] }
      for (const g of segments) {
        const path = rounded(g.points)
        ribbonStrip(path, RIBBON + CASING, (x, z) => vertex(x, LINE_Y, z, CASE), casing.triangles)
        ribbonStrip(path, RIBBON, (x, z) => vertex(x, LINE_Y, z, line), ribbon.triangles)
      }
      strips.push(casing, ribbon)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3))
    this.mesh.geometry.dispose()
    this.mesh.geometry = geometry
    this.owner = Int16Array.from(owner)
    this.strips = strips

    // rings: around an interchange a white one on a dark outline, around a station a thin one in its line's color
    this.rings?.removeFromParent()
    this.rings?.dispose()
    const all = [...s.stations.values()]
    const interchanges = all.filter(st => st.interchange)
    this.ringKinds = [
      ...interchanges.map(st => ({ id: st.id, kind: RING_OUTLINE, r: st.radius * 1.08 * OUTLINE_SCALE })),
      ...interchanges.map(st => ({ id: st.id, kind: RING_WHITE, r: st.radius * 1.08 })),
      ...all.filter(st => !st.interchange).map(st => ({ id: st.id, kind: st.lines[0], r: st.radius * 1.2 })),
    ]
    const rings = new THREE.InstancedMesh(RING, this.ringMaterial, Math.max(1, this.ringKinds.length))
    rings.count = this.ringKinds.length
    const m = new THREE.Matrix4()
    this.ringKinds.forEach(({ id, r }, i) => {
      const st = s.stations.get(id)!
      rings.setMatrixAt(i, m.makeScale(r, 1, r).setPosition(st.x, RING_Y, st.z))
    })
    rings.renderOrder = 1
    this.rings = rings
    this.object.add(rings)
  }

  /** Colors for the selection and the theme; the highlighted lines drawn last, on top. */
  private paint() {
    const map = this.map!
    const theme = this.theme!
    const lit = this.lit
    const ground = new THREE.Color(theme.ground)
    const casing = new THREE.Color(theme.background)
    const band = new THREE.Color(theme.district).lerp(ground, isLight(theme) ? 0.55 : 0.45)
    const colors = map.ranks.map((rank, i) => {
      const c = lineColorOn(rank, theme)
      return lit && !lit.has(i) ? c.lerp(ground, DIM) : c
    })
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute
    for (let v = 0; v < this.owner.length; v++) {
      const who = this.owner[v]
      const c = who === BAND ? band : who === CASE ? casing : colors[who]
      attr.setXYZ(v, c.r, c.g, c.b)
    }
    attr.needsUpdate = true

    // draw order: bands, the casings, the ribbons (so lines side by side don't cut each other); the highlighted lines after the rest
    const order = this.strips.slice(1).map((strip, k) => ({ strip, line: Math.floor(k / 2), casing: k % 2 === 0 }))
    const rank = (x: (typeof order)[number]) => (lit?.has(x.line) ? 2 : 0) + (x.casing ? 0 : 1)
    order.sort((a, b) => rank(a) - rank(b) || a.line - b.line)
    const index: number[] = [...this.strips[0].triangles]
    const triangleLine: number[] = new Array(this.strips[0].triangles.length / 3).fill(-1)
    for (const { strip, line } of order) {
      for (const i of strip.triangles) index.push(i)
      for (let t = 0; t < strip.triangles.length / 3; t++) triangleLine.push(line)
    }
    this.mesh.geometry.setIndex(index)
    this.mesh.geometry.computeBoundingSphere()
    this.triangleLine = Int16Array.from(triangleLine)

    if (this.rings) {
      const white = new THREE.Color('#ffffff')
      const ink = new THREE.Color(isLight(theme) ? theme.selection : theme.background)
      this.ringKinds.forEach(({ id, kind }, i) => {
        const on = !lit || map.schematic.stations.get(id)!.lines.some(l => lit.has(l))
        const c = kind === RING_OUTLINE ? ink : kind === RING_WHITE ? white : colors[kind]
        this.rings!.setColorAt(i, on || kind >= 0 ? c : c.clone().lerp(ground, DIM))
      })
      if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true
    }
  }

  /** Label styles: each line's color on its name. */
  private writeStyles(map: TransitMap) {
    const theme = this.theme!
    const rules = [
      '.label.transit-line { font-weight: 700; text-shadow: none; border-radius: 9px; padding: 0 7px; color: #fff; }',
      '.label.transit-line.ink { color: #14171c; }',
      '.label.transit-station { font-size: 10px; }',
      '.label.transit-station.interchange { font-size: 11px; font-weight: 700; }',
      '.label.transit-column { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }',
      '.label.transit-dim { opacity: 0.35; }',
    ]
    map.network.lines.forEach((_, rank) => rules.push(`.label.tl${rank} { background: #${lineColorOn(rank, theme).getHexString()}; }`))
    this.style.textContent = rules.join('\n')
    this.style.dataset.lines = String(map.network.lines.length)
  }
}

/** A polyline with its corners rounded (a quadratic curve through each). */
function rounded(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points]
  const out: Point[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const [a, p, b] = [points[i - 1], points[i], points[i + 1]]
    const la = Math.hypot(a[0] - p[0], a[1] - p[1])
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1])
    const r = Math.min(BEND_RADIUS, la / 2, lb / 2)
    if (r < 1e-3) {
      out.push(p)
      continue
    }
    const p1: Point = [p[0] + ((a[0] - p[0]) / la) * r, p[1] + ((a[1] - p[1]) / la) * r]
    const p2: Point = [p[0] + ((b[0] - p[0]) / lb) * r, p[1] + ((b[1] - p[1]) / lb) * r]
    for (let k = 0; k <= BEND_STEPS; k++) {
      const t = k / BEND_STEPS
      const u = 1 - t
      out.push([u * u * p1[0] + 2 * u * t * p[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * p[1] + t * t * p2[1]])
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** Two vertices per point, `width` apart across the path, and the triangles between them. */
function ribbonStrip(path: readonly Point[], width: number, vertex: (x: number, z: number) => number, triangles: number[]) {
  let prev: [number, number] | null = null
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)]
    const b = path[Math.min(path.length - 1, i + 1)]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nx = -(b[1] - a[1]) / len
    const nz = (b[0] - a[0]) / len
    const h = width / 2
    const pair: [number, number] = [vertex(path[i][0] + nx * h, path[i][1] + nz * h), vertex(path[i][0] - nx * h, path[i][1] - nz * h)]
    if (prev) triangles.push(prev[0], prev[1], pair[0], prev[1], pair[1], pair[0])
    prev = pair
  }
}
