// The Tree view's own 3D content (a view decoration): every folder's branch
// as a tapered, slightly curved run of instanced cylinder segments, a knot
// at each fork, and the hottest files as red fruit under their leaves.
// Branches are picked as their folder. When the shown world changes (a view
// switch, a filter, a step on the timeline, a save in watch mode) branches
// grow out from the trunk or wither back, level by level, and thicken or thin
// with the files under them, in step with the engine's tween of the leaves.
import * as THREE from 'three'
import { fileIdOf } from '../../../core/ids.ts'
import { heat } from '../../colors.ts'
import type { Layout } from '../../layouts/types.ts'
import type { SceneEngine } from '../../scene/engine.ts'
import type { ViewContext, ViewDecoration } from '../types.ts'
import { branchRadius } from './layout.ts'
import type { TreeShape } from './layout.ts'

/** As long as the engine's layout tween, so branches and leaves arrive together. */
const TWEEN_MS = 900
/** Cylinder segments for all branches together: fewer per branch in a large tree. */
const MAX_SEGMENTS = 6000
const TRUNK_FLARE = 1.3
/** Bark: a warm brown, pulled toward the scene's district color so it sits in either scheme. */
const BARK = '#7a5c43'
const FRUIT = heat(1)

/** A branch as drawn: base, bend, tip (xyz each), radius at base and tip, how far grown (0–1). */
const POSE = 12

interface Entry {
  id: string
  depth: number
  parent: number
}

