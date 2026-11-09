// Wheel layout (radial hierarchical edge bundling, Holten 2006). Files sit on
// a ring, one contiguous angular sector per folder (or per group), in path
// order, each a tick outward. The folders above them are nested bands inside
// the ring, top level innermost, which leaves the middle open. An arc leaves
// its file's tick, runs in through the control points of the folders above it
// (a folder's sits on its sector's middle, at a radius by its depth) to the
// ends' lowest common ancestor and back out, pulled toward the straight line
// by 1 − β, and is smoothed as a cubic B-spline. Past MAX_MARKS the deepest
// folders fold into one tick each. Pure math: no three.js, no DOM.
import type { GraphNode } from '../../../core/model.ts'
import { childrenOf, cmp } from '../../layouts/city.ts'
import type { Box, Layout, Placement } from '../../layouts/types.ts'
import { emptyLayout } from '../../layouts/types.ts'

export type Point = [number, number, number]

/** Holten's bundling strength: 1 follows the tree, 0 draws straight lines. */
export const BETA = 0.85
/** Most ticks on the ring before folders fold into one tick each. */
export const MAX_MARKS = 1500
/** The ring's radius, where ticks start and arcs leave (everything else scales with it). */
export const RADIUS = 50
/** Arcs run in this plane; bands and ticks lie flat just above it, so the bands cover the arcs' first stretch. */
export const ARC_Y = 0.1
export const FLAT_Y = 0.3
const TICK_MIN = 0.014 * RADIUS
const TICK_MAX = 0.085 * RADIUS
/** Where the bands end, just inside the ring. */
const BANDS_OUT = 0.975 * RADIUS
/** Layout size: generous, so flying to a file still shows much of the wheel. */
const SIZE = 5.5 * RADIUS
/** Home camera: a little over 3 radii away, tilted 20° from straight down. */
const HOME_DISTANCE = 3.15 * RADIUS
const HOME: [number, number, number] = [0, (Math.cos(0.35) * HOME_DISTANCE) / SIZE, (Math.sin(0.35) * HOME_DISTANCE) / SIZE]
/** World units per screen pixel at the home view (50° field of view, ~840 px tall): to keep labels off the ring. */
const HOME_WPP = (2 * HOME_DISTANCE * Math.tan((25 * Math.PI) / 180)) / 840
const LABEL_PREFIX = 'wheel-label:'

export interface WheelInput {
  nodes: readonly GraphNode[]
  rootId: string
  /** Files and externals to place; folders appear when they hold a placed file. */
  isVisible: (n: GraphNode) => boolean
  /** Sectors by these groups (the toolbar's grouping) instead of folders. */
  groups?: readonly { id: string; label: string }[]
  groupOf?: (fileId: string) => string | undefined
  /** Most ticks before folders fold (default MAX_MARKS). */
  maxMarks?: number
}

/** A folder's (or group's) band. */
export interface Sector {
  id: string
  name: string
  /** 1 = top level (innermost band). */
  depth: number
  /** Angles in radians, clockwise from the top (−z) seen from above. */
  start: number
  end: number
  inner: number
  outer: number
}

/** A tick on the ring: a file, a package, or a folder folded into one. */
export interface Mark {
  id: string
  start: number
  end: number
  angle: number
  /** Outward from the ring: grows with lines per file. */
  length: number
  /** Files it stands for (all those under a folded folder). */
  files: number
  folded: boolean
}

export interface WheelLabel {
  /** The label's own box (placed off the ring). */
  id: string
  sector: string
  text: string
  /** 0: the first level that splits, 1: the one below it. */
  level: 0 | 1
  group: boolean
}

export interface Wheel {
  layout: Layout
  radius: number
  /** The open middle's radius (the innermost band's inner edge). */
  hub: number
  /** Band levels. */
  levels: number
  sectors: Sector[]
  /** In angular order. */
  marks: Mark[]
  /** Box id → the tick standing for it: itself, or the folded folder holding it. */
  markOf: Map<string, string>
  /** Tree parent of every tick, band and hidden node (the root has none). */
  parent: Map<string, string>
  /** Where arcs through a folder, group or the root bend, as [x, z]. */
  control: Map<string, [number, number]>
  /** Angle of every tick and band. */
  angle: Map<string, number>
  labels: WheelLabel[]
  /** Folders folded into one tick (0: every file has its own). */
  folded: number
}

