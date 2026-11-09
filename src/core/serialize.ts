// Wire format: a string table plus parallel columns, so repeated
// ids, paths and kinds are stored once. Sites go to a separate file that the
// server hands out on demand.
import { SCHEMA_VERSION } from './model.ts'
import type { Confidence, EdgeKind, Graph, GraphEdge, GraphMeta, GraphNode, NodeKind, Range, Sites } from './model.ts'

export interface SerializedGraph {
  schemaVersion: number
  meta: GraphMeta
  strings: string[]
  nodes: {
    id: number[]
    kind: number[]
    name: number[]
    subkind: number[] // -1 = none
    parent: number[] // node index, -1 = none
    path: number[] // -1 = none
    range: number[] // 4 per node, all 0 = none
    exported: number[] // 0/1
    signature: number[] // -1 = none
    tags: number[][]
    metrics: Record<string, (number | null)[]>
  }
  edges: {
    source: number[]
    target: number[]
    kind: number[]
    subkind: number[] // -1 = none
    count: number[]
    targets: number[] // bitmask over meta.targets
    confidence: number[] // 0 exact, 1 inferred
    weight?: (number | null)[] // only when some edge has one
  }
}

export interface SerializedSites {
  schemaVersion: number
  /** edge index → [line, col, …] */
  sites: Record<number, number[]>
}

export function encodeGraph(graph: Graph): { graph: SerializedGraph; sites: SerializedSites } {
  const strings: string[] = []
  const stringIndex = new Map<string, number>()
  const str = (s: string) => {
    let i = stringIndex.get(s)
    if (i === undefined) {
      i = strings.length
      strings.push(s)
      stringIndex.set(s, i)
    }
    return i
  }
  const opt = (s: string | undefined) => (s === undefined ? -1 : str(s))
  const nodeIndex = new Map(graph.nodes.map((n, i) => [n.id, i]))
  const metricNames = [...new Set(graph.nodes.flatMap(n => Object.keys(n.metrics ?? {})))].sort()
  const nodes: SerializedGraph['nodes'] = {
    id: [],
    kind: [],
    name: [],
    subkind: [],
    parent: [],
    path: [],
    range: [],
    exported: [],
    signature: [],
    tags: [],
    metrics: Object.fromEntries(metricNames.map(m => [m, []])),
  }
  for (const n of graph.nodes) {
    nodes.id.push(str(n.id))
    nodes.kind.push(str(n.kind))
    nodes.name.push(str(n.name))
    nodes.subkind.push(opt(n.subkind))
    nodes.parent.push(n.parent === undefined ? -1 : (nodeIndex.get(n.parent) ?? -1))
    nodes.path.push(opt(n.path))
    nodes.range.push(...(n.range ?? [0, 0, 0, 0]))
    nodes.exported.push(n.exported ? 1 : 0)
    nodes.signature.push(opt(n.signature))
    nodes.tags.push((n.tags ?? []).map(str))
    for (const m of metricNames) nodes.metrics[m].push(n.metrics?.[m] ?? null)
  }
  const targetBit = new Map(graph.meta.targets.map((t, i) => [t, 1 << i]))
  const edges: SerializedGraph['edges'] = { source: [], target: [], kind: [], subkind: [], count: [], targets: [], confidence: [] }
  const sites: SerializedSites = { schemaVersion: SCHEMA_VERSION, sites: {} }
  graph.edges.forEach((e, i) => {
    const s = nodeIndex.get(e.source)
    const t = nodeIndex.get(e.target)
    if (s === undefined || t === undefined) throw new Error(`edge references unknown node: ${e.source} → ${e.target}`)
    edges.source.push(s)
    edges.target.push(t)
    edges.kind.push(str(e.kind))
    edges.subkind.push(opt(e.subkind))
    edges.count.push(e.count)
    edges.targets.push(e.targets.reduce((mask, name) => mask | (targetBit.get(name) ?? 0), 0))
    edges.confidence.push(e.confidence === 'inferred' ? 1 : 0)
    if (graph.sites[i]?.length) sites.sites[i] = graph.sites[i]
  })
  if (graph.edges.some(e => e.weight !== undefined)) edges.weight = graph.edges.map(e => e.weight ?? null)
  return { graph: { schemaVersion: SCHEMA_VERSION, meta: graph.meta, strings, nodes, edges }, sites }
}

export function decodeGraph(g: SerializedGraph, sites?: SerializedSites): Graph {
  if (g.schemaVersion !== SCHEMA_VERSION) throw new Error(`unsupported graph schema ${g.schemaVersion} (expected ${SCHEMA_VERSION})`)
  const s = g.strings
  const opt = (i: number) => (i < 0 ? undefined : s[i])
  const ids = g.nodes.id.map(i => s[i])
  const metricNames = Object.keys(g.nodes.metrics)
  const nodes: GraphNode[] = ids.map((id, i) => {
    const n: GraphNode = { id, kind: s[g.nodes.kind[i]] as NodeKind, name: s[g.nodes.name[i]] }
    const subkind = opt(g.nodes.subkind[i])
    if (subkind !== undefined) n.subkind = subkind
    if (g.nodes.parent[i] >= 0) n.parent = ids[g.nodes.parent[i]]
    const path = opt(g.nodes.path[i])
    if (path !== undefined) n.path = path
    const r = g.nodes.range.slice(i * 4, i * 4 + 4) as Range
    if (r.some(v => v !== 0)) n.range = r
    if (g.nodes.exported[i]) n.exported = true
    const signature = opt(g.nodes.signature[i])
    if (signature !== undefined) n.signature = signature
    if (g.nodes.tags[i].length) n.tags = g.nodes.tags[i].map(t => s[t])
    const metrics: Record<string, number> = {}
    for (const m of metricNames) {
      const v = g.nodes.metrics[m][i]
      if (v !== null) metrics[m] = v
    }
    if (metricNames.some(m => g.nodes.metrics[m][i] !== null)) n.metrics = metrics
    return n
  })
  const edges: GraphEdge[] = g.edges.source.map((src, i) => {
    const e: GraphEdge = {
      source: ids[src],
      target: ids[g.edges.target[i]],
      kind: s[g.edges.kind[i]] as EdgeKind,
      count: g.edges.count[i],
      targets: g.meta.targets.filter((_, b) => g.edges.targets[i] & (1 << b)),
      confidence: (g.edges.confidence[i] ? 'inferred' : 'exact') as Confidence,
    }
    const subkind = opt(g.edges.subkind[i])
    if (subkind !== undefined) e.subkind = subkind
    const weight = g.edges.weight?.[i]
    if (weight !== undefined && weight !== null) e.weight = weight
    return e
  })
  const edgeSites: Sites[] = sites ? edges.map((_, i) => sites.sites[i] ?? []) : []
  return { meta: g.meta, nodes, edges, sites: edgeSites }
}
