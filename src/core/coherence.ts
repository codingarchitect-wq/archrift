// Coherence, part 2 (docs/COHERENCE.md): how many ways the code does each job,
// after "Decoherence" (maevyn.codes/decoherence). The analyzer tags each file
// with the paradigms it uses per concern (`paradigm:<concern>=<paradigm>`).
// Per concern this measures:
//   - its ways, the main one (most files), and the coherence: the share of
//     its files on the main way alone;
//   - stragglers: files not on the main way; mixed: files on two ways or more
//     (where code translates between models);
//   - transitions: dependencies between two of its files with no way in
//     common, the article's color changes a change has to cross;
//   - the blocks (groups, folders) doing it more than one way: mixing inside a
//     block costs more than blocks each keeping their own way;
//   - its kind: one way; several, each block keeping to one (a choice per
//     service); or mixed, some block doing it several ways (the coherence
//     within blocks says how much);
//   - change: decoherence grows with change, not time, so whether the files
//     written recently (the newest fifth) kept to their block's main way
//     (converging) or not (spreading), and a migration's progress when one
//     way is marked legacy.
// A block's load is how many extra ways its files make a reader learn: Σ over
// concerns of (ways in the block − 1). Pure and deterministic.
import { GraphIndex } from './graph-index.ts'
import type { ConcernMeta, Graph, GraphNode } from './model.ts'

export const PARADIGM_TAG = 'paradigm:'

export interface ParadigmStats {
  id: string
  label: string
  legacy: boolean
  /** Files using it, sorted. */
  files: string[]
  loc: number
  /** Files using it written recently (first committed since the input's `since`). */
  added: string[]
  /** Median first commit of its files (unix seconds), when the history is known. */
  born?: number
}

export interface BlockMix {
  block: string
  /** Paradigm ids used in it, most files first (the first is the block's main way). */
  paradigms: string[]
  files: number
}

/**
 * one: a single way. per-block: several ways, but each block keeps to one (a
 * service on WebFlux beside services on Spring MVC). mixed: some block does it
 * several ways: the decoherence that costs.
 */
export type ConcernKind = 'one' | 'per-block' | 'mixed'

export type Trend =
  /** No history, or a single way. */
  | 'none'
  /** No file of it written recently. */
  | 'quiet'
  /** Every file written recently took its block's main way. */
  | 'converging'
  /** Some file written recently is off its block's main way. */
  | 'spreading'

export interface ConcernStats {
  concern: ConcernMeta
  kind: ConcernKind
  /** The ways in use, most files first. */
  paradigms: ParadigmStats[]
  /** Files doing the job at all. */
  users: number
  ways: number
  /** The way most files take. */
  main: ParadigmStats
  /** Share of its files on the main way alone (0–1); 1 with one way. */
  coherence: number
  /** Share of its files on their block's main way alone: what's left once blocks may differ. */
  local: number
  /** Files not on the main way. */
  stragglers: string[]
  /** Files not on their block's main way alone (mixed ones included). */
  strays: string[]
  /** Files on two ways or more. */
  mixed: string[]
  /** e^entropy of the ways' shares: 1 for one way, 2 for two even halves. */
  effective: number
  /** Dependencies between two of its files with no way in common: [from, to]. */
  transitions: [string, string][]
  /** Dependencies between two of its files. */
  links: number
  /** Blocks doing it, the ones mixing ways first. */
  blocks: BlockMix[]
  mixedBlocks: number
  /** Files written recently, and those of them off their block's main way. */
  fresh: string[]
  freshStrays: string[]
  trend: Trend
  /** One way marked legacy and another not: how far the move is. */
  migration?: { from: string[]; to: string; done: number; left: string[] }
  /** Without a legacy mark: the way whose files are youngest (history), when it isn't the main one. */
  newest?: string
}

export interface BlockLoad {
  block: string
  files: number
  /** Σ (ways in the block − 1) over the concerns it does several ways (accepted ones left out). */
  load: number
  /** Those concerns: id → ways in the block. */
  concerns: { id: string; ways: number }[]
}