interface TreeNode {
  id: string
  name: string
  kind: 'folder' | 'file' | 'external'
  depth: number
  parent: TreeNode | null
  children: TreeNode[]
  /** Visible files at or under it. */
  files: number
  loc: number
}

const TAU = Math.PI * 2

export function wheelLayout(input: WheelInput): Wheel {
  const root = input.groups ? groupTree(input) : folderTree(input)
  const maxMarks = input.maxMarks ?? MAX_MARKS

  // how deep to go: every file its own tick, or folders at depth `cut` folded into one
  const leavesAt: number[] = []
  const foldersAt: number[] = []
  let maxDepth = 0
  walk(root, t => {
    if (t.kind !== 'folder') {
      leavesAt[t.depth] = (leavesAt[t.depth] ?? 0) + 1
      maxDepth = Math.max(maxDepth, t.depth)
    } else if (t.parent) foldersAt[t.depth] = (foldersAt[t.depth] ?? 0) + 1
  })
  const total = leavesAt.reduce((a, b) => a + (b ?? 0), 0)
  let cut = Infinity
  if (total > maxMarks) {
    cut = 1
    for (let k = maxDepth - 1; k >= 1; k--) {
      let marks = foldersAt[k] ?? 0
      for (let d = 0; d <= k; d++) marks += leavesAt[d] ?? 0
      if (marks <= maxMarks) {
        cut = k
        break
      }
    }
  }

  // the ticks, in path order; what a folded folder hides maps to it
  const leaves: TreeNode[] = []
  const markOf = new Map<string, string>()
  const parent = new Map<string, string>()
  let folded = 0
  const collect = (t: TreeNode) => {
    if (t.parent) parent.set(t.id, t.parent.id)
    if (t.kind !== 'folder' || t.depth === cut) {
      leaves.push(t)
      markOf.set(t.id, t.id)
      if (t.kind === 'folder') {
        folded++
        walk(t, h => {
          if (h === t) return
          markOf.set(h.id, t.id)
          parent.set(h.id, h.parent!.id)
        })
      }
      return
    }
    t.children.forEach(collect)
  }
  collect(root)

  // angles: one unit per file, gaps between sectors (wider where the tree splits higher up)
  const branch = new Map<TreeNode, number>([[root, 0]])
  walk(root, t => {
    for (const c of t.children) branch.set(c, branch.get(t)! + (t.children.length > 1 ? 1 : 0))
  })
  const units = leaves.map(t => Math.max(1, t.files))
  const unitTotal = units.reduce((a, b) => a + b, 0)
  const bigGap = Math.max(0.6, unitTotal * 0.005)
  const gaps = leaves.map((t, i) => {
    const next = leaves[(i + 1) % leaves.length]
    if (leaves.length < 2 || (t.parent === next.parent && i < leaves.length - 1)) return 0
    return Math.max(bigGap * Math.pow(0.5, branch.get(lca(t, next))!), unitTotal * 0.0006)
  })
  const per = TAU / (unitTotal + gaps.reduce((a, b) => a + b, 0))
  const marks: Mark[] = []
  const angle = new Map<string, number>()
  let theta = ((gaps.at(-1) ?? 0) / 2) * per
  const range = new Map<TreeNode, [number, number]>()
  leaves.forEach((t, i) => {
    const start = theta
    theta += units[i] * per
    marks.push({ id: t.id, start, end: theta, angle: (start + theta) / 2, length: 0, files: t.files, folded: t.kind === 'folder' })
    angle.set(t.id, (start + theta) / 2)
    range.set(t, [start, theta])
    for (let p = t.parent; p; p = p.parent) {
      const r = range.get(p)
      if (r) r[1] = theta
      else range.set(p, [start, theta])
    }
    if (i < leaves.length - 1) theta += gaps[i] * per
  })

  // ticks: longer for more lines per file (by the 90th percentile, so a few giants don't flatten the rest)
  const perFile = leaves.map(t => (t.files ? t.loc / t.files : 0))
  const sorted = perFile.filter(v => v > 0).sort((a, b) => a - b)
  const reference = sorted[Math.floor(sorted.length * 0.9)] ?? 1
  marks.forEach((m, i) => (m.length = TICK_MIN + (TICK_MAX - TICK_MIN) * Math.min(1, Math.sqrt(perFile[i] / reference))))

  // bands: one per level of the folders shown, deepest next to the ring
  const bandNodes: TreeNode[] = []
  walk(root, t => {
    if (t.kind === 'folder' && t.parent && t.depth <= cut && range.has(t)) bandNodes.push(t)
  })
  const levels = bandNodes.reduce((a, t) => Math.max(a, t.depth), 0)
  const thickness = levels ? Math.min(0.03 * RADIUS, (0.24 * RADIUS) / levels) : 0
  const spacing = thickness * 0.22
  const outerOf = (depth: number) => BANDS_OUT - (levels - depth) * (thickness + spacing)
  const hub = levels ? outerOf(1) - thickness : BANDS_OUT
  const sectors: Sector[] = bandNodes.map(t => {
    const [start, end] = range.get(t)!
    return { id: t.id, name: t.name, depth: t.depth, start, end, inner: outerOf(t.depth) - thickness, outer: outerOf(t.depth) }
  })
  sectors.sort((a, b) => a.depth - b.depth || a.start - b.start)
  for (const s of sectors) angle.set(s.id, (s.start + s.end) / 2)

  // control points: the root in the middle, a folder on its sector's middle at a radius by its height above
  // the ticks (a folder of files just inside the bands, as in a dendrogram), pulled in by how much of the
  // circle it spans (to the centroid of its arc, so one spanning everything sits in the middle)
  const height = new Map<TreeNode, number>()
  const heightOf = (t: TreeNode): number => {
    const h = t.kind !== 'folder' || t.depth === cut ? 0 : 1 + Math.max(0, ...t.children.map(heightOf))
    height.set(t, h)
    return h
  }
  const tallest = Math.max(1, heightOf(root))
  const control = new Map<string, [number, number]>([[root.id, [0, 0]]])
  for (const t of bandNodes) {
    const [start, end] = range.get(t)!
    const span = end - start
    const r = hub * (1 - height.get(t)! / tallest) * (span > 1e-9 ? Math.sin(span / 2) / (span / 2) : 1)
    control.set(t.id, polar(r, (start + end) / 2))
  }

  // boxes: ticks on the ring, bands' boxes on their band, what a folded folder hides at its tick
  const layout: Layout = {
    ...emptyLayout(),
    view: 'wheel',
    size: SIZE,
    shape: 'sphere',
    arcAnchor: 'center',
    ground: false,
    home: HOME,
    // a touch low on screen: the toolbar covers the top
    center: [0, 0, -0.03 * RADIUS],
    hideBoxes: true,
    openFile: 'none',
    keepView: true,
    names: new Map(),
  }
  const place = (id: string, r: number, a: number, size: number, placement: Placement) => {
    const [x, z] = polar(r, a)
    const box: Box = { x, y: ARC_Y - size / 2, z, w: size, h: size, d: size }
    layout.boxes.set(id, box)
    layout.placement.set(id, placement)
  }
  const byId = new Map<string, TreeNode>()
  walk(root, t => byId.set(t.id, t))
  for (const m of marks) {
    const t = byId.get(m.id)!
    const size = Math.min(Math.max(RADIUS * (m.end - m.start) * 0.8, 0.08), 0.03 * RADIUS)
    place(m.id, RADIUS, m.angle, size, t.kind === 'external' ? 'external' : 'building')
    if (m.folded)
      walk(t, h => {
        if (h !== t) place(h.id, RADIUS, m.angle, 0.01, h.kind === 'folder' ? 'cluster' : 'building')
      })
  }
  for (const s of sectors) if (!markOf.has(s.id)) place(s.id, (s.inner + s.outer) / 2, (s.start + s.end) / 2, thickness * 0.8, 'cluster')
  place(root.id, 0, 0, 0.5, 'cluster')
  if (input.groups) for (const g of input.groups) layout.names!.set(g.id, g.label)

  const labels = labelsFor(sectors, parent, root.id, !!input.groups)
  for (const l of labels) {
    const s = sectors.find(x => x.id === l.sector)!
    const mid = (s.start + s.end) / 2
    const [x, z] = polar(labelRadius(l, mid), mid)
    // wide as the sector's chord, so a sliver's label waits for the camera to come close
    const chord = 2 * RADIUS * Math.sin(Math.min(Math.PI, s.end - s.start) / 2)
    layout.boxes.set(l.id, { x, y: ARC_Y, z, w: chord, h: 0.01, d: 0.01 })
    layout.placement.set(l.id, 'cluster')
    layout.names!.set(l.id, l.text)
  }

  return { layout, radius: RADIUS, hub, levels, sectors, marks, markOf, parent, control, angle, labels, folded }
}

