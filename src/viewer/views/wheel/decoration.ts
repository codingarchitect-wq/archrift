// The Wheel's own drawing (a ViewDecoration): a plate under the bundles, an
// opaque ring holding the folder bands (it covers the arcs' first stretch, so
// they seem to leave from the innermost band), the ticks in the viewer's
// colors, and the bundles of whatever the pointer is over, drawn bright.
// Picks on the disc's plane: a band is its folder, a tick its file.
import * as THREE from 'three'
import { fileIdOf } from '../../../core/ids.ts'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { AREA_PALETTE, IN_COLOR, NEUTRAL, OUT_COLOR } from '../../colors.ts'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import type { SceneEngine } from '../../scene/engine.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { ARC_Y, BETA, FLAT_Y, bspline, controlPolygon, hitAt } from './layout.ts'
import type { Point, Wheel } from './layout.ts'

const FADE_MS = 450
/** Most bundles lit for one hovered folder. */
const MAX_LIT = 3000
const TAU = Math.PI * 2

/** What the plug-in shares with its decoration. */
export interface WheelHooks {
  wheelOf(layout: Layout): Wheel | undefined
  /** The colors the viewer chose last (the ticks take them). */
  colors(): Map<string, THREE.Color> | null
  /** Arcs routed since the last call. */
  routed(): number
}

interface Ring {
  start: number
  end: number
  inner: number
  outer: number
  y: number
}

type Hovered = { id: string; kind: 'mark' | 'sector' }

