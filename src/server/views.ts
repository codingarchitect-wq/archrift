// What the server hands the viewer. The overview holds
// directories, files and externals with edges lifted to file level: enough to
// draw the city. Symbols and their references load per file on demand, so a
// 10k-file graph (57 MB with everything) starts from a few MB.
// Pure functions over the graph: `archrift serve` answers with them, and so does
// an exported page (`archrift export html`) in the browser, so both answer alike.
import { fileLevel, liftEdges } from '../core/aggregate.ts'
import { familyDiagram, folderDiagram, typeFamilies, typeFolders } from '../core/classes.ts'
import type { ClassDiagram, TypeFamily, TypeFolder } from '../core/classes.ts'
import type { GraphIndex } from '../core/graph-index.ts'
import type { ResolvedDescriptions } from '../core/descriptions.ts'
import type { Graph, GraphEdge, GraphNode, Sites } from '../core/model.ts'

export interface Info {
  name: string
  root: string
  /** Other folders analyzed with the root: name → absolute folder (paths starting with the name live there). */
  mounts?: Record<string, string>
  targets: string[]
  counts: Record<string, number>
  generatedAt: string
  cycles: string[][]
  /** Bumped by every change in watch mode; patches go from one version to the next. */
  version: number
  /** Watch mode is on: /api/events pushes changes. */
  live: boolean
  /** The open project's name in the project list, when the server has one. */
  project?: string
  /** The Ask bar: whether this server can ask an agent, which, or why not. */
  ask?: { available: boolean; engine?: string; why?: string }
}

/** What /api/info says about a graph, given where it was analyzed and how it's served. */
export function infoOf(graph: Graph, served: { root: string; mounts?: Record<string, string>; version: number; live: boolean; project?: string; ask?: Info['ask'] }): Info {
  return {
    name: graph.meta.name,
    root: served.root,
    ...(served.mounts ? { mounts: served.mounts } : {}),
    targets: graph.meta.targets,
    counts: graph.meta.counts,
    generatedAt: graph.meta.generatedAt,
    cycles: graph.meta.cycles,
    version: served.version,
    live: served.live,
    project: served.project,
    ...(served.ask ? { ask: served.ask } : {}),
  }
}

export interface SourceLines {
  path: string
  start: number
  end: number
  total: number
  lines: string[]
}

/** At most this many lines per source request. */
export const MAX_SOURCE_LINES = 600

/** Lines start..end of a file's text (1-based, clamped to the file and to MAX_SOURCE_LINES; no end = to the end). */
export function sourceLines(path: string, text: string, start: number, end?: number): SourceLines {
  const lines = text.split('\n')
  const from = clamp(start, 1, lines.length)
  const to = clamp(end ?? lines.length, from, Math.min(lines.length, from + MAX_SOURCE_LINES - 1))
  return { path, start: from, end: to, total: lines.length, lines: lines.slice(from - 1, to) }
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo)

export function overview(index: GraphIndex): Graph {
  const g = index.graph
  const nodes = g.nodes.filter(n => n.kind === 'directory' || n.kind === 'file' || n.kind === 'external')
  const fileLevelNode = (id: string) => /^[fdx]:/.test(id)
  // edges already between files keep their subkind (a type-only import runs nothing); the rest are lifted
  const direct = g.edges.filter(e => fileLevelNode(e.source) && fileLevelNode(e.target))
  const lifted = liftEdges(index, fileLevel(index), e => !fileLevelNode(e.source) || !fileLevelNode(e.target))
  const edges: GraphEdge[] = [...direct.map(e => ({ ...e })), ...lifted.map(e => ({
    source: e.source,
    target: e.target,
    kind: e.kind,
    count: e.count,
    targets: e.targets,
    confidence: 'exact' as const,
  }))]
  edges.sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.kind, b.kind))
  return { meta: g.meta, nodes, edges, sites: [] }
}

export interface EdgeWithSites extends GraphEdge {
  sites: Sites
}

export interface FileDetails {
  file: string
  /** The file's symbols and members, in source order; for an outside node, the node itself. */
  symbols: GraphNode[]
  /** Symbol-level edges touching the file (in or out), with where they occur. */
  edges: EdgeWithSites[]
  /** The other ends of those edges, for labels in the inspector. */
  endpoints: GraphNode[]
}