/**
 * Which bands get a name off the ring: the top ones, except that one spanning
 * more than half the circle (src/ holding everything) gives way to its
 * folders; then the folders inside those.
 */
function labelsFor(sectors: Sector[], parent: Map<string, string>, rootId: string, grouped: boolean): WheelLabel[] {
  const inside = new Map<string, Sector[]>()
  for (const s of sectors) {
    const p = parent.get(s.id) ?? rootId
    const list = inside.get(p)
    if (list) list.push(s)
    else inside.set(p, [s])
  }
  const main: Sector[] = []
  const expand = (s: Sector) => {
    const kids = inside.get(s.id)
    if (s.end - s.start > Math.PI && kids?.length) kids.forEach(expand)
    else main.push(s)
  }
  ;(inside.get(rootId) ?? []).forEach(expand)
  const out: WheelLabel[] = []
  const label = (s: Sector, level: 0 | 1) => {
    const group = grouped && s.depth === 1
    out.push({ id: `${LABEL_PREFIX}${s.id}`, sector: s.id, text: group ? shortGroup(s.name) : s.name, level, group })
  }
  for (const s of main) label(s, 0)
  for (const s of main) for (const k of inside.get(s.id) ?? []) label(k, 1)
  return out
}

/**
 * A detected module's label is its main folder and more ("src/lib/guide/content · 39 files (23% there)"):
 * the folder's last two parts do. Other groups' labels ("shared · lib", a layer's name) stay whole.
 */
