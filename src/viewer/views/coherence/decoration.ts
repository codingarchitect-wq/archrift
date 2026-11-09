// Coherence view, part 3: what the engine's boxes don't draw.
//   City: the transitions of the job shown, a dependency between two files
//   doing it in no common way, as an arc from one way's color to the other's.
//   Clouds: the dots (flat discs, one instanced mesh), grey lines between the
//   job's files that depend on each other, and transitions in both ways'
//   colors. Painted by group instead, every dot takes its group's color (the
//   lobes show), the culprits (files doing the job differently from their
//   group) are ringed, and transitions are drawn in the rings' color. A dot
//   picks its file; a click on a cloud of several opens it.
// Hidden while the scene moves; a selection keeps what touches it bright.
// The toolbar's edges option picks the lines: all of them (auto, all), those
// around the selection, those breaking a rule (in the clouds, red; in the
// city the viewer draws those), or none.
import * as THREE from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { NEUTRAL, VIOLATION_COLOR } from '../../colors.ts'
import type { Layout } from '../../layouts/types.ts'
import type { DecorationHit } from '../../scene/decoration.ts'
import type { SceneEngine } from '../../scene/engine.ts'
import { violationNodes } from '../../store.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { choice, pickConcern, shownConcern } from './choice.ts'
import { cloudScenes } from './clouds.ts'
import type { CloudScene } from './clouds.ts'
import { MIXED_COLOR, coherenceFor, relatedOf, wayColors } from './model.ts'

/** Most transition arcs drawn in the city: past that, a sample spread over all of them. */
export const MAX_ARCS = 2500
const SEGMENTS = 14
const DOT_Y = 0.3
const LINE_Y = 0.1
const DISC = new THREE.CircleGeometry(1, 18).rotateX(-Math.PI / 2)
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
/** A culprit's ring, around its dot (radius 1). */
const RING = new THREE.RingGeometry(1.2, 1.42, 28).rotateX(-Math.PI / 2)

/**
 * The dependencies the toolbar's edges option lets this view draw, as a test
 * on two files (null: every one): selection, those within the selection's
 * neighborhood (none without one); violations, those breaking a rule.
 */
export function edgesShown(ctx: ViewContext): ((a: string, b: string) => boolean) | null {
  const mode = ctx.s.options.edges
  if (mode === 'auto' || mode === 'all') return null
  if (mode === 'none') return () => false
  if (mode === 'selection') {
    const related = relatedOf(ctx)
    return related ? (a, b) => related.has(a) && related.has(b) : () => false
  }
  const broken = new Set<string>()
  for (const v of ctx.world.graph.meta.violations ?? []) {
    if (!v.targets.includes(ctx.s.options.target)) continue
    const on = violationNodes(v)
    for (let i = 1; i < on.length; i++) broken.add(`${on[i - 1]}\0${on[i]}`)
  }
  return (a, b) => broken.has(`${a}\0${b}`) || broken.has(`${b}\0${a}`)
}

interface Arc {
  source: string
  target: string
  from: THREE.Color
  to: THREE.Color
}

