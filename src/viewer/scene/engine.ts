// SceneEngine: the framework-free three.js layer. It draws boxes
// by id (districts, planes, buildings or stars, externals, the floors or
// moons of one opened file), arcs between ids, labels and a minimap; it tweens
// between layouts (switching views is just that), flies the camera, picks,
// and renders only when something changed.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { focusArcStyle } from './arc-style.ts'
import type { Box, Layout, Placement } from '../layouts/types.ts'
import { emptyLayout } from '../layouts/types.ts'
import type { Decoration } from './decoration.ts'
import { LabelLayer } from './labels.ts'
import type { LabelSpec } from './labels.ts'
import { Minimap } from './minimap.ts'

export type HitKind = Placement | 'floor'

export interface Hit {
  id: string
  kind: HitKind
}

export interface ArcSpec {
  source: string
  target: string
  from: THREE.Color
  to: THREE.Color
  /** 1 thin … 3 thick (background arcs: by how many references they carry). */
  width?: 1 | 2 | 3
  /** Containers to route through (edge bundling), source side first. */
  via?: string[]
  /** Points the arc passes through, source side first (a view that routes its own arcs). */
  points?: [number, number, number][]
}

export interface Theme {
  background: string
  ground: string
  district: string
  selection: string
  accent: string
}

const TWEEN_MS = 900
const TRAVEL_MS = 900
const BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
const SPHERE = new THREE.SphereGeometry(0.5, 20, 14).translate(0, 0.5, 0)
/** Drawn kinds, in picking priority. Clusters have boxes but no mesh. */
const DRAWN: HitKind[] = ['floor', 'building', 'external', 'district', 'plane']
/** Kinds drawn in the layout's shape (the rest are always platforms). */
const SHAPED = new Set<HitKind>(['floor', 'building', 'external'])

interface Tween {
  from: Map<string, Box>
  to: Map<string, Box>
  t0: number
  /** Shape to switch to halfway, when the view changes it. */
  shape?: Layout['shape']
}

interface Travel {
  curve: THREE.Curve<THREE.Vector3>
  offFrom: THREE.Vector3
  offTo: THREE.Vector3
  t0: number
}

export class SceneEngine {
  onHover?: (hit: Hit | null, clientX: number, clientY: number) => void
  onPick?: (hit: Hit | null) => void
  /** The camera came to rest: what it looks at, and from how far. */
  onCameraSettled?: (target: THREE.Vector3, distance: number) => void

  readonly renderer: THREE.WebGLRenderer
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  private readonly scene = new THREE.Scene()
  private readonly container: HTMLElement
  private readonly labels: LabelLayer
  private readonly minimap: Minimap
  private readonly ground: THREE.Mesh
  private readonly selectionBox: THREE.LineSegments
  private readonly hoverBox: THREE.LineSegments
  private readonly bgArcs: THREE.LineSegments
  /** Background arcs of width 2 and 3. */
  private readonly bgWide: LineSegments2[]
  private readonly hiArcs: LineSegments2
  private readonly lineMaterials: LineMaterial[] = []

  private layout: Layout = emptyLayout()
  private shape: Layout['shape'] = 'box'
  /** The tallest roof inside each container: bundled arcs pass over it. */
  private skyline = new Map<string, number>()
  /** Boxes as displayed right now (mid-tween included), floors added. */
  private current = new Map<string, Box>()
  private kindOf = new Map<string, HitKind>()
  private meshes = new Map<HitKind, { mesh: THREE.InstancedMesh; ids: string[] }>()
  private colors = new Map<string, THREE.Color>()
  private floors: { building: string; boxes: Map<string, Box> } | null = null
  private decoration: Decoration | null = null
  private bgSpecs: ArcSpec[] = []
  private hiSpecs: ArcSpec[] = []
  private tween: Tween | null = null
  private travel: Travel | null = null
  private selectionId: string | null = null
  private minimapDirty = true
  private raf = 0
  private pickRaf = 0
  private pointer = { x: 0, y: 0, inside: false }
  private downAt = { x: 0, y: 0 }
  private theme: Theme