function shortGroup(label: string) {
  if (!/ · \d+ files?( \(\d+% there\))?$/.test(label)) return label
  const path = label.split(' · ')[0]
  const parts = path.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}

/**
 * Off the ring by the label's own extent toward the middle at the home view:
 * a DOM label is centered on its anchor and stands above it, so on the sides
 * it reaches in by half its width, at the bottom by its height.
 */
function labelRadius(l: WheelLabel, angle: number) {
  const charWidth = l.level === 0 ? 7.8 : 7
  const halfWidth = ((l.text.length * charWidth + 12) / 2) * HOME_WPP
  const height = 18 * HOME_WPP
  const inward = halfWidth * Math.abs(Math.sin(angle)) + Math.max(0, -height * Math.cos(angle))
  return RADIUS + TICK_MAX + 0.04 * RADIUS + inward + (l.level === 0 ? height * 1.2 : 0)
}

// ── routing ────────────────────────────────────────────────────────────────

/** The tree nodes above an arc end: a tick's folders, nearest first; a band's own point, then its parents'. */
function climb(w: Wheel, id: string): string[] {
  const mark = w.markOf.get(id)
  const out: string[] = []
  for (let p = mark !== undefined ? w.parent.get(mark) : id; p !== undefined; p = w.parent.get(p)) out.push(p)
  return out
}

/**
 * The control polygon of an arc from `source` to `target` (box ids): the
 * source's center, where it leaves the bands, the folders up to the lowest
 * common ancestor and down again, where it enters the bands, the target's
 * center; the inner points pulled toward the straight line by 1 − β.
 */