export class CoherenceDecoration implements ViewDecoration {
  readonly object = new THREE.Group()
  private readonly engine: SceneEngine
  // city
  private readonly arcMaterial = new LineMaterial({ vertexColors: true, linewidth: 2.2, transparent: true, opacity: 0.95, depthWrite: false })
  private readonly arcLine = new LineSegments2(new LineSegmentsGeometry(), this.arcMaterial)
  private arcs: Arc[] = []
  private drawnArcs = 0
  // clouds
  private dots: THREE.InstancedMesh | null = null
  private readonly dotMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  private rings: THREE.InstancedMesh | null = null
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  // faded by color rather than by opacity: crossing lines don't pile up into white
  private readonly lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false })
  private readonly lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMaterial)
  private readonly crossMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false })
  private readonly crossing = new THREE.LineSegments(new THREE.BufferGeometry(), this.crossMaterial)
  /** Per instance: its cloud and file. */
  private owners: { cloud: number; file: string }[] = []
  private scene: CloudScene | null = null
  private sceneKey = ''
  private down: { x: number; y: number } | null = null

  private kind: 'city' | CloudScene['kind'] | null = null
  private dirty = false
  private readonly onResize = () => {
    this.dirty = true
    this.engine.requestRender()
  }
  private readonly onDown = (e: PointerEvent) => void (this.down = { x: e.clientX, y: e.clientY })
  private readonly onUp = (e: PointerEvent) => {
    const d = this.down
    this.down = null
    // a click (no drag) on a cloud of several opens it, after the engine has selected the dot's file
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || this.scene?.kind !== 'clouds') return
    const r = this.engine.renderer.domElement.getBoundingClientRect()
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.engine.camera)
    const k = this.cloudAt(ray)
    const concern = k === null ? undefined : this.scene.clouds[k]?.concern.concern.id
    if (concern) setTimeout(() => pickConcern(concern), 0)
  }

  constructor(engine: SceneEngine) {
    this.engine = engine
    this.arcLine.renderOrder = 5
    this.arcLine.visible = false
    this.lines.renderOrder = 1
    this.crossing.renderOrder = 2
    this.lines.visible = this.crossing.visible = false
    this.object.add(this.arcLine, this.lines, this.crossing)
    addEventListener('resize', this.onResize)
    engine.renderer.domElement.addEventListener('pointerdown', this.onDown)
    engine.renderer.domElement.addEventListener('pointerup', this.onUp)
  }

  update(ctx: ViewContext, layout: Layout) {
    const scene = cloudScenes.get(layout) ?? null
    const kind = scene ? scene.kind : 'city'
    // switching between the city and the clouds (or one cloud and all) keeps the view: the camera goes home
    if (this.kind !== null && this.kind !== kind) this.engine.home()
    this.kind = kind
    if (scene) {
      this.arcs = []
      this.updateClouds(ctx, scene)
    } else {
      this.clearClouds()
      this.updateArcs(ctx, layout)
    }
    this.dirty = true
  }

  // ── city ─────────────────────────────────────────────────────────────────

  private updateArcs(ctx: ViewContext, layout: Layout) {
    const c = coherenceFor(ctx.world, ctx.grouping)
    const concern = shownConcern(c)
    const arcs: Arc[] = []
    if (concern) {
      const colors = wayColors(concern)
      const related = relatedOf(ctx)
      const colorOf = (id: string) => {
        const ways = c.model.ways.get(id)?.get(concern.concern.id) ?? []
        return new THREE.Color(ways.length > 1 ? MIXED_COLOR : (colors.get(ways[0]) ?? MIXED_COLOR))
      }
      // the rule breakers are the viewer's to draw, in their own color: no transition over them
      const keep = ctx.s.options.edges === 'violations' ? () => false : edgesShown(ctx)
      const shown = concern.transitions.filter(([a, b]) => layout.boxes.has(a) && layout.boxes.has(b) && (!keep || keep(a, b)) && (!related || related.has(a) || related.has(b)))
      const step = Math.max(1, shown.length / MAX_ARCS)
      for (let i = 0; i < shown.length && arcs.length < MAX_ARCS; i += step) {
        const [a, b] = shown[Math.floor(i)]
        arcs.push({ source: a, target: b, from: colorOf(a), to: colorOf(b) })
      }
    }
    this.arcs = arcs
  }

  private rebuildArcs() {
    const positions: number[] = []
    const colors: number[] = []
    const p = new THREE.Vector3()
    const c = new THREE.Color()
    let drawn = 0
    for (const arc of this.arcs) {
      const a = this.engine.boxOf(arc.source)
      const b = this.engine.boxOf(arc.target)
      if (!a || !b) continue
      const from = new THREE.Vector3(a.x, a.y + a.h, a.z)
      const to = new THREE.Vector3(b.x, b.y + b.h, b.z)
      const mid = from.clone().add(to).multiplyScalar(0.5)
      mid.y = Math.max(from.y, to.y) + from.distanceTo(to) * 0.35 + 6
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to)
      for (let k = 0; k < SEGMENTS; k++)
        for (const t of [k / SEGMENTS, (k + 1) / SEGMENTS]) {
          curve.getPoint(t, p)
          c.copy(arc.from).lerp(arc.to, t)
          positions.push(p.x, p.y, p.z)
          colors.push(c.r, c.g, c.b)
        }
      drawn++
    }
    const geometry = new LineSegmentsGeometry()
    if (positions.length) {
      geometry.setPositions(positions)
      geometry.setColors(colors)
    }
    this.arcLine.geometry.dispose()
    this.arcLine.geometry = geometry
    this.arcLine.visible = drawn > 0
    this.drawnArcs = drawn
    const canvas = this.engine.renderer.domElement
    this.arcMaterial.resolution.set(canvas.clientWidth || 1, canvas.clientHeight || 1)
  }

  // ── clouds ───────────────────────────────────────────────────────────────

  private updateClouds(ctx: ViewContext, scene: CloudScene) {
    const background = new THREE.Color(ctx.theme.background)
    const light = background.getHSL({ h: 0, s: 0, l: 0 }).l > 0.5
    // files not doing the job: small and quiet, an outline of the system for the job's colors to stand out on
    const ghost = new THREE.Color(NEUTRAL).lerp(background, light ? 0.6 : 0.68)
    // lines: within the job's way a soft grey, the rest of the system a trace of its shape
    const grey = new THREE.Color(NEUTRAL).lerp(background, light ? 0.35 : 0.4)
    const trace = new THREE.Color(NEUTRAL).lerp(background, light ? 0.86 : 0.9)
    const related = relatedOf(ctx)
    const selected = ctx.s.selected
    const keep = edgesShown(ctx)
    const broken = ctx.s.options.edges === 'violations' ? new THREE.Color(VIOLATION_COLOR) : null
    const byGroup = choice.getState().paint === 'groups'
    // the culprits' mark: the text color, on both backgrounds
    const mark = new THREE.Color(light ? '#1f2328' : '#ffffff')
    const groupColors = scene.groups.map(g => new THREE.Color(g.color))
    const count = scene.clouds.reduce((n, c) => n + c.dots.length, 0)
    const culprits = byGroup ? scene.clouds.reduce((n, c) => n + c.dots.filter(d => d.stray).length, 0) : 0
    const key = `${scene.clouds.map(c => c.concern.concern.id).join(',')}|${count}`
    if (key !== this.sceneKey || !this.dots) {
      this.sceneKey = key
      if (this.dots) {
        this.object.remove(this.dots)
        this.dots.dispose()
      }
      this.dots = new THREE.InstancedMesh(DISC, this.dotMaterial, Math.max(count, 1))
      this.dots.renderOrder = 3
      this.object.add(this.dots)
    }
    if (!this.rings || this.rings.instanceMatrix.count < culprits) {
      if (this.rings) {
        this.object.remove(this.rings)
        this.rings.dispose()
      }
      this.rings = new THREE.InstancedMesh(RING, this.ringMaterial, Math.max(culprits, 64))
      this.rings.renderOrder = 4
      this.rings.raycast = () => {} // a ring is no node: its dot picks
      this.object.add(this.rings)
    }
    this.ringMaterial.color.copy(mark)
    this.scene = scene
    const dots = this.dots!
    const rings = this.rings
    dots.count = count
    rings.count = culprits
    let ringAt = 0
    const m = new THREE.Matrix4()
    const color = new THREE.Color()
    const white = new THREE.Color('#ffffff')
    const owners: { cloud: number; file: string }[] = []
    const base: number[] = []
    const baseColors: number[] = []
    const cross: number[] = []
    const crossColors: number[] = []
    let i = 0
    scene.clouds.forEach((cloud, k) => {
      const colors = wayColors(cloud.concern)
      const colorOf = (way: string | null) => (way === null ? ghost : way === '*' ? new THREE.Color(MIXED_COLOR) : new THREE.Color(colors.get(way) ?? MIXED_COLOR))
      const dim = (id: string) => !!related && !related.has(id)
      for (const d of cloud.dots) {
        const own = d.way !== null
        const isSel = d.file === selected
        // by group: the job's files in their group's color, the rest of the group quieter, culprits a little bigger
        const r = (own ? d.r * (byGroup && d.stray ? 1.2 : 1) : d.r * (byGroup ? 0.6 : 0.45)) * (isSel ? 2.2 : 1)
        m.makeScale(r, 1, r).setPosition(d.x, own ? DOT_Y : DOT_Y * 0.5, d.z)
        dots.setMatrixAt(i, m)
        if (byGroup) color.copy(groupColors[d.group]).lerp(background, own ? 0 : 0.45)
        else color.copy(colorOf(d.way))
        if (own && dim(d.file)) color.lerp(background, 0.75)
        if (isSel) color.lerp(white, 0.5)
        dots.setColorAt(i, color)
        if (byGroup && d.stray) {
          m.makeScale(r, 1, r).setPosition(d.x, DOT_Y * 1.2, d.z)
          rings.setMatrixAt(ringAt++, m)
        }
        owners.push({ cloud: k, file: d.file })
        i++
      }
      for (const [a, b] of cloud.lines) {
        const da = cloud.dots[a]
        const db = cloud.dots[b]
        if (keep && !keep(da.file, db.file)) continue
        if (broken) {
          cross.push(da.x, LINE_Y, da.z, db.x, LINE_Y, db.z)
          crossColors.push(...broken.toArray(), ...broken.toArray())
          continue
        }
        const inJob = da.way !== null && db.way !== null
        const across = inJob && da.way !== db.way && da.way !== '*' && db.way !== '*'
        const faded = !!related && !related.has(da.file) && !related.has(db.file)
        if (!inJob) {
          base.push(da.x, LINE_Y * 0.5, da.z, db.x, LINE_Y * 0.5, db.z)
          baseColors.push(...trace.toArray(), ...trace.toArray())
        } else if (across) {
          const ca = byGroup ? mark : colorOf(da.way)
          const cb = byGroup ? mark : colorOf(db.way)
          cross.push(da.x, LINE_Y, da.z, db.x, LINE_Y, db.z)
          crossColors.push(...(faded ? ca.clone().lerp(background, 0.8) : ca).toArray(), ...(faded ? cb.clone().lerp(background, 0.8) : cb).toArray())
        } else {
          const g = faded ? grey.clone().lerp(background, 0.7) : grey
          base.push(da.x, LINE_Y, da.z, db.x, LINE_Y, db.z)
          baseColors.push(...g.toArray(), ...g.toArray())
        }
      }
    })
    dots.instanceMatrix.needsUpdate = true
    if (dots.instanceColor) dots.instanceColor.needsUpdate = true
    dots.computeBoundingSphere()
    rings.instanceMatrix.needsUpdate = true
    rings.visible = culprits > 0
    this.owners = owners
    setLines(this.lines, base, baseColors)
    setLines(this.crossing, cross, crossColors)

  }

  private clearClouds() {
    this.scene = null
    if (this.dots) {
      this.object.remove(this.dots)
      this.dots.dispose()
      this.dots = null
      this.sceneKey = ''
    }
    if (this.rings) this.rings.visible = false
    this.lines.visible = this.crossing.visible = false
  }

  pick(raycaster: THREE.Raycaster): DecorationHit | null | undefined {
    if (!this.dots || !this.scene || !this.dots.visible) return undefined
    const hit = raycaster.intersectObject(this.dots, false)[0]
    const owner = hit?.instanceId !== undefined ? this.owners[hit.instanceId] : undefined
    if (owner) return { id: owner.file, kind: 'building' }
    // between the dots: over a cloud (a click opens it) there's no file; elsewhere, nothing of ours
    return this.cloudAt(raycaster) === null ? undefined : null
  }

  /** The cloud under a ray: a dot's, or the one whose extent it meets on the ground. */
  private cloudAt(raycaster: THREE.Raycaster): number | null {
    if (!this.dots || !this.scene) return null
    const hit = raycaster.intersectObject(this.dots, false)[0]
    if (hit?.instanceId !== undefined) return this.owners[hit.instanceId]?.cloud ?? null
    const p = raycaster.ray.intersectPlane(GROUND, new THREE.Vector3())
    const k = p ? this.scene.clouds.findIndex(c => p.x >= c.rect.x0 && p.x <= c.rect.x1 && p.z >= c.rect.z0 && p.z <= c.rect.z1) : -1
    return k >= 0 ? k : null
  }

  animate(): boolean {
    // the scene moves (a view switch, a new layout): nothing of ours until it stands
    if (this.engine.busy()) {
      this.arcLine.visible = false
      if (this.dots) this.dots.visible = false
      if (this.rings) this.rings.visible = false
      this.lines.visible = this.crossing.visible = false
      this.dirty = true
      return true
    }
    if (this.dirty) {
      this.dirty = false
      this.rebuildArcs()
      if (this.dots) this.dots.visible = true
      if (this.rings) this.rings.visible = !!this.scene && this.rings.count > 0
      this.lines.visible = !!this.scene && (this.lines.geometry.getAttribute('position')?.count ?? 0) > 0
      this.crossing.visible = !!this.scene && (this.crossing.geometry.getAttribute('position')?.count ?? 0) > 0
    }
    return false
  }

  stats() {
    return {
      transitions: this.drawnArcs,
      clouds: this.scene?.clouds.length ?? 0,
      dots: this.dots?.count ?? 0,
      rings: this.scene && this.rings?.visible ? this.rings.count : 0,
      lines: (this.lines.geometry.getAttribute('position')?.count ?? 0) / 2,
      crossings: (this.crossing.geometry.getAttribute('position')?.count ?? 0) / 2,
    }
  }

  dispose() {
    removeEventListener('resize', this.onResize)
    this.engine.renderer.domElement.removeEventListener('pointerdown', this.onDown)
    this.engine.renderer.domElement.removeEventListener('pointerup', this.onUp)
    this.arcLine.geometry.dispose()
    this.arcMaterial.dispose()
    this.dots?.dispose()
    this.dotMaterial.dispose()
    this.rings?.dispose()
    this.ringMaterial.dispose()
    this.lines.geometry.dispose()
    this.crossing.geometry.dispose()
    this.lineMaterial.dispose()
    this.crossMaterial.dispose()
  }
}

function setLines(line: THREE.LineSegments, positions: number[], colors: number[]) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  line.geometry.dispose()
  line.geometry = g
}