export function fileDetails(index: GraphIndex, fileId: string): FileDetails | undefined {
  const file = index.node(fileId)
  if (!file || (file.kind !== 'file' && file.kind !== 'external')) return undefined
  // an outside node (a message topic, a database) has no symbols: it stands for itself
  const symbols = (file.kind === 'external' ? [file] : index.descendants(fileId))
    .sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0) || (a.range?.[1] ?? 0) - (b.range?.[1] ?? 0) || cmp(a.id, b.id))
  const own = new Set([fileId, ...symbols.map(s => s.id)])
  // co-change partners come from the overview; these are the references
  const edgeIdx = new Set<number>()
  const keep = (i: number) => index.graph.edges[i].kind !== 'co-changes' && edgeIdx.add(i)
  for (const id of own) {
    for (const i of index.outgoing.get(id) ?? []) keep(i)
    for (const i of index.incoming.get(id) ?? []) keep(i)
  }
  const edges = [...edgeIdx].sort((a, b) => a - b).map(i => ({ ...index.graph.edges[i], sites: index.graph.sites[i] ?? [] }))
  const endpointIds = new Set<string>()
  for (const e of edges) for (const id of [e.source, e.target]) if (!own.has(id)) endpointIds.add(id)
  const endpoints = [...endpointIds].map(id => index.node(id)!).filter(Boolean)
  return { file: fileId, symbols, edges, endpoints }
}

export interface SearchHit {
  id: string
  name: string
  kind: GraphNode['kind']
  subkind?: string
  path?: string
  score: number
  /** What the search matched in its description: the name a person gave it, or its summary. */
  described?: string
}

const KIND_BONUS: Record<string, number> = { symbol: 3, file: 2, member: 1, directory: 1, external: 0 }

/**
 * Name search: exact > prefix > word start > substring > subsequence, then shorter names and
 * nearer the top. With descriptions, the names people gave score like the code's own, and
 * every word of the query found in a summary counts too ("session check").
 */
export function search(index: GraphIndex, query: string, limit = 30, descriptions?: ResolvedDescriptions): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/).filter(w => w.length > 1)
  const hits: SearchHit[] = []
  for (const n of index.graph.nodes) {
    const name = n.name.toLowerCase()
    let score = 0
    if (name === q) score = 100
    else if (name.startsWith(q)) score = 80
    else if (wordStart(n.name, q)) score = 60
    else if (name.includes(q)) score = 40
    else if (q.includes('/') && n.path?.toLowerCase().includes(q)) score = 35
    else if (n.tags?.some(t => /^(rpc|route|api):/.test(t) && t.toLowerCase().includes(q))) score = 50
    else if (subsequence(name, q)) score = 10
    const d = descriptions?.entries[n.id]
    let described: string | undefined
    if (d) {
      const given = d.name?.toLowerCase()
      const own = given === q ? 95 : given?.startsWith(q) ? 75 : given && wordStart(d.name!, q) ? 55 : given?.includes(q) ? 38 : 0
      const text = `${given ?? ''} ${d.summary.toLowerCase()}`
      const inSummary = words.length && words.every(w => text.includes(w)) ? 30 : 0
      if (Math.max(own, inSummary) > score) {
        score = Math.max(own, inSummary)
        described = own >= inSummary ? d.name : d.summary
      }
    }
    if (!score) continue
    score += KIND_BONUS[n.kind] ?? 0
    if (n.tags?.includes('test')) score -= 5
    hits.push({ id: n.id, name: n.name, kind: n.kind, subkind: n.subkind, path: n.path, score: score - n.name.length / 100, ...(described ? { described } : {}) })
  }
  return hits.sort((a, b) => b.score - a.score || cmp(a.id, b.id)).slice(0, limit)
}

/** `ds` matches `DataService` at the word starts D and S; `gacc` matches getAccounts. */
function wordStart(name: string, q: string) {
  const starts = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_\-./]+/)
  if (starts.some(w => w.toLowerCase().startsWith(q))) return true
  const initials = starts.map(w => w[0]?.toLowerCase() ?? '').join('')
  return q.length > 1 && initials.startsWith(q)
}

function subsequence(name: string, q: string) {
  let i = 0
  for (const c of name) if (c === q[i]) i++
  return i === q.length
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** What the Classes view picks from: the type families, and the folders declaring types. */
export interface ClassChoices {
  families: TypeFamily[]
  folders: TypeFolder[]
}

/** /api/classes: the choices, or with `family` or `folder` that family's or folder's class diagram. */
export function classes(graph: Graph, q: { family?: string | null; folder?: string | null }): ClassChoices | ClassDiagram {
  if (q.family) return familyDiagram(graph, q.family)
  if (q.folder !== undefined && q.folder !== null) return folderDiagram(graph, q.folder)
  return { families: typeFamilies(graph), folders: typeFolders(graph) }
}