export function controlPolygon(w: Wheel, source: string, target: string, beta = BETA): Point[] | null {
  const a = w.layout.boxes.get(source)
  const b = w.layout.boxes.get(target)
  if (!a || !b) return null
  const up = climb(w, source)
  const down = climb(w, target)
  const k = up.findIndex(id => down.includes(id))
  if (k < 0) return null
  const path = [...up.slice(0, k + 1), ...down.slice(0, down.indexOf(up[k])).reverse()]
  const y = ARC_Y
  const exit = (id: string): Point[] => {
    const at = w.angle.get(w.markOf.get(id) ?? id)
    if (at === undefined) return []
    const [x, z] = polar(w.hub, at)
    return [[x, y, z]]
  }
  const points: Point[] = [
    [a.x, y, a.z],
    ...exit(source),
    ...path.map(id => {
      const [x, z] = w.control.get(id) ?? [0, 0]
      return [x, y, z] as Point
    }),
    ...exit(target),
    [b.x, y, b.z],
  ]
  const last = points.length - 1
  const [p0, pn] = [points[0], points[last]]
  for (let i = 1; i < last; i++) {
    const t = i / last
    for (let c = 0; c < 3; c++) points[i][c] = beta * points[i][c] + (1 - beta) * (p0[c] + t * (pn[c] - p0[c]))
  }
  return points
}

/**
 * A clamped uniform cubic B-spline over the control points, sampled
 * `perSpan` times per span, both ends left out (the engine adds the boxes'
 * centers): n control points give (n + 1) × perSpan − 1 samples.
 */
export function bspline(control: readonly Point[], perSpan = 1): Point[] {
  const n = control.length
  const q = [control[0], control[0], ...control, control[n - 1], control[n - 1]]
  const out: Point[] = []
  for (let span = 0; span <= n; span++)
    for (let s = span === 0 ? 1 : 0; s < perSpan; s++) {
      const t = s / perSpan
      const t2 = t * t
      const t3 = t2 * t
      const b0 = (1 - t) ** 3 / 6
      const b1 = (3 * t3 - 6 * t2 + 4) / 6
      const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6
      const b3 = t3 / 6
      const [p0, p1, p2, p3] = [q[span], q[span + 1], q[span + 2], q[span + 3]]
      out.push([0, 1, 2].map(c => b0 * p0[c] + b1 * p1[c] + b2 * p2[c] + b3 * p3[c]) as Point)
    }
  return out
}

/**
 * The points an arc passes through (without its ends): the B-spline where it
 * is closest to each inner control point, from where it leaves the bands to
 * where it enters them again (what lies outside runs under the bands). Null
 * when an end has no place on the wheel.
 */
export function routePoints(w: Wheel, source: string, target: string, beta = BETA): Point[] | null {
  const control = controlPolygon(w, source, target, beta)
  // bspline(control, 1)[i] is the curve at control point i
  return control && bspline(control, 1).slice(1, -1)
}

// ── picking ────────────────────────────────────────────────────────────────

/** Angle of a point in the plane, clockwise from the top (−z), in [0, 2π). */
export const angleOf = (x: number, z: number) => {
  const a = Math.atan2(x, -z)
  return a < 0 ? a + TAU : a
}

/** What is at a point of the disc: a tick, a band, the bands' ring between them (null), or nothing (undefined). */
export function hitAt(w: Wheel, x: number, z: number): { id: string; kind: 'mark' | 'sector' } | null | undefined {
  const r = Math.hypot(x, z)
  const a = angleOf(x, z)
  // the ticks' zone starts where the bands end, so a click at a tick's base finds it
  if (r >= BANDS_OUT && r <= w.radius + TICK_MAX + 0.4) {
    const m = findRange(w.marks, a)
    return m ? { id: m.id, kind: 'mark' } : undefined
  }
  if (r < w.hub || r > BANDS_OUT) return undefined
  for (const s of w.sectors) if (r >= s.inner && r <= s.outer && a >= s.start && a <= s.end) return { id: s.id, kind: 'sector' }
  return null
}

