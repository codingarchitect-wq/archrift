// §5 Building Block View, part 3: the boards in 3D. Level 1 lies on the
// ground; each white box floats above and behind the board it opens from (an
// exploded view), so the levels read as a staircase into the detail. Per
// board: blocks sized by their code, rows by layer (or, inside one layer, by
// how they depend on each other), the dependencies drawn (by the toolbar's
// edges option: the main ones, all, the focused block's, those breaking a
// rule, or none), and the diagram (diagram.ts) that places and routes them.
// Pure.
import { autoLayers } from '../../../core/auto-layers.ts'
import { ON_BOARD } from '../arc42-kit/board.ts'
import type { V3 } from '../arc42-kit/sketch.ts'
import { diagram } from './diagram.ts'
import type { Diagram, DiagramEdge, DiagramNode } from './diagram.ts'
import type { BlocksModel, Level, Unit } from './model.ts'

export interface Board {
  level: Level
  diagram: Diagram
  /** The board's center on the ground plane and its height above it; its size along x and z. */
  x: number
  y: number
  z: number
  w: number
  d: number
  /** Per unit, then per stub: how high its slab stands (0 for a stub). */
  heights: number[]
  /** The links drawn (indexes into level.links), in the diagram's edge order. */
  shown: number[]
  /** Links left out (the weaker ones, while only the main ones show). */
  hidden: number
}

export interface Scene {
  boards: Board[]
  min: V3
  max: V3
  /** Which dependencies the boards draw. */
  mode: LinkMode
}

/**
 * Which dependencies a board draws, by the toolbar's edges option: the main
 * ones (auto), every one (all), the focused block's (selection), those that
 * break a rule (violations), or none.
 */
export type LinkMode = 'main' | 'all' | 'selection' | 'violations' | 'none'

/** The links a board draws in a mode; `focus` is its block in focus (the selection's, or the one opened above it). */
export function shownLinks(level: Level, mode: LinkMode, focus: number | undefined): number[] {
  const all = level.links.map((_, i) => i)
  switch (mode) {
    case 'main':
      return mainLinks(level)
    case 'all':
      return all
    case 'selection':
      return focus === undefined ? [] : all.filter(i => level.links[i].from === focus || level.links[i].to === focus)
    case 'violations':
      return all.filter(i => level.links[i].violates)
    case 'none':
      return []
  }
}

/** Board header room (caption and heading), and the margin under it. */
export const HEADER = 10
const MIN_BOARD = 64
/** World units per character of a name at the home view (labels are screen text). */
const CHAR = 1.0
/** How far a white box rises over, and moves behind, the board it opens from, per unit of their mean depth. */
const RISE = 0.55
const BACK = 0.62
/** The least rise, so a white box clears the blocks standing on the board below. */
const MIN_RISE = 14
/** Rows of a white box's own blocks (by dependency depth, folded). */
const MAX_ROWS = 4

/** A block's footprint: area by its code, never narrower than its name. */
export function unitSize(u: Unit): { w: number; h: number } {
  // wide rather than tall: the board's rows stack in depth, which the camera's tilt already shortens
  const byCode = 11 + 0.13 * Math.sqrt(Math.max(0, u.loc))
  const w = Math.max(byCode * 1.15, u.name.length * CHAR + 5, (u.note?.length ?? 0) * CHAR * 0.8 + 4)
  return { w, h: Math.max(7, Math.min(byCode * 0.42, 15)) }
}

/** A block's height: a little more for more files. */
export const unitHeight = (u: Unit) => 1.1 + 0.42 * Math.log2(1 + u.files.length)

/**
 * The links worth drawing when only the main ones show: those carrying a
 * share of the board's dependencies (1% on level 1, 2.5% in a white box),
 * each block's strongest one each way (so none is left unconnected), every
 * one pointing up, and each neighbor stub's strongest.
 */