  constructor(container: HTMLElement, theme: Theme) {
    this.container = container
    this.theme = theme
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    container.appendChild(this.renderer.domElement)
    this.labels = new LabelLayer(container)
    this.minimap = new Minimap(container)
    this.minimap.onPick = (x, z) => this.panTo(x, z)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 10_000)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    // the wheel zooms toward what is under the pointer, not the middle of the screen
    this.controls.zoomToCursor = true
    this.controls.addEventListener('change', () => this.requestRender())
    this.controls.addEventListener('end', () => this.settled())

    this.scene.add(new THREE.HemisphereLight('#e8eeff', '#3a3f4a', 1.7))
    const sun = new THREE.DirectionalLight('#ffffff', 1.3)
    sun.position.set(0.6, 1, 0.35)
    this.scene.add(sun)

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial())
    this.ground.position.y = -0.05
    this.scene.add(this.ground)

    const edges = new THREE.EdgesGeometry(BOX)
    this.selectionBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ transparent: true }))
    this.hoverBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }))
    this.selectionBox.visible = this.hoverBox.visible = false
    this.scene.add(this.selectionBox, this.hoverBox)

    this.bgArcs = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false }),
    )
    const fat = (linewidth: number, opacity = 1) => {
      const m = new LineMaterial({ linewidth, vertexColors: true, transparent: true, opacity, depthWrite: false })
      this.lineMaterials.push(m)
      const line = new LineSegments2(new LineSegmentsGeometry(), m)
      line.visible = false
      return line
    }
    this.bgWide = [fat(2, 0.6), fat(3.8, 0.7)]
    this.hiArcs = fat(2.6)
    this.scene.add(this.bgArcs, ...this.bgWide, this.hiArcs)

    this.applyTheme()
    this.bindPointer()
    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
  }

  // ── world ─────────────────────────────────────────────────────────────────

  setTheme(theme: Theme) {
    this.theme = theme
    this.applyTheme()
    this.minimapDirty = true
    this.requestRender()
  }

  /** A view's own 3D content (null: none); the previous one is disposed of. */
  setDecoration(decoration: Decoration | null) {
    if (this.decoration === decoration) return
    if (this.decoration) {
      this.scene.remove(this.decoration.object)
      this.decoration.dispose()
    }
    this.decoration = decoration
    if (decoration) this.scene.add(decoration.object)
    this.requestRender()
  }

  /** Show a new layout; with `animate`, boxes move from where they are now. */
  setLayout(layout: Layout, animate: boolean) {
    const first = this.layout.boxes.size === 0
    const from = new Map(this.current)
    this.layout = layout
    this.skyline = localSkylines(layout)
    const size = layout.size
    this.ground.visible = layout.ground
    this.ground.scale.set(size * 4, 1, size * 4)
    this.scene.fog = new THREE.Fog(this.theme.background, size * 1.6, size * 5)
    this.camera.far = size * 12
    this.camera.updateProjectionMatrix()
    this.controls.maxDistance = size * 4
    this.controls.maxPolarAngle = layout.ground ? Math.PI * 0.49 : Math.PI
    if (first) this.home(false)
    const to = this.targetBoxes()
    if (animate && !first) {
      this.tween = { from, to, t0: performance.now(), shape: layout.shape !== this.shape ? layout.shape : undefined }
      this.rebuildMeshes(new Set([...from.keys(), ...to.keys()]))
    } else {
      this.tween = null
      this.shape = layout.shape
      this.current = to
      this.rebuildMeshes(new Set(to.keys()))
    }
    this.rebuildArcs()
    this.minimapDirty = true
    this.requestRender()
  }

  /** Open one file into its floors (or moons), or close it with null. */
  setFloors(building: string | null, floors: { building: Box; floors: { id: string; box: Box }[] } | null) {
    this.floors = building && floors ? { building, boxes: new Map([[building, floors.building], ...floors.floors.map(f => [f.id, f.box] as const)]) } : null
    const to = this.targetBoxes()
    this.tween = { from: new Map(this.current), to, t0: performance.now(), shape: this.tween?.shape }
    this.rebuildMeshes(new Set([...this.current.keys(), ...to.keys()]))
    this.requestRender()
  }

  setColors(colors: Map<string, THREE.Color>) {
    this.colors = colors
    for (const { mesh, ids } of this.meshes.values()) {
      ids.forEach((id, i) => mesh.setColorAt(i, this.colorOf(id)))
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    this.minimapDirty = true
    this.requestRender()
  }

  setArcs(background: ArcSpec[], highlight: ArcSpec[]) {
    this.bgSpecs = background
    this.hiSpecs = highlight
    this.rebuildArcs()
    this.requestRender()
  }

  setSelection(id: string | null) {
    this.selectionId = id
    this.fitWire(this.selectionBox, id ? this.current.get(id) : undefined)
    this.requestRender()
  }

  setHovered(id: string | null) {
    this.fitWire(this.hoverBox, id && id !== this.selectionId ? this.current.get(id) : undefined)
    this.requestRender()
  }

  setLabels(specs: LabelSpec[]) {
    this.labels.setSpecs(specs)
    this.requestRender()
  }

  /** True while a layout tween or a camera trip is running. */
  busy() {
    return !!this.tween || !!this.travel
  }

  /** What is drawn, for tests and debugging. */
  stats() {
    return {
      view: this.layout.view,
      shape: this.shape,
      arcs: this.bgSpecs.length,
      highlighted: this.hiSpecs.length,
      highlightWidth: (this.hiArcs.material as LineMaterial).linewidth,
      objects: Object.fromEntries([...this.meshes].map(([k, m]) => [k, m.ids.length])),
      decoration: this.decoration ? (this.decoration.stats?.() ?? {}) : null,
    }
  }

  boxOf(id: string): Box | undefined {
    return this.current.get(id)
  }

  kind(id: string): HitKind | undefined {
    return this.kindOf.get(id)
  }

  /** Where a node is on screen (client coordinates), or null when hidden. */
  screenPosition(id: string): { x: number; y: number } | null {
    const b = this.current.get(id)
    if (!b) return null
    const v = this.pointOn(id, b).project(this.camera)
    if (v.z > 1) return null
    const r = this.renderer.domElement.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }

  /** A clickable point of a node: a roof, a floor's front wall, a star's center. */
  private pointOn(id: string, b: Box) {
    const kind = this.kindOf.get(id)
    if (this.layout.shape === 'sphere' && kind !== 'district' && kind !== 'plane') return new THREE.Vector3(b.x, b.y + b.h / 2, b.z)
    if (kind === 'floor') return new THREE.Vector3(b.x, b.y + b.h / 2, b.z + b.d / 2)
    return new THREE.Vector3(b.x, b.y + b.h, b.z)
  }

  // ── camera ────────────────────────────────────────────────────────────────

  home(animate = true) {
    const s = this.layout.size
    const target = new THREE.Vector3(...this.layout.center)
    const offset = new THREE.Vector3(...this.layout.home).multiplyScalar(s)
    if (!animate) {
      this.controls.target.copy(target)
      this.camera.position.copy(target).add(offset)
      this.controls.update()
      return
    }
    this.travel = { curve: new THREE.LineCurve3(this.controls.target.clone(), target), offFrom: this.offset(), offTo: offset, t0: performance.now() }
    this.requestRender()
  }

  /** Move the camera to a saved position and focus point. */
  moveCamera(position: [number, number, number], target: [number, number, number]) {
    const to = new THREE.Vector3(...target)
    this.travel = {
      curve: new THREE.LineCurve3(this.controls.target.clone(), to),
      offFrom: this.offset(),
      offTo: new THREE.Vector3(...position).sub(to),
      t0: performance.now(),
    }
    this.requestRender()
  }

  /** Put the camera exactly here, looking at `target` (a scripted tour): a trip under way stops. */
  place(position: [number, number, number], target: [number, number, number]) {
    this.travel = null
    this.controls.target.set(...target)
    this.camera.position.set(...position)
    this.controls.update()
    this.requestRender()
  }

  /** Where the camera rests after a view switch: the layout's middle, and the offset to it. */
  homeView(): { size: number; center: [number, number, number]; offset: [number, number, number] } {
    const s = this.layout.size
    const [x, y, z] = this.layout.home
    return { size: s, center: [...this.layout.center], offset: [x * s, y * s, z * s] }
  }

  cameraState(): { position: [number, number, number]; target: [number, number, number] } {
    const r = (v: THREE.Vector3) => [v.x, v.y, v.z].map(x => Math.round(x * 100) / 100) as [number, number, number]
    return { position: r(this.camera.position), target: r(this.controls.target) }
  }

  /**
   * Fly to a node; with `alongFrom`, ride the arc from that node to it. With
   * `fromHome`, look at it from the layout's home direction (after a view switch).
   */
  flyTo(id: string, alongFrom?: string, fromHome = false) {
    const b = this.targetBoxes().get(id) ?? this.current.get(id)
    if (!b) return
    if (this.layout.keepView) return fromHome || !this.inView(b) ? this.home() : undefined
    const kind = this.kindOf.get(id)
    const s = this.layout.size
    const platform = kind === 'district' || kind === 'plane'
    const dest = platform
      ? new THREE.Vector3(b.x, b.y + b.h, b.z)
      : kind === 'cluster' || kind === 'floor' || this.layout.shape === 'sphere'
        ? new THREE.Vector3(b.x, b.y + b.h / 2, b.z)
        : new THREE.Vector3(b.x, b.y + b.h * 0.55, b.z)
    // close enough to read it, far enough to see where its arcs go
    const context = this.layout.shape === 'sphere' ? s * 0.35 : s * 0.24
    const extent = platform || kind === 'cluster' ? Math.max(b.w, b.d, b.h) * 1.2 : Math.max(Math.max(b.w, b.d, b.h) * 6, context)
    const distance = THREE.MathUtils.clamp(extent, 60, s * 1.6)
    const from = alongFrom ? this.current.get(alongFrom) : undefined
    const start = from ? this.pointOn(alongFrom!, from) : this.controls.target.clone()
    const curve = from ? this.arcCurve(start, dest) : new THREE.LineCurve3(start, dest)
    const direction = fromHome ? new THREE.Vector3(...this.layout.home) : this.offset()
    this.travel = { curve, offFrom: this.offset(), offTo: direction.setLength(distance), t0: performance.now() }
    this.requestRender()
  }

  /**
   * Fly to where all of `ids` are in view (a rule violation's path), keeping the
   * view direction; `coveredRight` px on the right are behind a panel.
   */
  frameAll(ids: string[], coveredRight = 0) {
    const boxes = ids.map(id => this.targetBoxes().get(id) ?? this.current.get(id)).filter(b => b !== undefined)
    if (boxes.length < 2) return boxes.length ? this.flyTo(ids.find(id => this.targetBoxes().has(id) || this.current.has(id))!) : undefined
    const min = new THREE.Vector3(Infinity, Infinity, Infinity)
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    for (const b of boxes) {
      min.min(new THREE.Vector3(b.x - b.w / 2, b.y, b.z - b.d / 2))
      max.max(new THREE.Vector3(b.x + b.w / 2, b.y + b.h, b.z + b.d / 2))
    }
    const width = this.renderer.domElement.clientWidth || 1
    const visible = Math.max(0.3, 1 - coveredRight / width)
    const distance = THREE.MathUtils.clamp((max.distanceTo(min) * 1.1) / visible, 60, this.layout.size * 1.6)
    // centre the boxes in the part of the screen that isn't covered: look a little right of them
    const halfWidth = distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize()
    const dest = min.clone().add(max).multiplyScalar(0.5).addScaledVector(right, halfWidth * (1 - visible))
    this.travel = { curve: new THREE.LineCurve3(this.controls.target.clone(), dest), offFrom: this.offset(), offTo: this.offset().setLength(distance), t0: performance.now() }
    this.requestRender()
  }

  /** Move the camera's focus over a ground point, keeping the view direction. */
  panTo(x: number, z: number) {
    const dest = new THREE.Vector3(x, this.controls.target.y, z)
    this.travel = { curve: new THREE.LineCurve3(this.controls.target.clone(), dest), offFrom: this.offset(), offTo: this.offset(), t0: performance.now() }
    this.requestRender()
  }

  private offset() {
    return this.camera.position.clone().sub(this.controls.target)
  }

  /** A box's center is on screen, clear of the edges. */
  private inView(b: Box) {
    const v = new THREE.Vector3(b.x, b.y + b.h / 2, b.z).project(this.camera)
    return v.z < 1 && Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9
  }

  private settled() {
    this.onCameraSettled?.(this.controls.target.clone(), this.offset().length())
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  requestRender() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  private readonly frame = (now: number) => {
    this.raf = 0
    let active = false
    if (this.tween) {
      this.stepTween(now)
      active = true
    }
    if (this.travel) {
      const k = Math.min(1, (now - this.travel.t0) / TRAVEL_MS)
      const e = ease(k)
      const p = this.travel.curve.getPoint(e)
      this.controls.target.copy(p)
      this.camera.position.copy(p).add(this.travel.offFrom.clone().lerp(this.travel.offTo, e))
      if (k === 1) {
        this.travel = null
        this.settled()
      }
      active = true
    }
    if (this.controls.update()) active = true
    if (this.decoration?.animate?.(now)) active = true
    this.renderer.render(this.scene, this.camera)
    const { clientWidth: w, clientHeight: h } = this.container
    this.labels.update(this.camera, w, h, id => this.anchor(id))
    if (this.minimapDirty && !this.tween) {
      this.minimap.drawBase(this.current, this.kindOf, id => this.colorOf(id), this.layout.size, this.layout.center, this.theme.background)
      this.minimapDirty = false
    }
    this.minimap.drawView(this.camera, this.controls.target, this.theme.accent)
    if (active) this.requestRender()
  }

  private stepTween(now: number) {
    const t = this.tween!
    const k = Math.min(1, (now - t.t0) / TWEEN_MS)
    const e = ease(k)
    if (t.shape && k >= 0.5 && this.shape !== t.shape) {
      this.shape = t.shape
      for (const [kind, { mesh }] of this.meshes) if (SHAPED.has(kind)) mesh.geometry = this.geometryFor(kind)
    }
    const next = new Map<string, Box>()
    for (const id of new Set([...t.from.keys(), ...t.to.keys()])) {
      const a = t.from.get(id) ?? collapsed(t.to.get(id)!)
      const b = t.to.get(id) ?? collapsed(t.from.get(id)!)
      next.set(id, lerpBox(a, b, e))
    }
    this.current = next
    this.writeMatrices()
    if (k === 1) {
      this.tween = null
      this.shape = this.layout.shape
      this.current = t.to
      this.rebuildMeshes(new Set(t.to.keys()))
      this.rebuildArcs()
      this.minimapDirty = true
    }
    this.fitWire(this.selectionBox, this.selectionId ? this.current.get(this.selectionId) : undefined)
  }

  /** The boxes the scene is heading to: the layout, with the open file's floors. */
  private targetBoxes() {
    const boxes = new Map(this.layout.boxes)
    this.kindOf = new Map(this.layout.placement)
    if (this.floors && boxes.has(this.floors.building)) {
      for (const [id, b] of this.floors.boxes) {
        boxes.set(id, b)
        if (id !== this.floors.building) this.kindOf.set(id, 'floor')
      }
    }
    return boxes
  }

  private geometryFor(kind: HitKind) {
    return SHAPED.has(kind) && this.shape === 'sphere' ? SPHERE : BOX
  }

  private rebuildMeshes(ids: Set<string>) {
    for (const { mesh } of this.meshes.values()) {
      this.scene.remove(mesh)
      mesh.dispose()
    }
    this.meshes.clear()
    const byKind = new Map<HitKind, string[]>(DRAWN.map(k => [k, []]))
    for (const id of ids) {
      const k = this.kindOf.get(id)
      if (k) byKind.get(k)?.push(id)
    }
    for (const [kind, list] of byKind) {
      if (!list.length) continue
      const material =
        kind === 'plane'
          ? new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.32, depthWrite: false })
          : new THREE.MeshLambertMaterial()
      const mesh = new THREE.InstancedMesh(this.geometryFor(kind), material, list.length)
      mesh.userData.kind = kind
      // still picked (the raycaster ignores visibility), just not drawn
      if (this.layout.hideBoxes && kind !== 'floor') mesh.visible = false
      if (kind === 'plane') mesh.renderOrder = -1
      list.forEach((id, i) => mesh.setColorAt(i, this.colorOf(id)))
      this.meshes.set(kind, { mesh, ids: list })
      this.scene.add(mesh)
    }
    this.writeMatrices()
  }

  private writeMatrices() {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    const open = this.floors?.building
    for (const { mesh, ids } of this.meshes.values()) {
      ids.forEach((id, i) => {
        const b = this.current.get(id)
        // the open file is drawn as its floors (in the galaxy its star stays, ringed by moons)
        const hidden = id === open && this.kindOf.get(id) === 'building' && this.layout.shape === 'box'
        if (!b || hidden) m.makeScale(0, 0, 0)
        else m.compose(p.set(b.x, b.y, b.z), q, s.set(Math.max(b.w, 0.01), Math.max(b.h, 0.01), Math.max(b.d, 0.01)))
        mesh.setMatrixAt(i, m)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.computeBoundingBox()
    }
  }

  private rebuildArcs() {
    const thin = this.bgSpecs.filter(a => (a.width ?? 1) === 1)
    const bg = this.arcPositions(thin, thin.length > 20_000 ? 8 : 12)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(bg.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(bg.colors, 3))
    this.bgArcs.geometry.dispose()
    this.bgArcs.geometry = g
    ;(this.bgArcs.material as THREE.LineBasicMaterial).opacity = thin.length > 5_000 ? 0.14 : 0.3
    this.bgArcs.visible = thin.length > 0 && !this.tween
    this.fillFat(this.bgWide[0], this.bgSpecs.filter(a => a.width === 2), 16)
    this.fillFat(this.bgWide[1], this.bgSpecs.filter(a => a.width === 3), 16)
    this.fillFat(this.hiArcs, this.hiSpecs, 24)
    // a busy selection's arcs thinner and lighter, a few bold
    const style = focusArcStyle(this.hiSpecs.length)
    const m = this.hiArcs.material as LineMaterial
    m.linewidth = style.width
    m.opacity = style.opacity
  }

  private fillFat(line: LineSegments2, specs: ArcSpec[], segs: number) {
    const p = this.arcPositions(specs, segs)
    const geometry = new LineSegmentsGeometry()
    if (p.positions.length) {
      geometry.setPositions(p.positions)
      geometry.setColors(p.colors)
    }
    line.geometry.dispose()
    line.geometry = geometry
    line.visible = p.positions.length > 0 && !this.tween
  }

  private arcPositions(specs: ArcSpec[], baseSegs: number) {
    // bundled arcs bend at every container: sample them more finely
    const segsOf = (spec: ArcSpec) => {
      const bends = spec.points?.length ?? spec.via?.length ?? 0
      return bends ? Math.max(baseSegs, 8 * (bends + 1)) : baseSegs
    }
    const total = specs.reduce((n, spec) => n + segsOf(spec), 0)
    const positions = new Float32Array(total * 6)
    const colors = new Float32Array(total * 6)
    const p = new THREE.Vector3()
    const c = new THREE.Color()
    let o = 0
    for (const spec of specs) {
      const a = this.endpoint(spec.source, spec.target)
      const b = this.endpoint(spec.target, spec.source)
      if (!a || !b) continue
      const curve = spec.points?.length
        ? new THREE.CatmullRomCurve3([a, ...spec.points.map(q => new THREE.Vector3(...q)), b], false, 'centripetal')
        : spec.via?.length
          ? this.bundledCurve(a, b, spec.via)
          : this.arcCurve(a, b)
      const segs = segsOf(spec)
      for (let k = 0; k < segs; k++) {
        for (const t of [k / segs, (k + 1) / segs]) {
          curve.getPoint(t, p)
          c.copy(spec.from).lerp(spec.to, t)
          positions[o] = p.x
          positions[o + 1] = p.y
          positions[o + 2] = p.z
          colors[o] = c.r
          colors[o + 1] = c.g
          colors[o + 2] = c.b
          o += 3
        }
      }
    }
    return { positions: positions.subarray(0, o), colors: colors.subarray(0, o) }
  }

  /** Where an arc leaves a node: a roof, a floor's wall facing the other end, or a star's center. */
  private endpoint(id: string, other: string): THREE.Vector3 | undefined {
    const b = this.current.get(id)
    if (!b) return undefined
    if (this.layout.arcAnchor === 'center') return new THREE.Vector3(b.x, b.y + b.h / 2, b.z)
    if (this.kindOf.get(id) !== 'floor') return new THREE.Vector3(b.x, b.y + b.h, b.z)
    const o = this.current.get(other)
    const dir = new THREE.Vector2(o ? o.x - b.x : 0, o ? o.z - b.z : 1)
    if (dir.lengthSq() === 0) dir.set(0, 1)
    dir.normalize().multiplyScalar(Math.max(b.w, b.d) / 2)
    return new THREE.Vector3(b.x + dir.x, b.y + b.h / 2, b.z + dir.y)
  }

  /**
   * Hierarchical edge bundling (Holten): the arc passes over the containers
   * between its ends (higher for bigger ones), pulled 20% toward the straight
   * line, so arcs between the same parts of the tree run together.
   */
  private bundledCurve(a: THREE.Vector3, b: THREE.Vector3, via: string[]) {
    const points = [a]
    for (const id of via) {
      const box = this.current.get(id)
      if (!box) continue
      const depth = this.layout.depth.get(id) ?? 0
      // over the city, higher for bigger containers
      points.push(
        this.layout.arcAnchor === 'center'
          ? new THREE.Vector3(box.x, box.y + box.h / 2, box.z)
          : new THREE.Vector3(box.x, (this.skyline.get(id) ?? box.y + box.h) + this.layout.size * (0.01 + 0.05 / (depth + 1)), box.z),
      )
    }
    points.push(b)
    if (points.length === 2) return this.arcCurve(a, b)
    const last = points.length - 1
    for (let i = 1; i < last; i++) points[i].multiplyScalar(0.8).addScaledVector(a.clone().lerp(b, i / last), 0.2)
    return new THREE.CatmullRomCurve3(points, false, 'centripetal')
  }

  /** Arcs rise over a city; in space they only bow a little. */
  private arcCurve(a: THREE.Vector3, b: THREE.Vector3) {
    const mid = a.clone().add(b).multiplyScalar(0.5)
    const center = this.layout.arcAnchor === 'center'
    const lift = center ? a.distanceTo(b) * 0.12 + 2 : a.distanceTo(b) * 0.35 + 6
    mid.y = (center ? mid.y : Math.max(a.y, b.y)) + lift
    return new THREE.QuadraticBezierCurve3(a, mid, b)
  }

  private anchor(id: string) {
    const b = this.current.get(id)
    if (!b) return undefined
    switch (this.kindOf.get(id)) {
      case 'district':
        return { point: new THREE.Vector3(b.x, b.y + b.h + 1, b.z - b.d / 2 + 3), width: b.w }
      case 'plane':
        return { point: new THREE.Vector3(b.x - b.w / 2 + 4, b.y + b.h, b.z + b.d / 2 - 2) }
      case 'cluster':
        return { point: new THREE.Vector3(b.x, b.y + b.h / 2, b.z), width: Math.max(b.w, b.d) }
      case 'floor':
        return this.layout.shape === 'sphere'
          ? { point: new THREE.Vector3(b.x, b.y + b.h + 0.5, b.z) }
          : { point: new THREE.Vector3(b.x + b.w / 2, b.y + b.h / 2, b.z + b.d / 2) }
      default:
        return { point: new THREE.Vector3(b.x, b.y + b.h + 1.5, b.z) }
    }
  }

  private colorOf(id: string) {
    const kind = this.kindOf.get(id)
    return this.colors.get(id) ?? new THREE.Color(kind === 'district' || kind === 'plane' ? this.theme.district : '#8b95a5')
  }

  private fitWire(wire: THREE.LineSegments, box: Box | undefined) {
    wire.visible = !!box
    if (!box) return
    const pad = Math.max(0.4, Math.min(box.w, box.d) * 0.04)
    wire.position.set(box.x, box.y - pad / 2, box.z)
    wire.scale.set(box.w + pad * 2, box.h + pad, box.d + pad * 2)
  }

  private applyTheme() {
    this.scene.background = new THREE.Color(this.theme.background)
    ;(this.ground.material as THREE.MeshLambertMaterial).color.set(this.theme.ground)
    ;(this.selectionBox.material as THREE.LineBasicMaterial).color.set(this.theme.selection)
    ;(this.hoverBox.material as THREE.LineBasicMaterial).color.set(this.theme.selection)
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.set(this.theme.background)
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    for (const m of this.lineMaterials) m.resolution.set(w, h)
    this.requestRender()
  }

  // ── picking ───────────────────────────────────────────────────────────────

  private readonly raycaster = new THREE.Raycaster()

  pickAt(clientX: number, clientY: number): Hit | null {
    const r = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    // a view's own content first: it may stand in for its nodes
    const own = this.decoration?.pick?.(this.raycaster)
    if (own !== undefined) return own
    const objects = DRAWN.map(k => this.meshes.get(k)?.mesh).filter((m): m is THREE.InstancedMesh => !!m)
    for (const hit of this.raycaster.intersectObjects(objects, false)) {
      const kind = hit.object.userData.kind as HitKind
      const entry = this.meshes.get(kind)
      if (!entry || hit.instanceId === undefined) continue
      const id = entry.ids[hit.instanceId]
      if (id === this.floors?.building && kind === 'building' && this.layout.shape === 'box') continue
      return { id, kind }
    }
    return null
  }

  private bindPointer() {
    const el = this.renderer.domElement
    el.addEventListener('pointermove', e => {
      this.pointer = { x: e.clientX, y: e.clientY, inside: true }
      if (this.pickRaf) return
      this.pickRaf = requestAnimationFrame(() => {
        this.pickRaf = 0
        if (this.pointer.inside) this.onHover?.(this.pickAt(this.pointer.x, this.pointer.y), this.pointer.x, this.pointer.y)
      })
    })
    el.addEventListener('pointerleave', () => {
      this.pointer.inside = false
      this.onHover?.(null, 0, 0)
    })
    el.addEventListener('pointerdown', e => (this.downAt = { x: e.clientX, y: e.clientY }))
    el.addEventListener('click', e => {
      if (Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 4) return // a drag
      this.onPick?.(this.pickAt(e.clientX, e.clientY))
    })
  }
}

/** For each district, the height of the tallest building standing inside its footprint. */
function localSkylines(layout: Layout): Map<string, number> {
  const tops = new Map<string, number>()
  const buildings = [...layout.boxes].filter(([id]) => layout.placement.get(id) === 'building').map(([, b]) => b)
  for (const [id, d] of layout.boxes) {
    const p = layout.placement.get(id)
    if (p !== 'district' && p !== 'plane') continue
    let top = d.y + d.h
    for (const b of buildings)
      if (Math.abs(b.x - d.x) <= d.w / 2 && Math.abs(b.z - d.z) <= d.d / 2 && b.y >= d.y) top = Math.max(top, b.y + b.h)
    tops.set(id, top)
  }
  return tops
}

const collapsed = (b: Box): Box => ({ ...b, h: 0.01, w: b.w * 0.6, d: b.d * 0.6 })
const lerpBox = (a: Box, b: Box, t: number): Box => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
  d: a.d + (b.d - a.d) * t,
})
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
