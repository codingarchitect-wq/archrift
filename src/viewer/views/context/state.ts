// §3 Context view: the map a layout was made from (kept by layout, so labels,
// the decoration and the legend read it without recomputing), the model
// cached per graph and filters, and what's lit by the selection.
import type { GraphNode } from '../../../core/model.ts'
import type { Layout } from '../../layouts/types.ts'
import type { ViewContext } from '../types.ts'
import { contextModel } from './model.ts'
import type { ContextModel } from './model.ts'
import { placeContext } from './place.ts'
import type { ContextPlan } from './place.ts'

export interface ContextMap {
  model: ContextModel
  plan: ContextPlan
}

export const maps = new WeakMap<Layout, ContextMap>()

let cached: { key: string; nodes: readonly GraphNode[]; map: ContextMap } | undefined

/** The model and plan for what the viewer shows (recomputed when the graph, the filters, the target or the layering change). */
export function contextOf(ctx: ViewContext, base: number): ContextMap {
  const key = `${ctx.visibility.key}|${ctx.s.options.target}|${ctx.s.options.layering}|${base}`
  const nodes = ctx.world.graph.nodes
  if (cached?.nodes === nodes && cached.key === key) return cached.map
  const layers = ctx.layers()
  const model = contextModel({
    name: ctx.world.graph.meta.name,
    nodes,
    edges: ctx.world.graph.edges,
    target: ctx.s.options.target,
    isShown: ctx.visibility.isVisible,
    order: layers.order,
    layerOf: layers.layerOf,
    labels: layers.labels,
  })
  const map = { model, plan: placeContext(model, base) }
  cached = { key, nodes, map }
  publish(model)
  return map
}

/** What's lit by the selection: neighbors, ties (as `neighbor:tie`) and slabs; null when nothing is selected. */
export interface Lit {
  neighbors: Set<number>
  ties: Set<string>
  slabs: Set<number>
}

export function litBy(ctx: ViewContext, model: ContextModel): Lit | null {
  const sel = ctx.s.selected
  if (!sel) return null
  const lit: Lit = { neighbors: new Set(), ties: new Set(), slabs: new Set() }
  const node = ctx.world.node(sel)
  // a folder covers the files below it
  const prefix = node?.kind === 'directory' ? (node.path ? `${node.path}/` : '') : undefined
  const covers = (file: string) => file === sel || (prefix !== undefined && (ctx.world.node(file)?.path ?? '').startsWith(prefix))
  const light = (match: (nb: (typeof model.neighbors)[number], t: (typeof model.neighbors)[number]['ties'][number]) => boolean) =>
    model.neighbors.forEach((nb, i) =>
      nb.ties.forEach((t, j) => {
        if (!match(nb, t)) return
        lit.neighbors.add(i)
        lit.ties.add(`${i}:${j}`)
        lit.slabs.add(t.slab)
      }),
    )
  // a tie of its own (an inbound channel), else a whole neighbor, else every tie the selected code is on
  light((nb, t) => t.select === sel && t.select !== nb.select)
  if (!lit.ties.size) light(nb => nb.select === sel || nb.ids.includes(sel))
  if (!lit.ties.size) light((_, t) => t.files.some(covers))
  model.slabs.forEach((s, k) => {
    if (s.select === sel) lit.slabs.add(k)
  })
  // a file outside every tie still lights its own layer
  if (node?.kind === 'file' && !lit.slabs.size) {
    const layers = ctx.layers()
    const layer = layers.layerOf(node)
    const k = layer === undefined ? -1 : model.slabs.findIndex(s => s.name === layer)
    if (k >= 0) lit.slabs.add(k)
  }
  return lit
}

// ── the legend's numbers ───────────────────────────────────────────────────

export interface Summary {
  neighbors: number
  libraries: string[]
}

let summary: Summary | null = null
const listeners = new Set<() => void>()

function publish(model: ContextModel) {
  const next = { neighbors: model.neighbors.length, libraries: model.libraries }
  if (summary && summary.neighbors === next.neighbors && summary.libraries.join() === next.libraries.join()) return
  summary = next
  for (const l of listeners) l()
}

export const legendSummary = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  },
  get: () => summary,
}
