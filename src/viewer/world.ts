// The overview graph with the lookups the viewer needs: containment, file
// links per node (summed over edge kinds) and the "area" each file belongs to.
import { louvain, reach, shortestPaths } from '../core/algorithms.ts'
import { GraphIndex } from '../core/graph-index.ts'
import { ROOT_ID } from '../core/ids.ts'
import type { Graph, GraphNode } from '../core/model.ts'

export interface Link {
  /** The node at the other end. */
  other: string
  /** Edge kind → summed reference count. */
  kinds: Map<string, number>
  targets: Set<string>
}

export class World {
  readonly graph: Graph
  readonly index: GraphIndex
  readonly rootId = ROOT_ID
  /** File (or external) → the district that colors it (two levels below the root when there is one). */
  readonly areaOf = new Map<string, string>()
  /** Areas by size, largest first. */
  readonly areas: GraphNode[]

  constructor(graph: Graph) {
    this.graph = graph
    this.index = new GraphIndex(graph)
    const size = new Map<string, number>()
    for (const n of graph.nodes) {
      if (n.kind !== 'file') continue
      const dirs = this.index.ancestors(n.id).reverse() // root first
      const area = (dirs[2] ?? dirs[1] ?? dirs[0])?.id ?? ROOT_ID
      this.areaOf.set(n.id, area)
      size.set(area, (size.get(area) ?? 0) + (n.metrics?.loc ?? 0))
    }
    this.areas = [...size.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => this.index.node(id)!)
  }

  node(id: string) {
    return this.index.node(id)
  }

  /** Links to and from a node at file level, one per other node, strongest first. */
  links(id: string, target?: string): { out: Link[]; in: Link[] } {
    const fold = (edges: ReturnType<GraphIndex['out']>, end: 'source' | 'target') => {
      const byOther = new Map<string, Link>()
      for (const e of edges) {
        if (e.kind === 'co-changes' || (target && !e.targets.includes(target))) continue
        const other = e[end]
        const link = byOther.get(other) ?? { other, kinds: new Map(), targets: new Set() }
        link.kinds.set(e.kind, (link.kinds.get(e.kind) ?? 0) + e.count)
        e.targets.forEach(t => link.targets.add(t))
        byOther.set(other, link)
      }
      return [...byOther.values()].sort((a, b) => total(b) - total(a) || (a.other < b.other ? -1 : 1))
    }
    return { out: fold(this.index.out(id), 'target'), in: fold(this.index.in(id), 'source') }
  }

  /** Files that change in the same commits as this one, most often first; `depends` = a dependency either way. */
  coChanges(id: string): CoChangePartner[] {
    const partners: CoChangePartner[] = []
    for (const [e, other] of [...this.index.out(id).map(e => [e, e.target] as const), ...this.index.in(id).map(e => [e, e.source] as const)]) {
      if (e.kind !== 'co-changes') continue
      const linked = [...this.index.out(id).filter(x => x.target === other), ...this.index.in(id).filter(x => x.source === other)]
      partners.push({ other, commits: e.count, confidence: e.weight ?? 0, depends: linked.some(x => x.kind !== 'co-changes') })
    }
    return partners.sort((a, b) => b.commits - a.commits || b.confidence - a.confidence || (a.other < b.other ? -1 : 1))
  }

