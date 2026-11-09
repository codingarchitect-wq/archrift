// City layout: directories are raised districts in a squarified
// treemap, files are buildings (footprint and height grow with LOC), external
// packages stand in a row south of the city. The tree placement is shared
// with the Layers view, which places one tree per plane.
import type { GraphNode } from '../../core/model.ts'
import type { Box, Layout } from './types.ts'
import { emptyLayout } from './types.ts'

export const PLATFORM_H = 2
export const SCALE = 5 // ground side per √(weight): keeps buildings a similar size in any repo
const EXTERNAL = 7

export const fileWeight = (loc: number) => Math.pow(Math.max(loc, 20), 0.7)
export const buildingHeight = (loc: number) => 2 + Math.sqrt(Math.max(loc, 0)) * 1.1

export interface CityInput {
  nodes: readonly GraphNode[]
  rootId: string
  /** Files and externals to place; directories appear when they contain a placed file. */
  isVisible: (n: GraphNode) => boolean
}

export interface Rect {
  x: number
  z: number
  w: number
  d: number
}

export function childrenOf(nodes: readonly GraphNode[]) {
  const children = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    if (n.parent === undefined) continue
    const list = children.get(n.parent)
    if (list) list.push(n)
    else children.set(n.parent, [n])
  }
  return children
}

/** Treemap weight of every node under root (0 = nothing visible there). */
export function weighTree(children: Map<string, GraphNode[]>, root: GraphNode, isVisible: (n: GraphNode) => boolean) {
  const weight = new Map<string, number>()
  const weigh = (n: GraphNode): number => {
    let w = 0
    if (n.kind === 'file') w = isVisible(n) ? fileWeight(n.metrics?.loc ?? 0) : 0
    else if (n.kind === 'directory') {
      const sum = (children.get(n.id) ?? []).reduce((a, c) => a + weigh(c), 0)
      w = sum > 0 ? sum * 1.12 + 6 : 0
    }
    weight.set(n.id, w)
    return w
  }
  weigh(root)
  return weight
}

export interface TreePlacement {
  children: Map<string, GraphNode[]>
  weight: Map<string, number>
  out: Layout
  /** The box id for a directory (the Layers view splits directories across planes). */
  districtId?: (dirId: string) => string
}

/** Place `node` as a district over `rect` at height y, and everything visible under it. */
export function placeTree(t: TreePlacement, node: GraphNode, rect: Rect, y: number, level: number, platform = true) {
  const id = t.districtId?.(node.id) ?? node.id
  if (platform) {
    t.out.boxes.set(id, { x: rect.x + rect.w / 2, z: rect.z + rect.d / 2, y, w: rect.w, d: rect.d, h: PLATFORM_H })
    t.out.placement.set(id, 'district')
    t.out.depth.set(id, level)
  }
  const pad = platform ? Math.min(rect.w, rect.d) * 0.025 + 1.2 : 0
  const inner = { x: rect.x + pad, z: rect.z + pad, w: rect.w - 2 * pad, d: rect.d - 2 * pad }
  const kids = (t.children.get(node.id) ?? []).filter(c => (t.weight.get(c.id) ?? 0) > 0)
  if (!kids.length || inner.w <= 0 || inner.d <= 0) return
  const rects = squarify(
    kids.map(c => t.weight.get(c.id)!),
    kids.map(c => c.id),
    inner,
  )
  const top = platform ? y + PLATFORM_H : y
  kids.forEach((c, i) => {
    const cell = rects[i]
    if (c.kind === 'directory') return placeTree(t, c, cell, top, level + 1)
    const margin = Math.min(cell.w, cell.d) * 0.14
    // a sliver cell still gets a building, not a wall: at most 3:1
    const w = Math.max(cell.w - 2 * margin, 0.4)
    const d = Math.max(cell.d - 2 * margin, 0.4)
    t.out.boxes.set(c.id, {
      x: cell.x + cell.w / 2,
      z: cell.z + cell.d / 2,
      y: top,
      w: Math.min(w, d * 3),
      d: Math.min(d, w * 3),
      h: buildingHeight(c.metrics?.loc ?? 0),
    })
    t.out.placement.set(c.id, 'building')
  })
}

export function cityLayout(input: CityInput): Layout {
  const children = childrenOf(input.nodes)
  const root = input.nodes.find(n => n.id === input.rootId)
  if (!root) throw new Error(`no root node ${input.rootId}`)
  const weight = weighTree(children, root, input.isVisible)
  const total = weight.get(root.id) ?? 0
  const size = Math.max(60, Math.sqrt(total) * SCALE)
  const out: Layout = { ...emptyLayout(), view: 'city', size, center: [0, 0, size * 0.08] }
  if (total > 0) placeTree({ children, weight, out }, root, { x: -out.size / 2, z: -out.size / 2, w: out.size, d: out.size }, 0, 0)
  placeExternals(input, out, out.size / 2)
  return out
}

/** Externals: a grid of small blocks south of `southEdge`, by name. */
export function placeExternals(input: CityInput, out: Layout, southEdge: number, y = 0) {
  const externals = input.nodes.filter(n => n.kind === 'external' && input.isVisible(n)).sort((a, b) => cmp(a.name, b.name))
  const cols = Math.max(1, Math.floor(out.size / (EXTERNAL * 2)))
  externals.forEach((n, i) => {
    const box: Box = {
      x: -out.size / 2 + EXTERNAL + (i % cols) * EXTERNAL * 2,
      z: southEdge + EXTERNAL * 3 + Math.floor(i / cols) * EXTERNAL * 2,
      y,
      w: EXTERNAL,
      d: EXTERNAL,
      h: EXTERNAL * 0.6,
    }
    out.boxes.set(n.id, box)
    out.placement.set(n.id, 'external')
  })
}

/**
 * Squarified treemap (Bruls et al.): rows of cells along the shorter side,
 * adding a cell while it improves the worst aspect ratio. Deterministic: ties
 * in weight are broken by key.
 */
export function squarify(weights: number[], keys: string[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(weights.length)
  const total = weights.reduce((a, b) => a + b, 0)
  const scale = (rect.w * rect.d) / total
  const order = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a] || cmp(keys[a], keys[b]))
  let { x, z, w, d } = rect
  const worst = (row: number[], side: number) => {
    let s = 0
    let max = 0
    let min = Infinity
    for (const i of row) {
      const a = weights[i] * scale
      s += a
      max = Math.max(max, a)
      min = Math.min(min, a)
    }
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min))
  }
  const layRow = (row: number[]) => {
    const s = row.reduce((a, i) => a + weights[i] * scale, 0)
    if (w >= d) {
      const cw = s / d
      let zz = z
      for (const i of row) {
        const h = (weights[i] * scale) / cw
        out[i] = { x, z: zz, w: cw, d: h }
        zz += h
      }
      x += cw
      w -= cw
    } else {
      const rh = s / w
      let xx = x
      for (const i of row) {
        const ww = (weights[i] * scale) / rh
        out[i] = { x: xx, z, w: ww, d: rh }
        xx += ww
      }
      z += rh
      d -= rh
    }
  }
  let row: number[] = []
  for (let k = 0; k < order.length; ) {
    const side = Math.min(w, d)
    const candidate = [...row, order[k]]
    if (row.length === 0 || worst(candidate, side) <= worst(row, side)) {
      row = candidate
      k++
    } else {
      layRow(row)
      row = []
    }
  }
  if (row.length) layRow(row)
  return out
}

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
