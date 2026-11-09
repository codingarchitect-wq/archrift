// Layers layout: the city split into horizontal planes, one per
// architecture layer, top layer highest. Dependencies should point down; the
// controller draws the ones pointing up as violations. A directory whose files
// sit in several layers appears on each of those planes: its box id is the
// directory's own on the plane holding most of its files, `dir\0layer` on the others.
import type { GraphNode } from '../../core/model.ts'
import { SCALE, childrenOf, placeExternals, placeTree, weighTree } from './city.ts'
import type { CityInput } from './city.ts'
import type { Layout } from './types.ts'
import { emptyLayout } from './types.ts'

export const UNASSIGNED = '(no layer)'
export const PLANE_H = 1.2
const SPLIT = '\u0000'

export interface LayersInput extends CityInput {
  /** Layer names, top to bottom. */
  order: string[]
  /** A visible file's layer; files without one go to a last plane. */
  layerOf: (file: GraphNode) => string | undefined
  /** Plane labels (default: the layer name). */
  labels?: Map<string, string>
}

export const planeId = (layer: string) => `plane:${layer}`
/** The graph node a (possibly split) layers-view box stands for. */
export const baseId = (boxId: string) => boxId.split(SPLIT)[0]

export function layersLayout(input: LayersInput): Layout {
  const children = childrenOf(input.nodes)
  const byId = new Map(input.nodes.map(n => [n.id, n]))
  const root = byId.get(input.rootId)
  if (!root) throw new Error(`no root node ${input.rootId}`)
  const layerOf = (n: GraphNode) => input.layerOf(n) ?? UNASSIGNED

  // how many visible files of each layer every directory holds
  const perDir = new Map<string, Map<string, number>>()
  let unassigned = false
  for (const n of input.nodes) {
    if (n.kind !== 'file' || !input.isVisible(n)) continue
    const layer = layerOf(n)
    if (layer === UNASSIGNED) unassigned = true
    for (let p = n.parent; p !== undefined; p = byId.get(p)?.parent) {
      const counts = perDir.get(p) ?? new Map<string, number>()
      counts.set(layer, (counts.get(layer) ?? 0) + 1)
      perDir.set(p, counts)
    }
  }
  const order = [...input.order, ...(unassigned ? [UNASSIGNED] : [])]
  const rank = new Map(order.map((l, i) => [l, i]))
  const primary = new Map<string, string>()
  for (const [dir, counts] of perDir)
    primary.set(dir, [...counts].sort((a, b) => b[1] - a[1] || rank.get(a[0])! - rank.get(b[0])!)[0][0])

  const planes = order
    .map(layer => {
      const weight = weighTree(children, root, n => input.isVisible(n) && layerOf(n) === layer)
      return { layer, weight, total: weight.get(root.id) ?? 0 }
    })
    .filter(p => p.total > 0)
  const sides = planes.map(p => Math.max(40, Math.sqrt(p.total) * SCALE))
  const widest = Math.max(60, ...sides)
  const gap = Math.max(45, widest * 0.2)
  const height = (planes.length - 1) * gap

  const out: Layout = {
    ...emptyLayout(),
    view: 'layers',
    size: Math.max(widest, height) * 1.15,
    names: new Map(),
    layerIndex: new Map(),
    // from the side and a little above, far enough back to see the whole stack
    home: [0.75, 0.55, 1.45],
    center: [0, height / 2, 0],
  }
  planes.forEach((plane, i) => {
    const y = height - i * gap
    const side = sides[i]
    const id = planeId(plane.layer)
    out.boxes.set(id, { x: 0, z: 0, y: y - PLANE_H, w: side + 10, d: side + 10, h: PLANE_H })
    out.placement.set(id, 'plane')
    out.depth.set(id, 0)
    out.names!.set(id, input.labels?.get(plane.layer) ?? plane.layer)
    placeTree(
      { children, weight: plane.weight, out, districtId: dir => (primary.get(dir) === plane.layer ? dir : `${dir}${SPLIT}${plane.layer}`) },
      root,
      { x: -side / 2, z: -side / 2, w: side, d: side },
      y,
      0,
      false,
    )
    // files in no layer (scripts, configs) stand apart: nothing of theirs points up or down
    if (plane.layer !== UNASSIGNED)
      for (const n of input.nodes) if (n.kind === 'file' && input.isVisible(n) && layerOf(n) === plane.layer) out.layerIndex!.set(n.id, i)
  })
  placeExternals(input, out, widest / 2)
  return out
}