export interface CoherenceModel {
  /** Mixed concerns (least coherent within blocks first), then per-block, accepted and single-way ones. */
  concerns: ConcernStats[]
  byId: Map<string, ConcernStats>
  /** File → concern → the ways it takes. */
  ways: Map<string, Map<string, string[]>>
  /** File → concerns where it is off its block's main way (accepted concerns left out). */
  strays: Map<string, string[]>
  blocks: BlockLoad[]
  /** What counts as recent work (unix seconds), when the history is known. */
  since?: number
  totals: {
    concerns: number
    /** One way. */
    coherent: number
    /** Several ways, each block one. */
    perBlock: number
    /** Some block several ways, not accepted. */
    decoherent: number
    accepted: number
    /** Files off their block's main way in some concern that isn't accepted. */
    strays: number
    /** Files that do some concern's job. */
    users: number
  }
}

export interface CoherenceInput {
  /** Files (with tags and metrics) and the concerns found (graph meta). */
  files: readonly GraphNode[]
  concerns: readonly ConcernMeta[]
  /** File-level dependencies: [from, to]. */
  links: Iterable<readonly [string, string]>
  /** The block a file belongs to (a group, a top folder); without one, all files are one block. */
  blockOf?: (file: GraphNode) => string | undefined
  /** Files first committed after this (unix seconds) are recent work (recentSince); without it, no trend. */
  since?: number
}

/** Paradigm ids per concern on a file, from its tags. */
export function paradigmsOf(n: GraphNode): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const t of n.tags ?? []) {
    if (!t.startsWith(PARADIGM_TAG)) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const c = t.slice(PARADIGM_TAG.length, eq)
    out.set(c, [...(out.get(c) ?? []), t.slice(eq + 1)])
  }
  return out
}

const NO_BLOCK = '\0'