export class WheelDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private readonly engine: SceneEngine
  private readonly hooks: WheelHooks
  private readonly plate: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  private readonly bands: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  private readonly ticks: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  private readonly lit: LineSegments2
  private readonly litMaterial: LineMaterial
  /** First vertex of each band (0 is the ring behind them) and tick, and one past the last. */
  private bandVerts = new Int32Array(1)
  private tickVerts = new Int32Array(1)
  private wheel: Wheel | null = null
  private ctx: ViewContext | null = null
  private hovered: Hovered | null = null
  private litArcs = 0
  private litOpacity = 0.95
  private routedArcs = 0
  private fadeStart = -1
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLAT_Y)
  private readonly hit = new THREE.Vector3()
  private readonly onLeave = () => this.setHovered(null)

  constructor(engine: SceneEngine, hooks: WheelHooks) {
    this.engine = engine
    this.hooks = hooks
    const flat = (renderOrder: number, vertexColors: boolean) => {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors, side: THREE.DoubleSide, transparent: true }))
      m.renderOrder = renderOrder
      return m
    }
    // drawn before the engine's arcs (renderOrder 0): the plate under them, the bands over them
    this.plate = flat(-10, false)
    this.bands = flat(-9, true)
    this.ticks = flat(-9, true)
    this.litMaterial = new LineMaterial({ linewidth: 1.8, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false })
    this.lit = new LineSegments2(new LineSegmentsGeometry(), this.litMaterial)
    this.lit.renderOrder = 5
    this.lit.visible = false
    this.object.add(this.plate, this.bands, this.ticks, this.lit)
    // decorative: fade in, unless motion is unwelcome
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) this.fadeStart = 0
    else this.setOpacity(0)
    engine.renderer.domElement.addEventListener('pointerleave', this.onLeave)
  }

  update(ctx: ViewContext, layout: Layout) {
    this.ctx = ctx
    this.routedArcs = this.hooks.routed()
    const wheel = this.hooks.wheelOf(layout) ?? null
    if (wheel !== this.wheel) {
      this.wheel = wheel
      this.build()
      if (this.hovered && !(wheel?.angle.has(this.hovered.id) ?? false)) this.hovered = null
    }
    this.paint()
    this.light()
    this.engine.requestRender()
  }

  animate(time: number) {
    if (this.fadeStart === 0) return false
    if (this.fadeStart < 0) this.fadeStart = time
    const k = Math.min(1, (time - this.fadeStart) / FADE_MS)
    this.setOpacity(k * k * (3 - 2 * k))
    if (k < 1) return true
    this.fadeStart = 0
    return false
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    const w = this.wheel
    if (!w) return undefined
    const at = raycaster.ray.intersectPlane(this.plane, this.hit)
    const found = at ? hitAt(w, at.x, at.z) : undefined
    this.setHovered(found ?? null)
    if (!found) return found
    return { id: found.id, kind: found.kind === 'sector' ? 'cluster' : (w.layout.placement.get(found.id) ?? 'building') }
  }

  stats() {
    const w = this.wheel
    return {
      sectors: w?.sectors.length ?? 0,
      marks: w?.marks.length ?? 0,
      levels: w?.levels ?? 0,
      folded: w?.folded ?? 0,
      routed: this.routedArcs,
      lit: this.litArcs,
    }
  }

  dispose() {
    this.engine.renderer.domElement.removeEventListener('pointerleave', this.onLeave)
    for (const m of [this.plate, this.bands, this.ticks]) {
      m.geometry.dispose()
      m.material.dispose()
    }
    this.lit.geometry.dispose()
    this.litMaterial.dispose()
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  private build() {
    const w = this.wheel
    const bands: Ring[] = []
    const ticks: Ring[] = []
    let rim = 0
    if (w) {
      // the ring behind the bands, a hair below them
      bands.push({ start: 0, end: TAU, inner: w.hub, outer: w.radius, y: FLAT_Y - 0.02 })
      for (const s of w.sectors) bands.push({ ...s, y: FLAT_Y })
      for (const m of w.marks) {
        // a tick fills most of its slot; a folded folder's fills all of it but the edges
        const half = ((m.end - m.start) * (m.folded ? 0.92 : 0.78)) / 2
        ticks.push({ start: m.angle - half, end: m.angle + half, inner: w.radius, outer: w.radius + m.length, y: FLAT_Y })
        rim = Math.max(rim, m.length)
      }
    }
    const b = ringGeometry(bands)
    const t = ringGeometry(ticks)
    this.bands.geometry.dispose()
    this.bands.geometry = b.geometry
    this.bandVerts = b.starts
    this.ticks.geometry.dispose()
    this.ticks.geometry = t.geometry
    this.tickVerts = t.starts
    this.plate.geometry.dispose()
    this.plate.geometry = ringGeometry(w ? [{ start: 0, end: TAU, inner: 0, outer: w.radius + rim + w.radius * 0.03, y: 0 }] : []).geometry
  }

  private setOpacity(opacity: number) {
    for (const m of [this.plate, this.bands, this.ticks]) m.material.opacity = opacity
    this.litMaterial.opacity = this.litOpacity * opacity
  }

  // ── colors ────────────────────────────────────────────────────────────────

  /** Bands by depth (tinted like their files when those are colored by area or group), the selection's in the accent. */
  private paint() {
    const w = this.wheel
    const ctx = this.ctx
    if (!w || !ctx) return
    const theme = ctx.theme
    const plate = new THREE.Color(theme.ground)
    this.plate.material.color.copy(plate)
    const light = new THREE.Color(theme.background).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5
    const district = new THREE.Color(theme.district)
    const accent = new THREE.Color(theme.accent)
    const pointer = new THREE.Color(theme.selection)
    const tints = tintsFor(ctx, w)
    // the selection and the folders it is in
    const selected = ctx.s.selected && (fileIdOf(ctx.s.selected) ?? ctx.s.selected)
    const chain = new Set<string>()
    const mark = selected ? w.markOf.get(selected) : undefined
    if (selected) for (let p = w.parent.get(mark ?? selected); p !== undefined; p = w.parent.get(p)) chain.add(p)
    const wide = new Set(w.sectors.filter(s => s.end - s.start > Math.PI).map(s => s.id))

    const bands = this.bands.geometry
    if (bands.getAttribute('color')) {
      paintRange(bands, this.bandVerts, 0, plate)
      w.sectors.forEach((s, i) => {
        const c = district.clone().offsetHSL(0, 0, (light ? -0.018 : 0.022) * (s.depth - 1))
        const tint = tints.get(s.id)
        if (tint) c.lerp(tint, light ? 0.45 : 0.38)
        // the selection's folders, but not one holding nearly everything
        if (s.id === selected) c.lerp(accent, 0.7)
        else if (chain.has(s.id) && !wide.has(s.id)) c.lerp(accent, 0.25)
        if (this.hovered?.id === s.id) c.lerp(pointer, 0.25)
        paintRange(bands, this.bandVerts, i + 1, c)
      })
      bands.getAttribute('color').needsUpdate = true
    }
    const ticks = this.ticks.geometry
    if (ticks.getAttribute('color')) {
      const colors = this.hooks.colors()
      const neutral = new THREE.Color(NEUTRAL)
      w.marks.forEach((m, i) => paintRange(ticks, this.tickVerts, i, colors?.get(m.id) ?? neutral))
      ticks.getAttribute('color').needsUpdate = true
    }
  }

  // ── the pointer's bundles ─────────────────────────────────────────────────

  private setHovered(h: Hovered | null) {
    if (h?.id === this.hovered?.id) return
    this.hovered = h
    this.paint()
    this.light()
    this.engine.requestRender()
  }

  /** The dependencies of the hovered tick or band, routed like the arcs: out in the "uses" color, in in the "used by" one. */
  private light() {
    const w = this.wheel
    const ctx = this.ctx
    const h = this.hovered
    if (!h && !this.lit.visible) return
    const geometry = new LineSegmentsGeometry()
    this.litArcs = 0
    if (w && ctx && h) {
      const sector = h.kind === 'sector' ? w.sectors.find(s => s.id === h.id) : undefined
      const inside = sector
        ? (mark: string) => {
            const a = w.angle.get(mark)!
            return a >= sector.start && a <= sector.end
          }
        : (mark: string) => mark === h.id
      const pairs: { source: string; target: string; way: 0 | 1 | 2 }[] = []
      const seen = new Set<string>()
      scan: for (const [a, targets] of ctx.graph.weight) {
        const ma = w.markOf.get(a)
        if (ma === undefined) continue
        const fromInside = inside(ma)
        for (const b of targets.keys()) {
          const mb = w.markOf.get(b)
          if (mb === undefined || mb === ma) continue
          const toInside = inside(mb)
          if (!fromInside && !toInside) continue
          const key = `${ma}\u0000${mb}`
          if (seen.has(key)) continue
          seen.add(key)
          pairs.push({ source: ma, target: mb, way: fromInside && toInside ? 2 : fromInside ? 0 : 1 })
          if (pairs.length >= MAX_LIT) break scan
        }
      }
      const css = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null
      const token = (name: string, fallback: string) => new THREE.Color(css?.getPropertyValue(name).trim() || fallback)
      const out = token('--out', OUT_COLOR)
      const inc = token('--in', IN_COLOR)
      const beta = ctx.s.options.bundle ? BETA : 0
      const curves: { points: Point[]; from: THREE.Color; to: THREE.Color }[] = []
      let segments = 0
      for (const p of pairs) {
        const control = controlPolygon(w, p.source, p.target, beta)
        if (!control) continue
        const points = [control[0], ...bspline(control, 3), control[control.length - 1]]
        segments += points.length - 1
        curves.push({ points, from: p.way === 1 ? inc : out, to: p.way === 0 ? out : inc })
      }
      if (segments) {
        const positions = new Float32Array(segments * 6)
        const colors = new Float32Array(segments * 6)
        const c = new THREE.Color()
        let o = 0
        for (const { points, from, to } of curves) {
          const last = points.length - 1
          for (let i = 0; i < last; i++) {
            // each segment's two ends
            for (let k = i; k <= i + 1; k++) {
              positions[o] = points[k][0]
              positions[o + 1] = ARC_Y + 0.02
              positions[o + 2] = points[k][2]
              c.copy(from).lerp(to, k / last)
              colors[o] = c.r
              colors[o + 1] = c.g
              colors[o + 2] = c.b
              o += 3
            }
          }
        }
        geometry.setPositions(positions)
        geometry.setColors(colors)
        this.litArcs = curves.length
        // a big folder's hundreds of bundles: thinner and fainter, so they stay bundles
        this.litMaterial.linewidth = curves.length > 300 ? 1.2 : 1.8
        this.litOpacity = Math.max(0.25, Math.min(1, Math.sqrt(150 / curves.length))) * 0.95
        this.litMaterial.opacity = this.litOpacity * this.plate.material.opacity
        const canvas = this.engine.renderer.domElement
        this.litMaterial.resolution.set(canvas.clientWidth || 1, canvas.clientHeight || 1)
      }
    }
    this.lit.geometry.dispose()
    this.lit.geometry = geometry
    this.lit.visible = this.litArcs > 0
  }
}