export function mainLinks(level: Level): number[] {
  const n = level.units.length
  const inner = level.links.map((l, i) => i).filter(i => level.links[i].from < n && level.links[i].to < n)
  const total = inner.reduce((sum, i) => sum + level.links[i].weight, 0)
  const keep = new Set<number>()
  /** Per key, the `count` heaviest of the links given. */
  const strongest = (list: number[], key: (i: number) => number, count: number) => {
    const by = new Map<number, number[]>()
    for (const i of list) push(by, key(i), i)
    for (const group of by.values()) group.sort((a, b) => level.links[b].weight - level.links[a].weight || a - b).slice(0, count).forEach(i => keep.add(i))
  }
  strongest(inner, i => level.links[i].from, 1)
  strongest(inner, i => level.links[i].to, 1)
  // a white box's blocks are closer knit than the system's: there it takes a larger share to count
  const share = level.depth === 1 ? 0.01 : 0.025
  for (const i of inner) if (level.links[i].weight >= total * share || level.links[i].up) keep.add(i)
  // a neighbor at the edge: its strongest link into the box
  const outer = level.links.map((l, i) => i).filter(i => level.links[i].from >= n || level.links[i].to >= n)
  strongest(outer, i => Math.max(level.links[i].from, level.links[i].to), 1)
  return [...keep].sort((a, b) => a - b)
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

/** Rows: by tier (features above shared code) or by layer when the units span several, else by how they depend on each other (users above). */
function rowsOf(level: Level): number[] {
  const units = level.units
  if (level.depth === 1 && units.some(u => u.tier !== undefined)) {
    const last = Math.max(...units.map(u => u.tier ?? 0)) + 1
    return units.map(u => u.tier ?? last)
  }
  const layers = new Set(units.map(u => u.layer).filter(l => l !== undefined))
  if (level.depth === 1 && layers.size > 1) {
    const last = Math.max(...layers) + 1
    return units.map(u => u.layer ?? last)
  }
  const ids = units.map((_, i) => String(i))
  const edges = level.links.filter(l => l.from < units.length && l.to < units.length).map(l => ({ source: String(l.from), target: String(l.to) }))
  const auto = autoLayers(ids, edges, id => id)
  const index = new Map(auto.order.map((l, i) => [l, i]))
  // long dependency chains fold into a few rows (fewer for fewer blocks), so a white box stays wider than deep
  const depth = auto.order.length
  const rows = Math.min(depth, MAX_ROWS, Math.max(2, Math.ceil(units.length / 3)))
  return ids.map(id => Math.floor((index.get(auto.layerOfArea.get(id)!)! * rows) / depth))
}

/** One board: its diagram, with the stubs of a white box in a row above (its users) and below (what it uses). */
function boardOf(level: Level, mode: LinkMode, focus: number | undefined): Omit<Board, 'x' | 'y' | 'z'> {
  const rows = rowsOf(level)
  const contentRows = Math.max(0, ...rows) + 1
  const nodes: DiagramNode[] = level.units.map((u, i) => ({ ...unitSize(u), row: rows[i] + 1, rank: i, lollipop: true }))
  level.stubs.forEach((s, i) =>
    nodes.push({ w: Math.max(10, s.name.length * CHAR * 0.9 + 4), h: 4.6, row: s.side === 'top' ? 0 : contentRows + 1, rank: i, lollipop: false }),
  )
  const shown = shownLinks(level, mode, focus)
  const edges: DiagramEdge[] = shown.map(i => ({ from: level.links[i].from, to: level.links[i].to, weight: level.links[i].weight }))
  // the heading (bold, larger) must fit
  const d = diagram(nodes, edges, { header: HEADER, minWidth: Math.max(MIN_BOARD, level.title.length * CHAR * 1.25 + 12), maxPerRow: level.depth === 1 ? 7 : 10 })
  const heights = [...level.units.map(unitHeight), ...level.stubs.map(() => 0)]
  return { level, diagram: d, w: d.width, d: d.height, heights, shown, hidden: level.links.length - shown.length }
}

/** Every board placed: level 1 centered on the ground, each white box over and behind the block it opens. */
export function compose(model: BlocksModel, mode: LinkMode, focus: readonly (number | undefined)[] = []): Scene {
  const boards: Board[] = []
  for (const [k, level] of model.levels.entries()) {
    const b = boardOf(level, mode, focus[k])
    const prev = boards[boards.length - 1]
    if (!prev) {
      boards.push({ ...b, x: 0, y: 0, z: 0 })
      continue
    }
    const opened = prev.diagram.boxes[level.opened!]
    const ox = prev.x - prev.w / 2 + opened.u
    const mean = (prev.d + b.d) / 2
    boards.push({
      ...b,
      x: prev.x + (ox - prev.x) * 0.5,
      y: prev.y + Math.max(MIN_RISE, mean * RISE),
      z: prev.z - (prev.d / 2 + b.d / 2) * BACK - mean * 0.05,
    })
  }
  const min: [number, number, number] = [Infinity, 0, Infinity]
  const max: [number, number, number] = [-Infinity, 0, -Infinity]
  for (const b of boards) {
    min[0] = Math.min(min[0], b.x - b.w / 2)
    max[0] = Math.max(max[0], b.x + b.w / 2)
    min[2] = Math.min(min[2], b.z - b.d / 2)
    max[2] = Math.max(max[2], b.z + b.d / 2)
    max[1] = Math.max(max[1], b.y + Math.max(0, ...b.heights))
  }
  return { boards, min, max, mode }
}

/** A point of a board in the world: (u, v) from its top-left corner, `lift` above it. */
export function worldOf(b: Board, u: number, v: number, lift = 0): V3 {
  return [b.x - b.w / 2 + u, b.y + lift, b.z - b.d / 2 + v]
}

/** The home view's direction (times the layout's size): about 57° down. */
export const HOME: [number, number, number] = [0, 0.84, 0.54]

/** What covers the scene, as shares of the window: the toolbar on top, the legend at the bottom, the inspector on the right. */
export interface Screen {
  aspect: number
  top: number
  bottom: number
  right: number
}

export const DEFAULT_SCREEN: Screen = { aspect: 1.6, top: 0.17, bottom: 0.16, right: 0 }

const TAN_V = Math.tan((25 * Math.PI) / 180) // the engine's camera: 50° high

/**
 * The home view: from HOME's direction, at the distance and looking at the
 * point that fit every board corner (as the perspective camera sees it) into
 * the part of the window the panels leave free.
 */
export function framing(boards: readonly Board[], screen: Screen = DEFAULT_SCREEN): { size: number; center: [number, number, number] } {
  const length = Math.hypot(...HOME)
  const dir = HOME.map(v => v / length) as [number, number, number]
  const [cos, sin] = [dir[2], dir[1]]
  const up = [0, cos, -sin] // the screen's up, in the world
  const corners: [number, number, number][] = []
  let top = 0
  for (const b of boards) {
    const tall = b.y + Math.max(0, ...b.heights) + ON_BOARD
    top = Math.max(top, tall)
    for (const x of [b.x - b.w / 2, b.x + b.w / 2]) for (const z of [b.z - b.d / 2, b.z + b.d / 2]) for (const y of [b.y, tall]) corners.push([x, y, z])
  }
  // the free part of the window, in normalized device coordinates
  const free = { x0: -0.96, x1: 0.96 - 2 * screen.right, y0: -1 + 2 * screen.bottom, y1: 1 - 2 * screen.top }
  const tanH = TAN_V * screen.aspect
  const mid = (i: number) => (Math.min(...corners.map(c => c[i])) + Math.max(...corners.map(c => c[i]))) / 2
  let center: [number, number, number] = [mid(0), top * 0.4, mid(2)]
  let distance = Math.max(90, Math.max(...corners.map(c => Math.hypot(c[0] - center[0], c[2] - center[2]))) * 1.6)
  for (let it = 0; it < 12; it++) {
    const eye = center.map((v, i) => v + dir[i] * distance)
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity]
    for (const c of corners) {
      const v = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]]
      const depth = -(v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2])
      if (depth <= 1) {
        x0 = -Infinity // behind the camera: back off
        break
      }
      const sx = v[0] / depth / tanH
      const sy = (v[1] * up[1] + v[2] * up[2]) / depth / TAN_V
      x0 = Math.min(x0, sx)
      x1 = Math.max(x1, sx)
      y0 = Math.min(y0, sy)
      y1 = Math.max(y1, sy)
    }
    if (!Number.isFinite(x0)) {
      distance *= 1.5
      continue
    }
    // move the look-at point so the boards' middle comes to the free part's, then fit them in it
    const dx = (x0 + x1) / 2 - (free.x0 + free.x1) / 2
    const dy = (y0 + y1) / 2 - (free.y0 + free.y1) / 2
    center = [center[0] + dx * distance * tanH, center[1] + dy * distance * TAN_V * up[1], center[2] + dy * distance * TAN_V * up[2]]
    distance *= Math.max((x1 - x0) / (free.x1 - free.x0), (y1 - y0) / (free.y1 - free.y0)) * 1.03
  }
  return { size: distance / length, center }
}