export function coherenceModel(input: CoherenceInput): CoherenceModel {
  const ways = new Map<string, Map<string, string[]>>()
  const nodeOf = new Map<string, GraphNode>()
  const blockOf = new Map<string, string>()
  for (const f of input.files) {
    const p = paradigmsOf(f)
    if (!p.size) continue
    ways.set(f.id, p)
    nodeOf.set(f.id, f)
    blockOf.set(f.id, input.blockOf?.(f) ?? NO_BLOCK)
  }
  const isFresh = (id: string) => input.since !== undefined && (nodeOf.get(id)!.metrics?.firstCommit ?? -Infinity) > input.since
  // dependencies between files that do some concern's job
  const links: [string, string][] = []
  const seen = new Set<string>()
  for (const [a, b] of input.links) {
    if (a === b || !ways.has(a) || !ways.has(b)) continue
    const k = `${a}\0${b}`
    if (seen.has(k)) continue
    seen.add(k)
    links.push([a, b])
  }
  links.sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]))

  const stats: ConcernStats[] = []
  for (const concern of input.concerns) {
    const users = [...ways].filter(([, m]) => m.has(concern.id)).map(([id]) => id).sort(cmp)
    if (!users.length) continue
    const order = new Map(concern.paradigms.map((p, i) => [p.id, i]))
    const waysOf = (id: string) => ways.get(id)!.get(concern.id)!
    const byWay = new Map<string, string[]>()
    for (const id of users) for (const w of waysOf(id)) byWay.set(w, [...(byWay.get(w) ?? []), id])
    const paradigms: ParadigmStats[] = [...byWay]
      .map(([id, files]) => {
        const meta = concern.paradigms.find(p => p.id === id)
        const nodes = files.map(f => nodeOf.get(f)!)
        const born = nodes.map(n => n.metrics?.firstCommit).filter((t): t is number => t !== undefined).sort((a, b) => a - b)
        return {
          id,
          label: meta?.label ?? id,
          legacy: !!meta?.legacy,
          files,
          loc: nodes.reduce((s, n) => s + (n.metrics?.loc ?? 0), 0),
          added: files.filter(isFresh),
          ...(born.length ? { born: born[Math.floor((born.length - 1) / 2)] } : {}),
        }
      })
      // most files first; between equals, a newer way before a legacy one, then the catalog's order
      .sort((a, b) => b.files.length - a.files.length || Number(a.legacy) - Number(b.legacy) || (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
    const rankOf = new Map(paradigms.map((p, i) => [p.id, i]))
    const main = paradigms[0]
    const onMain = new Set(main.files)
    const stragglers = users.filter(id => !onMain.has(id))
    const mixed = users.filter(id => waysOf(id).length > 1)
    const pure = users.filter(id => onMain.has(id) && waysOf(id).length === 1).length
    const total = paradigms.reduce((s, p) => s + p.files.length, 0)
    const entropy = -paradigms.reduce((s, p) => s + (p.files.length / total) * Math.log(p.files.length / total), 0)

    // blocks: the ways each one takes, its main way first
    const inBlock = new Map<string, { files: string[]; count: Map<string, number> }>()
    for (const id of users) {
      const block = blockOf.get(id)!
      const b = inBlock.get(block) ?? { files: [], count: new Map<string, number>() }
      b.files.push(id)
      for (const w of waysOf(id)) b.count.set(w, (b.count.get(w) ?? 0) + 1)
      inBlock.set(block, b)
    }
    const mainIn = new Map<string, string>()
    const blocks: BlockMix[] = []
    for (const [block, b] of inBlock) {
      const ranked = [...b.count].sort((x, y) => y[1] - x[1] || rankOf.get(x[0])! - rankOf.get(y[0])!).map(([w]) => w)
      mainIn.set(block, ranked[0])
      if (block !== NO_BLOCK) blocks.push({ block, files: b.files.length, paradigms: ranked })
    }
    blocks.sort((a, b) => b.paradigms.length - a.paradigms.length || b.files - a.files || cmp(a.block, b.block))
    const strays = users.filter(id => {
      const w = waysOf(id)
      return w.length > 1 || w[0] !== mainIn.get(blockOf.get(id)!)
    })
    const mixedBlocks = [...inBlock.values()].filter(b => b.count.size > 1).length
    const kind: ConcernKind = paradigms.length === 1 ? 'one' : mixedBlocks ? 'mixed' : 'per-block'

    const transitions: [string, string][] = []
    let linked = 0
    for (const [a, b] of links) {
      const wa = ways.get(a)!.get(concern.id)
      const wb = ways.get(b)!.get(concern.id)
      if (!wa || !wb) continue
      linked++
      if (!wa.some(w => wb.includes(w))) transitions.push([a, b])
    }

    // change: the ways files written recently took
    const fresh = users.filter(isFresh)
    const strayed = new Set(strays)
    const freshStrays = fresh.filter(id => strayed.has(id))
    const trend: Trend = input.since === undefined || paradigms.length === 1 ? 'none' : !fresh.length ? 'quiet' : freshStrays.length ? 'spreading' : 'converging'
    const legacy = paradigms.filter(p => p.legacy)
    const modern = paradigms.filter(p => !p.legacy)
    let migration: ConcernStats['migration']
    if (legacy.length && modern.length) {
      const left = [...new Set(legacy.flatMap(p => p.files))].sort(cmp)
      migration = { from: legacy.map(p => p.id), to: modern[0].id, done: 1 - left.length / users.length, left }
    }
    let newest: string | undefined
    if (!migration && paradigms.length > 1 && paradigms.every(p => p.born !== undefined)) {
      const young = [...paradigms].sort((a, b) => b.born! - a.born! || cmp(a.id, b.id))[0]
      if (young !== main) newest = young.id
    }

    stats.push({
      concern,
      kind,
      paradigms,
      users: users.length,
      ways: paradigms.length,
      main,
      coherence: pure / users.length,
      local: 1 - strays.length / users.length,
      stragglers,
      strays,
      mixed,
      effective: Math.exp(entropy),
      transitions,
      links: linked,
      blocks,
      mixedBlocks,
      fresh,
      freshStrays,
      trend,
      ...(migration ? { migration } : {}),
      ...(newest ? { newest } : {}),
    })
  }
  // mixed (not accepted, then accepted), least coherent within blocks first; per-block; one way, most files first
  const rank = (c: ConcernStats) => (c.kind === 'mixed' ? (c.concern.accepted ? 2 : 0) : c.kind === 'per-block' ? (c.concern.accepted ? 2 : 1) : 3)
  stats.sort((a, b) => rank(a) - rank(b) || a.local - b.local || a.coherence - b.coherence || b.users - a.users || cmp(a.concern.id, b.concern.id))

  const counted = stats.filter(c => c.kind === 'mixed' && !c.concern.accepted)
  const strays = new Map<string, string[]>()
  for (const c of counted) for (const id of c.strays) strays.set(id, [...(strays.get(id) ?? []), c.concern.id])

  const blockLoads = new Map<string, BlockLoad>()
  for (const id of ways.keys()) {
    const block = blockOf.get(id)!
    if (block === NO_BLOCK) continue
    const l = blockLoads.get(block) ?? { block, files: 0, load: 0, concerns: [] }
    l.files++
    blockLoads.set(block, l)
  }
  for (const c of counted)
    for (const b of c.blocks) {
      if (b.paradigms.length < 2) continue
      const l = blockLoads.get(b.block)!
      l.load += b.paradigms.length - 1
      l.concerns.push({ id: c.concern.id, ways: b.paradigms.length })
    }

  return {
    concerns: stats,
    byId: new Map(stats.map(c => [c.concern.id, c])),
    ways,
    strays,
    blocks: [...blockLoads.values()].sort((a, b) => b.load - a.load || b.files - a.files || cmp(a.block, b.block)),
    ...(input.since !== undefined ? { since: input.since } : {}),
    totals: {
      concerns: stats.length,
      coherent: stats.filter(c => c.kind === 'one').length,
      perBlock: stats.filter(c => c.kind === 'per-block' && !c.concern.accepted).length,
      decoherent: counted.length,
      accepted: stats.filter(c => c.kind !== 'one' && c.concern.accepted).length,
      strays: strays.size,
      users: ways.size,
    },
  }
}

/**
 * What counts as recent work: the newest fifth of the files by first commit.
 * Its start is the first commit at the 80th percentile, and files first
 * committed after it are recent; a bulk import (many files in one commit) at
 * that point stays old. Relative, so a project that went quiet a year ago
 * still has a recent past. Undefined without history.
 */
export function recentSince(files: readonly GraphNode[]): number | undefined {
  const born = files.map(f => f.metrics?.firstCommit).filter((t): t is number => t !== undefined).sort((a, b) => a - b)
  return born.length ? born[Math.floor((born.length - 1) * 0.8)] : undefined
}

/** File-level dependencies of a graph (any dependency kind, lifted to the files at both ends; co-change and mocks left out). */
export function fileLinks(graph: Graph, index = new GraphIndex(graph)): [string, string][] {
  const out: [string, string][] = []
  const seen = new Set<string>()
  for (const e of graph.edges) {
    if (e.kind === 'co-changes' || e.kind === 'mocks') continue
    const a = index.fileOf(e.source)?.id
    const b = index.fileOf(e.target)?.id
    if (!a || !b || a === b) continue
    const k = `${a}\0${b}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push([a, b])
  }
  return out
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Blocks by folder, for a graph without groups: from the root down through
 * folders holding nearly all files (80 %), to the folder where the code
 * splits; its subfolders are the blocks, files beside the way down count for
 * their own folder.
 */
export function folderBlocks(paths: readonly string[]): (path: string) => string | undefined {
  let prefix = ''
  for (;;) {
    const under = paths.filter(p => p.startsWith(prefix))
    const counts = new Map<string, number>()
    for (const p of under) {
      const rest = p.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash > 0) counts.set(rest.slice(0, slash), (counts.get(rest.slice(0, slash)) ?? 0) + 1)
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]
    if (!top || top[1] < under.length * 0.8 || counts.size === 0) break
    prefix += `${top[0]}/`
  }
  return path => {
    if (!path.startsWith(prefix)) {
      const slash = path.indexOf('/')
      return slash > 0 ? path.slice(0, slash) : '(root)'
    }
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    return slash > 0 ? prefix + rest.slice(0, slash) : prefix ? prefix.slice(0, -1) : '(root)'
  }
}
