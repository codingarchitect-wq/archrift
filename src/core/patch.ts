// Graph patches for watch mode: what changed between two versions
// of a graph, by stable id, small enough to push to the viewer after a save.
import type { Graph, GraphEdge, GraphMeta, GraphNode } from './model.ts'

export interface GraphPatch {
  /** Versions: the patch turns graph `from` into graph `to`. */
  from: number
  to: number
  meta: GraphMeta
  /** Nodes added or changed, whole. */
  nodes: GraphNode[]
  removedNodes: string[]
  edges: GraphEdge[]
  removedEdges: string[]
  /** Files whose contents changed (added, removed, or any node or edge of theirs). */
  files: string[]
}

/** An edge's identity including everything about it, so a changed count is a removal plus an addition. */
export const edgeKey = (e: GraphEdge) =>
  `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.subkind ?? ''}\u0000${e.count}\u0000${e.targets.join(',')}\u0000${e.confidence}\u0000${e.weight ?? ''}`

const fileOf = (id: string) => (id.startsWith('f:') ? id : undefined)

/** JSON with keys sorted at every level: two equal nodes compare equal however they were built. */
const stable = (v: unknown): string =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
    : JSON.stringify(v)

export function diffGraphs(before: Graph, after: Graph, from: number, to: number): GraphPatch {
  const old = new Map(before.nodes.map(n => [n.id, n]))
  const nodes: GraphNode[] = []
  const files = new Set<string>()
  for (const n of after.nodes) {
    const had = old.get(n.id)
    if (had && stable(had) === stable(n)) continue
    nodes.push(n)
    const f = fileOf(n.id)
    if (f) files.add(f)
  }
  const now = new Set(after.nodes.map(n => n.id))
  const removedNodes = before.nodes.filter(n => !now.has(n.id)).map(n => n.id)
  removedNodes.forEach(id => fileOf(id) && files.add(id))

  const oldEdges = new Set(before.edges.map(edgeKey))
  const newEdges = new Set<string>()
  const edges: GraphEdge[] = []
  for (const e of after.edges) {
    const k = edgeKey(e)
    newEdges.add(k)
    if (!oldEdges.has(k)) edges.push(e)
  }
  const removedEdges = [...oldEdges].filter(k => !newEdges.has(k))
  // an edge that changed belongs to the file it starts from (co-change moves with either end)
  for (const e of edges) if (e.kind !== 'co-changes') fileOf(e.source) && files.add(e.source)
  for (const k of removedEdges) {
    const [source, , kind] = k.split('\u0000')
    if (kind !== 'co-changes' && fileOf(source)) files.add(source)
  }
  return { from, to, meta: after.meta, nodes, removedNodes, edges, removedEdges, files: [...files].sort() }
}

/** `graph` with `patch` applied (a new graph; the old one is left alone). */
export function applyPatch(graph: Graph, patch: GraphPatch): Graph {
  const removed = new Set(patch.removedNodes)
  const byId = new Map(graph.nodes.filter(n => !removed.has(n.id)).map(n => [n.id, n]))
  for (const n of patch.nodes) byId.set(n.id, n)
  const gone = new Set(patch.removedEdges)
  const edges = [...graph.edges.filter(e => !gone.has(edgeKey(e))), ...patch.edges]
  return { meta: patch.meta, nodes: [...byId.values()], edges, sites: [] }
}

/** How much of a graph a patch rewrites (0–1): past some point, reloading is simpler. */
export const patchShare = (graph: Graph, patch: GraphPatch) =>
  (patch.nodes.length + patch.removedNodes.length + patch.edges.length + patch.removedEdges.length) / Math.max(1, graph.nodes.length + graph.edges.length)