export class Bark implements ViewDecoration {
  readonly object = new THREE.Group()
  private readonly engine: SceneEngine
  private readonly still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  private readonly cylinder = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0)
  private readonly ball = new THREE.SphereGeometry(1, 12, 8)
  private readonly barkMaterial = taperedLambert()
  private readonly knotMaterial = new THREE.MeshLambertMaterial()
  private readonly fruitMaterial = new THREE.MeshLambertMaterial({ color: FRUIT })
  /** The cylinder with this tree's taper per segment (a new one per mesh size). */
  private segment: THREE.BufferGeometry | null = null
  private bark: THREE.InstancedMesh | null = null
  private knots: THREE.InstancedMesh | null = null
  private fruit: THREE.InstancedMesh | null = null
  private taper = new THREE.InstancedBufferAttribute(new Float32Array(0), 1)
  private segments = 3

  private layout: Layout | null = null
  private shape: TreeShape | null = null
  private entries: Entry[] = []
  private from = new Float32Array(0)
  private to = new Float32Array(0)
  private now = new Float32Array(0)
  private tween: { t0: number; appearing: number; leaving: number } | null = null
  private fruitIds: string[] = []
  private leafIds: string[] = []
  private moonIds: string[] = []
  private readonly branchOf = new Map<string, number>()

  constructor(engine: SceneEngine) {
    this.engine = engine
  }

  update(ctx: ViewContext, layout: Layout) {
    const shape = shapeOf(layout)
    if (!shape) return
    if (layout !== this.layout) {
      this.layout = layout
      this.shape = shape
      this.leafIds = [...layout.placement].filter(([, p]) => p === 'building').map(([id]) => id)
      this.retarget(shape)
    }
    // the open file's moons can stand in front of a branch
    const file = ctx.s.selected ? fileIdOf(ctx.s.selected) : undefined
    const details = file && layout.boxes.has(file) ? ctx.s.details[file] : undefined
    this.moonIds = details ? details.symbols.filter(x => x.kind === 'symbol').map(x => x.id) : []
    this.recolor(ctx)
    this.engine.requestRender()
  }

  animate(time: number) {
    // fruit hang under leaves the engine may be moving
    this.placeFruit()
    if (!this.tween) return false
    const k = Math.min(1, (time - this.tween.t0) / TWEEN_MS)
    this.pose(k)
    this.write()
    if (k === 1) this.tween = null
    return k < 1
  }

  pick(raycaster: THREE.Raycaster) {
    const meshes = [this.bark, this.knots, this.fruit].filter((m): m is THREE.InstancedMesh => !!m)
    const hit = raycaster.intersectObjects(meshes, false)[0]
    if (!hit || hit.instanceId === undefined) return undefined
    // a leaf (or a moon) in front of it is the engine's to pick
    if (this.leafBefore(raycaster.ray, hit.distance)) return undefined
    if (hit.object === this.fruit) return { id: this.fruitIds[hit.instanceId], kind: 'building' as const }
    const branch = hit.object === this.bark ? Math.floor(hit.instanceId / this.segments) : hit.instanceId
    return { id: this.entries[branch].id, kind: 'cluster' as const }
  }

  stats() {
    let branches = 0
    for (let i = 0; i < this.entries.length; i++) if (this.to[i * POSE + 11] > 0) branches++
    return { branches, segments: branches * this.segments, fruit: this.fruitIds.length }
  }

  dispose() {
    for (const m of [this.bark, this.knots, this.fruit]) m?.dispose()
    for (const g of [this.segment, this.cylinder, this.ball]) g?.dispose()
    for (const m of [this.barkMaterial, this.knotMaterial, this.fruitMaterial]) m.dispose()
  }

  // ── where branches are heading ──────────────────────────────────────────────

  /** New targets: the shown world's branches, plus the ones leaving it; each starts from where it's drawn now. */
  private retarget(shape: TreeShape) {
    const { branches } = shape.tree
    const was = new Map(this.entries.map((e, i) => [e.id, i]))
    const next: Entry[] = branches.map(b => ({ id: b.id, depth: b.depth, parent: b.parent }))
    const known = new Set(next.map(e => e.id))
    const leaving = this.entries.flatMap((e, i) => (!known.has(e.id) && this.now[i * POSE + 11] > 0 ? [i] : []))
    const count = next.length + leaving.length
    const from = new Float32Array(count * POSE)
    const to = new Float32Array(count * POSE)

    // radii by the files under each branch then; it narrows to its thickest sub-branch, the trunk flares at the ground
    const radius = branches.map((_, i) => branchRadius(shape.files[i]))
    const thickest = new Float32Array(branches.length)
    for (let i = branches.length - 1; i > 0; i--) if (branches[i].parent >= 0) thickest[branches[i].parent] = Math.max(thickest[branches[i].parent], radius[i])
    branches.forEach((b, i) => {
      const o = i * POSE
      const there = shape.files[i] > 0
      to.set([...b.base, ...b.bend, ...b.tip], o)
      // a branch that's not there keeps its girth while it withers
      const before = was.get(b.id)
      to[o + 9] = there ? radius[i] * (b.parent < 0 ? TRUNK_FLARE : 1) : before !== undefined ? this.now[before * POSE + 9] : 0
      to[o + 10] = there ? Math.min(radius[i], Math.max(thickest[i], radius[i] * 0.55)) : before !== undefined ? this.now[before * POSE + 10] : 0
      to[o + 11] = there ? 1 : 0
      if (before !== undefined) from.set(this.now.subarray(before * POSE, before * POSE + POSE), o)
      else {
        from.set(to.subarray(o, o + POSE), o)
        from[o + 11] = 0
      }
    })
    leaving.forEach((i, n) => {
      const o = (branches.length + n) * POSE
      from.set(this.now.subarray(i * POSE, i * POSE + POSE), o)
      to.set(this.now.subarray(i * POSE, i * POSE + POSE), o)
      to[o + 11] = 0
      next.push({ ...this.entries[i], parent: -1 })
    })

    this.entries = next
    this.branchOf.clear()
    next.forEach((e, i) => this.branchOf.set(e.id, i))
    this.from = from
    this.to = to
    this.now = new Float32Array(from)
    this.fruitIds = shape.fruit
    const segments = Math.max(3, Math.min(8, Math.floor(MAX_SEGMENTS / Math.max(count, 1))))
    if (!this.knots || this.knots.count !== count || segments !== this.segments) {
      this.segments = segments
      this.rebuild(count)
    }
    this.fitFruit()

    // growing and withering go level by level: out from the trunk, back toward it
    let appearing = 0
    let leavingDepth = 0
    for (let i = 0; i < count; i++) {
      if (to[i * POSE + 11] > from[i * POSE + 11]) appearing = Math.max(appearing, next[i].depth)
      if (to[i * POSE + 11] < from[i * POSE + 11]) leavingDepth = Math.max(leavingDepth, next[i].depth)
    }
    this.tween = this.still ? null : { t0: performance.now(), appearing, leaving: leavingDepth }
    if (!this.tween) this.now.set(to)
    this.write()
    this.placeFruit()
  }

  /** Where each branch is at `k` (0–1) of the tween. */
  private pose(k: number) {
    const e = ease(k)
    const t = this.tween!
    for (let i = 0; i < this.entries.length; i++) {
      const o = i * POSE
      for (let j = 0; j < 11; j++) this.now[o + j] = this.from[o + j] + (this.to[o + j] - this.from[o + j]) * e
      const a = this.from[o + 11]
      const b = this.to[o + 11]
      const depth = this.entries[i].depth
      const local = b > a ? stage(e, depth, t.appearing) : b < a ? stage(e, t.leaving - depth, t.leaving) : 1
      this.now[o + 11] = a + (b - a) * local
    }
  }

  // ── drawing ─────────────────────────────────────────────────────────────────

  /** Meshes for `count` branches (withered ones stay, drawn at nothing, until the next change). */
  private rebuild(count: number) {
    for (const m of [this.bark, this.knots]) {
      if (!m) continue
      this.object.remove(m)
      m.dispose()
    }
    this.segment?.dispose()
    this.segment = this.cylinder.clone()
    this.taper = new THREE.InstancedBufferAttribute(new Float32Array(count * this.segments), 1)
    this.segment.setAttribute('taper', this.taper)
    this.bark = new THREE.InstancedMesh(this.segment, this.barkMaterial, count * this.segments)
    this.knots = new THREE.InstancedMesh(this.ball, this.knotMaterial, count)
    for (const m of [this.bark, this.knots]) {
      // always in view (it's the whole tree); the bounds are only for picking
      m.frustumCulled = false
      this.object.add(m)
    }
  }

  private fitFruit() {
    if (!this.fruit || this.fruit.count !== this.fruitIds.length) {
      if (this.fruit) {
        this.object.remove(this.fruit)
        this.fruit.dispose()
      }
      this.fruit = this.fruitIds.length ? new THREE.InstancedMesh(this.ball, this.fruitMaterial, this.fruitIds.length) : null
      if (this.fruit) {
        this.fruit.frustumCulled = false
        this.object.add(this.fruit)
      }
    }
  }

  /** Segment and knot matrices from the current poses. */
  private write() {
    const bark = this.bark!
    const knots = this.knots!
    const S = this.segments
    const taper = this.taper.array as Float32Array
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const zero = new THREE.Matrix4().makeScale(0, 0, 0)
    const p = this.now
    const at = (o: number, t: number, out: THREE.Vector3) => {
      // quadratic Bézier base → bend → tip
      const u = 1 - t
      return out.set(
        u * u * p[o] + 2 * u * t * p[o + 3] + t * t * p[o + 6],
        u * u * p[o + 1] + 2 * u * t * p[o + 4] + t * t * p[o + 7],
        u * u * p[o + 2] + 2 * u * t * p[o + 5] + t * t * p[o + 8],
      )
    }
    for (let i = 0; i < this.entries.length; i++) {
      const o = i * POSE
      const grown = p[o + 11]
      // a young shoot is thin
      const girth = 0.35 + 0.65 * grown
      const radius = (t: number) => (p[o + 9] + (p[o + 10] - p[o + 9]) * t) * girth
      if (grown <= 0.002 || p[o + 9] <= 0) {
        for (let s = 0; s < S; s++) bark.setMatrixAt(i * S + s, zero)
        knots.setMatrixAt(i, zero)
        continue
      }
      for (let s = 0; s < S; s++) {
        const t0 = (s / S) * grown
        const t1 = ((s + 1) / S) * grown
        at(o, t0, a)
        at(o, t1, b)
        dir.subVectors(b, a)
        const length = dir.length()
        if (length < 1e-6) {
          bark.setMatrixAt(i * S + s, zero)
          continue
        }
        dir.divideScalar(length)
        const r = radius(t0)
        // a little overlap hides the seams where segments turn
        const overlap = Math.min(r * 0.3, length * 0.25)
        a.addScaledVector(dir, -overlap)
        q.setFromUnitVectors(up, dir)
        m.compose(a, q, scale.set(r, length + 2 * overlap, r))
        bark.setMatrixAt(i * S + s, m)
        taper[i * S + s] = r > 0 ? radius(t1) / r : 1
      }
      at(o, grown, a)
      const k = radius(1) * 1.12
      knots.setMatrixAt(i, m.compose(a, q.identity(), scale.set(k, k, k)))
    }
    bark.instanceMatrix.needsUpdate = true
    knots.instanceMatrix.needsUpdate = true
    this.taper.needsUpdate = true
    bark.boundingSphere = null
    knots.boundingSphere = null
  }

  /** Fruit under their leaves, as the engine draws them now. */
  private placeFruit() {
    const fruit = this.fruit
    if (!fruit) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const v = new THREE.Vector3()
    const s = new THREE.Vector3()
    this.fruitIds.forEach((id, i) => {
      const box = this.engine.boxOf(id)
      if (!box) return void fruit.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0))
      const r = 0.45 + box.w * 0.2
      fruit.setMatrixAt(i, m.compose(v.set(box.x, box.y - r * 0.75, box.z), q, s.set(r, r * 1.1, r)))
    })
    fruit.instanceMatrix.needsUpdate = true
    fruit.boundingSphere = null
  }

  /**
   * Bark in the scene's colors: darker near the ground, lighter toward the
   * twigs; the selected folder's branches, or the way up to the selected
   * file, in the accent color.
   */
  private recolor(ctx: ViewContext) {
    const bark = this.bark
    const knots = this.knots
    if (!bark || !knots) return
    const base = new THREE.Color(BARK).lerp(new THREE.Color(ctx.theme.district), 0.15)
    const accent = new THREE.Color(ctx.theme.accent)
    const selected = ctx.s.selected
    const lit = new Float32Array(this.entries.length)
    const own = selected ? this.branchOf.get(selected) : undefined
    if (own !== undefined) {
      // the folder and everything under it (parents come first)
      this.entries.forEach((e, i) => {
        if (i === own || (e.parent >= 0 && lit[e.parent] > 0)) lit[i] = 0.55
      })
    } else if (selected) {
      const file = fileIdOf(selected)
      const leaf = file ? this.shape?.tree.leaves.get(file) : undefined
      for (let b = leaf?.branch ?? -1; b >= 0; b = this.entries[b].parent) lit[b] = 0.4
    }
    const c = new THREE.Color()
    for (let i = 0; i < this.entries.length; i++) {
      c.copy(base).offsetHSL(0, 0, Math.min(this.entries[i].depth, 6) * 0.018)
      if (lit[i]) c.lerp(accent, lit[i])
      for (let s = 0; s < this.segments; s++) bark.setColorAt(i * this.segments + s, c)
      knots.setColorAt(i, c)
    }
    if (bark.instanceColor) bark.instanceColor.needsUpdate = true
    if (knots.instanceColor) knots.instanceColor.needsUpdate = true
  }

  /** Whether a leaf or moon, as drawn now, is on the ray nearer than `distance`. */
  private leafBefore(ray: THREE.Ray, distance: number) {
    const center = new THREE.Vector3()
    const toCenter = new THREE.Vector3()
    for (const list of [this.leafIds, this.moonIds])
      for (const id of list) {
        const b = this.engine.boxOf(id)
        if (!b) continue
        const r = b.w / 2
        center.set(b.x, b.y + r, b.z)
        if (toCenter.subVectors(center, ray.origin).dot(ray.direction) - r > distance) continue
        if (ray.distanceSqToPoint(center) <= r * r) return true
      }
    return false
  }
}

/** Branches at `depth` of `deepest` grow during their share of the tween, the trunk first. */
function stage(e: number, depth: number, deepest: number) {
  return Math.min(1, Math.max(0, e * (deepest + 1) - depth))
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Lambert, narrowing each cylinder from its bottom radius to `taper` times that at its top. */
function taperedLambert() {
  const material = new THREE.MeshLambertMaterial()
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float taper;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xz *= mix(1.0, taper, position.y);')
  }
  material.customProgramCacheKey = () => 'archrift-tree-bark'
  return material
}

// the tree behind each layout the view made, for its bark
const shapes = new WeakMap<Layout, TreeShape>()
export const shapeOf = (layout: Layout) => shapes.get(layout)
export const remember = (layout: Layout, shape: TreeShape) => void shapes.set(layout, shape)