/**
 * Bands take their files' color when the viewer colors by area (a folder
 * inside one area) or by group (a group's band): the wheel's legend.
 */
function tintsFor(ctx: ViewContext, w: Wheel): Map<string, THREE.Color> {
  const tints = new Map<string, THREE.Color>()
  const colorBy = ctx.s.options.colorBy
  if (ctx.grouping) {
    if (colorBy === 'group') ctx.grouping.groups.forEach((g, i) => tints.set(g.id, new THREE.Color(AREA_PALETTE[i % AREA_PALETTE.length])))
    return tints
  }
  if (colorBy !== 'area') return tints
  // area order as the viewer's (store.ts areaOrder): as first loaded on the timeline or after live changes
  const s = ctx.s
  const world = ctx.world
  const stable = !s.liveBase && (!s.options.timeline || s.now === world)
  const order = stable ? world.areas.map(a => a.id) : [...s.areaIds.filter(id => world.node(id)), ...world.areas.map(a => a.id).filter(id => !s.areaIds.includes(id))]
  const index = new Map(order.map((id, i) => [id, i]))
  // a file's area is its folder two levels down (or one, when that is where it is): so is a band's, from depth 2,
  // and a top folder's when it holds no folders of its own
  const depth = new Map(w.sectors.map(s => [s.id, s.depth]))
  const hasFolders = new Set(w.sectors.map(s => w.parent.get(s.id)))
  for (const sec of w.sectors) {
    let area: string | undefined = sec.id
    while (area !== undefined && (depth.get(area) ?? 0) > 2) area = w.parent.get(area)
    if (sec.depth === 1 && hasFolders.has(sec.id)) continue
    const i = area === undefined ? undefined : index.get(area)
    if (i !== undefined) tints.set(sec.id, new THREE.Color(AREA_PALETTE[i % AREA_PALETTE.length]))
  }
  return tints
}