  /** Distinct file → file pairs for a target (the background arcs). */
  filePairs(target: string, visible: (id: string) => boolean): { source: string; target: string }[] {
    const seen = new Set<string>()
    const out: { source: string; target: string }[] = []
    for (const e of this.graph.edges) {
      if (e.kind === 'co-changes' || !e.targets.includes(target) || !visible(e.source) || !visible(e.target)) continue
      if (this.index.node(e.target)?.kind !== 'file') continue
      const key = `${e.source}\u0000${e.target}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ source: e.source, target: e.target })
    }
    return out
  }
}

export interface CoChangePartner {
  other: string
  /** Commits that changed both. */
  commits: number
  /** Share of the less often changed file's commits (0–1). */
  confidence: number
  /** Either file depends on the other (imports, calls, references …). */
  depends: boolean
}

export const total = (l: Link) => [...l.kinds.values()].reduce((a, b) => a + b, 0)

/** A file-level dependency graph as seen through the current filters. */
export interface DepGraph {
  key: string
  out: Map<string, string[]>
  in: Map<string, string[]>
  /** source → target → summed reference count */
  weight: Map<string, Map<string, number>>
}

export interface Module {
  index: number
  files: string[]
  /** The directory most of its files live in, and how many of them do. */
  mainDir: string
  share: number
  label: string
}

export interface Modules {
  key: string
  of: Map<string, number>
  list: Module[]
}

const memo = new WeakMap<World, { graph?: DepGraph; modules?: Modules }>()

/**
 * The dependency graph between visible files (and externals) over the given
 * edge kinds (none = all but mocks and co-changes) in one build target, plus
 * the dependencies through message topics (a subscriber's file on the
 * publishers' files, counted as `subscribes`). `key` identifies the filter
 * combination; the last graph is cached.
 */
export function depGraph(world: World, key: string, kinds: readonly string[], target: string, visible: (id: string) => boolean): DepGraph {
  const cache = memo.get(world) ?? {}
  memo.set(world, cache)
  if (cache.graph?.key === key) return cache.graph
  const allowed = kinds.length ? new Set(kinds) : null
  const out = new Map<string, string[]>()
  const inc = new Map<string, string[]>()
  const weight = new Map<string, Map<string, number>>()
  for (const e of world.graph.edges) {
    if (allowed ? !allowed.has(e.kind) : e.kind === 'mocks' || e.kind === 'co-changes') continue
    if (!e.targets.includes(target) || e.source === e.target || !visible(e.source) || !visible(e.target)) continue
    const w = weight.get(e.source) ?? new Map<string, number>()
    if (!w.has(e.target)) {
      push(out, e.source, e.target)
      push(inc, e.target, e.source)
    }
    w.set(e.target, (w.get(e.target) ?? 0) + e.count)
    weight.set(e.source, w)
  }
  // through a message topic: who listens depends on who sends (their events are its input), so services
  // that only meet at a Kafka topic are still linked in every view
  if (!allowed || allowed.has('subscribes')) {
    const ends = new Map<string, { pub: Set<string>; sub: Set<string> }>()
    for (const e of world.graph.edges) {
      if ((e.kind !== 'publishes' && e.kind !== 'subscribes') || !e.targets.includes(target) || !visible(e.source)) continue
      if (!world.index.node(e.target)?.tags?.includes('topic')) continue
      const t = ends.get(e.target) ?? { pub: new Set<string>(), sub: new Set<string>() }
      ;(e.kind === 'publishes' ? t.pub : t.sub).add(e.source)
      ends.set(e.target, t)
    }
    for (const { pub, sub } of ends.values())
      for (const s of sub)
        for (const p of pub) {
          if (s === p) continue
          const w = weight.get(s) ?? new Map<string, number>()
          if (!w.has(p)) {
            push(out, s, p)
            push(inc, p, s)
          }
          w.set(p, (w.get(p) ?? 0) + 1)
          weight.set(s, w)
        }
  }
  cache.graph = { key, out, in: inc, weight }
  return cache.graph
}

/** Files reachable from `start` along dependencies (out), dependents (in), or both. */
export function reachFrom(g: DepGraph, start: string[], dir: 'out' | 'in' | 'both', depth: number) {
  const max = depth > 0 ? depth : Infinity
  return {
    out: dir === 'in' ? new Map<string, { depth: number; via?: string }>() : reach(g.out, start, max),
    in: dir === 'out' ? new Map<string, { depth: number; via?: string }>() : reach(g.in, start, max),
  }
}

/** A dependency a selection's focus draws: `depth` steps out from the selection (1: one of its own files'), along dependencies (out) or dependents (in). */
export interface ReachEdge {
  source: string
  target: string
  depth: number
  dir: 'out' | 'in'
}

/**
 * The dependencies a selection's focus draws, from the files in `start`: every one between a start
 * file and a file outside them (a neighbor several start files share shows each one's), then one way
 * on to each file further out (the first found), up to `depth` steps (0: all). `reached`: the files
 * outside the start they reach; `first`: those one step out, dependencies before dependents.
 */
export function reachEdges(g: DepGraph, start: string[], dir: 'out' | 'in' | 'both', depth: number): { edges: ReachEdge[]; reached: Set<string>; first: string[] } {
  const r = reachFrom(g, start, dir, depth)
  const inStart = new Set(start)
  const edges: ReachEdge[] = []
  const reached = new Set<string>()
  const first: string[] = []
  const walk = (m: Map<string, { depth: number; via?: string }>, step: 'out' | 'in') => {
    const next = step === 'out' ? g.out : g.in
    for (const f of start) for (const t of next.get(f) ?? []) if (!inStart.has(t)) edges.push(step === 'out' ? { source: f, target: t, depth: 1, dir: 'out' } : { source: t, target: f, depth: 1, dir: 'in' })
    for (const [id, { depth: d, via }] of m) {
      if (!d || !via) continue
      reached.add(id)
      if (d === 1) first.push(id)
      else edges.push(step === 'out' ? { source: via, target: id, depth: d, dir: 'out' } : { source: id, target: via, depth: d, dir: 'in' })
    }
  }
  if (dir !== 'in') walk(r.out, 'out')
  if (dir !== 'out') walk(r.in, 'in')
  return { edges, reached, first }
}

/** Shortest dependency paths from a to b, or failing that from b to a. */
export function pathsBetween(g: DepGraph, a: string, b: string) {
  const forward = shortestPaths(g.out, a, b, 6)
  if (forward.length) return { paths: forward, reversed: false }
  return { paths: shortestPaths(g.out, b, a, 6), reversed: true }
}

/**
 * Modules found in the dependencies themselves (Louvain on the file graph,
 * references weighted by log count), labelled by the directory most of their
 * files share: comparing these with the folders shows where structure and
 * dependencies disagree.
 */
export function modules(world: World, g: DepGraph, files: string[]): Modules {
  const cache = memo.get(world) ?? {}
  memo.set(world, cache)
  const key = `${g.key}|${files.length}`
  if (cache.modules?.key === key) return cache.modules
  const edges: { source: string; target: string; weight: number }[] = []
  for (const [source, targets] of g.weight) for (const [target, count] of targets) edges.push({ source, target, weight: 1 + Math.log(count) })
  const of = louvain([...files].sort(), edges)
  const byModule = new Map<number, string[]>()
  for (const [f, m] of of) push(byModule, m, f)
  const list = [...byModule].map(([index, members]) => {
    const dirs = new Map<string, number>()
    for (const f of members) {
      const parent = world.node(f)?.parent ?? ''
      dirs.set(parent, (dirs.get(parent) ?? 0) + 1)
    }
    const [mainDir, count] = [...dirs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
    const share = count / members.length
    const path = world.node(mainDir)?.path || world.node(mainDir)?.name || mainDir
    const files = members.length === 1 ? '1 file' : `${members.length} files`
    return { index, files: members, mainDir, share, label: `${path} · ${files}${share < 1 ? ` (${Math.round(share * 100)}% there)` : ''}` }
  })
  list.sort((a, b) => a.index - b.index)
  cache.modules = { key, of, list }
  return cache.modules
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}
