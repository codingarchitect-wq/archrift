// Edge aggregation: lift symbol-level edges to their files or to
// the directory at a given depth, summing counts per kind. This is what keeps
// a large graph drawable: 400k symbol edges fold into a few hundred arcs.
import type { EdgeKind, GraphEdge, GraphNode } from './model.ts'
import type { GraphIndex } from './graph-index.ts'

export interface AggregatedEdge {
  source: string
  target: string
  kind: EdgeKind
  count: number
  targets: string[]
  /** How many underlying edges were folded into this one. */
  edges: number
}

export type LevelOf = (node: GraphNode) => string | undefined

export function liftEdges(index: GraphIndex, levelOf: LevelOf, filter: (e: GraphEdge) => boolean = () => true): AggregatedEdge[] {
  const lifted = new Map<string, AggregatedEdge>()
  const memo = new Map<string, string | undefined>()
  const lift = (id: string) => {
    if (!memo.has(id)) {
      const n = index.node(id)
      memo.set(id, n && levelOf(n))
    }
    return memo.get(id)
  }
  for (const e of index.graph.edges) {
    if (!filter(e)) continue
    const s = lift(e.source)
    const t = lift(e.target)
    if (s === undefined || t === undefined || s === t) continue
    const key = `${s}\u0000${t}\u0000${e.kind}`
    const a = lifted.get(key)
    if (a) {
      a.count += e.count
      a.edges++
      for (const tg of e.targets) if (!a.targets.includes(tg)) a.targets.push(tg)
    } else {
      lifted.set(key, { source: s, target: t, kind: e.kind, count: e.count, targets: [...e.targets], edges: 1 })
    }
  }
  return [...lifted.values()]
}

/** Lift to files; externals and directories stay themselves. */
export function fileLevel(index: GraphIndex): LevelOf {
  return n => (n.kind === 'symbol' || n.kind === 'member' ? index.fileOf(n.id)?.id : n.id)
}

/**
 * Lift to the directory `depth` levels below the root (root = 0). Files in a
 * shallower directory stay themselves, so they don't all collapse into the root.
 */
export function directoryLevel(index: GraphIndex, depth: number): LevelOf {
  const toFile = fileLevel(index)
  return n => {
    const id = toFile(n)
    const file = id === undefined ? undefined : index.node(id)
    if (!file || file.kind !== 'file') return id
    const dirs = index.ancestors(file.id).filter(a => a.kind === 'directory').reverse() // root first
    return dirs.length > depth ? dirs[depth].id : file.id
  }
}