/** Flat annular sectors in the XZ plane (angles clockwise from −z), one index range each, with a color per vertex. */
function ringGeometry(rings: readonly Ring[]) {
  const segments = rings.map(r => Math.max(1, Math.ceil((r.end - r.start) / (Math.PI / 90))))
  const starts = new Int32Array(rings.length + 1)
  let vertices = 0
  let triangles = 0
  rings.forEach((_, i) => {
    starts[i] = vertices
    vertices += (segments[i] + 1) * 2
    triangles += segments[i] * 2
  })
  starts[rings.length] = vertices
  const position = new Float32Array(vertices * 3)
  const index = new Uint32Array(triangles * 3)
  let v = 0
  let t = 0
  rings.forEach((r, i) => {
    const first = v
    for (let k = 0; k <= segments[i]; k++) {
      const a = r.start + ((r.end - r.start) * k) / segments[i]
      const x = Math.sin(a)
      const z = -Math.cos(a)
      position[v * 3] = r.inner * x
      position[v * 3 + 1] = r.y
      position[v * 3 + 2] = r.inner * z
      position[v * 3 + 3] = r.outer * x
      position[v * 3 + 4] = r.y
      position[v * 3 + 5] = r.outer * z
      v += 2
    }
    for (let k = 0; k < segments[i]; k++) {
      const o = first + k * 2
      index.set([o, o + 1, o + 2, o + 1, o + 3, o + 2], t)
      t += 6
    }
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.computeBoundingSphere()
  return { geometry, starts }
}

function paintRange(geometry: THREE.BufferGeometry, starts: Int32Array, i: number, color: THREE.Color) {
  const array = geometry.getAttribute('color').array as Float32Array
  for (let v = starts[i]; v < starts[i + 1]; v++) {
    array[v * 3] = color.r
    array[v * 3 + 1] = color.g
    array[v * 3 + 2] = color.b
  }
}