function findRange<T extends { start: number; end: number }>(list: readonly T[], a: number): T | undefined {
  let lo = 0
  let hi = list.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (a < list[mid].start) hi = mid - 1
    else if (a > list[mid].end) lo = mid + 1
    else return list[mid]
  }
  return undefined
}

// ── trees ──────────────────────────────────────────────────────────────────

/** Point at radius r and angle a (clockwise from −z): [x, z]. */
export const polar = (r: number, a: number): [number, number] => [r * Math.sin(a), -r * Math.cos(a)]

const byPath = (a: GraphNode, b: GraphNode) => cmp(a.path ?? a.name, b.path ?? b.name) || cmp(a.id, b.id)

function node(id: string, name: string, kind: TreeNode['kind'], parent: TreeNode | null, loc = 0): TreeNode {
  return { id, name, kind, depth: parent ? parent.depth + 1 : 0, parent, children: [], files: kind === 'file' ? 1 : 0, loc }
}

/** Attach a finished subtree (folders are added after their contents). */
function add(parent: TreeNode, child: TreeNode) {
  parent.children.push(child)
  parent.files += child.files
  parent.loc += child.loc
}

/** Folders and the visible files in them, then packages, each level in path order. */
function folderTree(input: WheelInput): TreeNode {
  const children = childrenOf(input.nodes)
  const top = input.nodes.find(n => n.id === input.rootId)
  if (!top) throw new Error(`no root node ${input.rootId}`)
  const root = node(top.id, top.name, 'folder', null)
  const visit = (n: GraphNode, into: TreeNode) => {
    for (const c of [...(children.get(n.id) ?? [])].sort(byPath)) {
      if (c.kind === 'file' && input.isVisible(c)) add(into, node(c.id, c.name, 'file', into, c.metrics?.loc ?? 0))
      else if (c.kind === 'directory') {
        const dir = node(c.id, c.name, 'folder', into)
        visit(c, dir)
        if (dir.files > 0) add(into, dir)
      }
    }
  }
  visit(top, root)
  addExternals(input, root)
  return root
}

/** The toolbar's groups, each holding its files in path order; files in none, then packages, after them. */
function groupTree(input: WheelInput): TreeNode {
  const top = input.nodes.find(n => n.id === input.rootId)
  if (!top) throw new Error(`no root node ${input.rootId}`)
  const root = node(top.id, top.name, 'folder', null)
  const files = input.nodes.filter(n => n.kind === 'file' && input.isVisible(n)).sort(byPath)
  const members = new Map<string, GraphNode[]>()
  const loose: GraphNode[] = []
  const known = new Set(input.groups!.map(g => g.id))
  for (const f of files) {
    const g = input.groupOf?.(f.id)
    if (g !== undefined && known.has(g)) members.set(g, [...(members.get(g) ?? []), f])
    else loose.push(f)
  }
  for (const g of input.groups!) {
    const list = members.get(g.id)
    if (!list) continue
    const t = node(g.id, g.label, 'folder', root)
    for (const f of list) add(t, node(f.id, f.name, 'file', t, f.metrics?.loc ?? 0))
    add(root, t)
  }
  for (const f of loose) add(root, node(f.id, f.name, 'file', root, f.metrics?.loc ?? 0))
  addExternals(input, root)
  return root
}

function addExternals(input: WheelInput, root: TreeNode) {
  const externals = input.nodes.filter(n => n.kind === 'external' && input.isVisible(n)).sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id))
  for (const x of externals) add(root, node(x.id, x.name, 'external', root))
}

function walk(t: TreeNode, visit: (t: TreeNode) => void) {
  const stack = [t]
  while (stack.length) {
    const n = stack.pop()!
    visit(n)
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i])
  }
}

function lca(a: TreeNode, b: TreeNode): TreeNode {
  let x: TreeNode = a
  let y: TreeNode = b
  while (x.depth > y.depth) x = x.parent!
  while (y.depth > x.depth) y = y.parent!
  while (x !== y) {
    x = x.parent!
    y = y.parent!
  }
  return x
}
