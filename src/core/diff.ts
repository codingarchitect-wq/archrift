// What a change does to the architecture (`archrift diff`, docs/QUERY.md): two
// analyses of the same project, before and after, compared on what reviewers
// can't see in a diff of lines: the rules it breaks or mends (and the limits
// already broken that it breaks further: a function past its complexity
// limit that grows), the import
// cycles it makes or ends, the jobs it starts doing another way (and the files
// that now differ from their block, or no longer do), and the blocks that
// start or stop depending on each other. A file leaving a legacy way for the
// newer one is progress, not a deviation. And what the change's imports
// bring into the entry points (reach.ts): one import line can make every page
// load dozens of files. And the places in documents kept current that name
// code the change removes or reshapes (core/docs.ts). Pure: the CLI analyzes
// and formats.
import type { CoherenceModel, ConcernStats } from './coherence.ts'
import { fileLinks } from './coherence.ts'
import { surfaceOf } from './descriptions.ts'
import { staleDocs } from './docs.ts'
import type { StaleDoc } from './docs.ts'
import { GraphIndex } from './graph-index.ts'
import type { Graph } from './model.ts'
import { violationKey } from './query.ts'
import { reachDiff } from './reach.ts'
import type { ReachDiff } from './reach.ts'
import type { Violation } from './rules.ts'

export interface DiffSide {
  graph: Graph
  coherence: CoherenceModel
}

export interface DiffInput {
  base: DiffSide
  head: DiffSide
  /** Any path's block, the same for both sides (the head's). */
  blockOf: (path: string) => string | undefined
  /** Paths the change touches (added, changed, removed), when known: their findings are marked. */
  touched?: readonly string[]
}

export interface Deviation {
  path: string
  /** The ways it takes now (labels). */
  ways: string[]
  block: string
  /** Its block's main way (label), and files taking it. */
  blockWay: string
  examples: string[]
  touched: boolean
}

export interface JobChange {
  id: string
  label: string
  stack: string
  about: string
  accepted?: string
  /** How it was done before and after (absent: not done at all). */
  before?: { kind: ConcernStats['kind']; ways: string[]; local: number }
  after?: { kind: ConcernStats['kind']; ways: string[]; local: number }
  /** Ways that appear or disappear (labels). */
  newWays: string[]
  goneWays: string[]
  /** Files that now differ from their block's way, and those that no longer do. */
  deviations: Deviation[]
  resolved: string[]
  /** Files that left a legacy way for a newer one, or were written the newer way where the block is still legacy. */
  progress: { path: string; from: string[]; to: string[] }[]
}

export interface ArchitectureDiff {
  files: { added: string[]; removed: string[] }
  /**
   * Violations that appear or go; limits broken on both sides that the change breaks further (a
   * function over its complexity limit that grows), before and after; and rules the change leaves
   * matching nothing (a folder renamed under them), with what no longer matches.
   */
  rules: { added: Violation[]; grew: { before: Violation; after: Violation }[]; fixed: Violation[]; unmatched: { rule: string; severity: 'error' | 'warn'; parts: string[] }[] }
  cycles: { added: string[][]; fixed: string[][] }
  jobs: JobChange[]
  /** Blocks that start or stop depending on each other (production code), with one dependency that does it. */
  blocks: { added: { from: string; to: string; via: [string, string] }[]; removed: { from: string; to: string }[] }
  /** Imports that bring files or packages into entry points that didn't load them, and gone ones that take them out. */
  reach: ReachDiff
  /** Places in documents kept current that name code the change removes or whose exports or signature change. */
  docs: StaleDoc[]
}

/** Examples of the block's way a deviation lists. */
const EXAMPLES = 2

export function diffArchitecture(input: DiffInput): ArchitectureDiff {
  const { base, head } = input
  const pathOf = (id: string) => (id.startsWith('f:') ? id.slice(2) : id)
  const touched = new Set(input.touched ?? [])
  const filesOf = (g: Graph) => new Set(g.nodes.filter(n => n.kind === 'file').map(n => n.path!))
  const [before, after] = [filesOf(base.graph), filesOf(head.graph)]

  // rules: by rule and ends, so a violation that stays is the same one on both sides
  const keyed = (vs: Violation[] | undefined) => new Map((vs ?? []).map(v => [violationKey(v), v]))
  const [vb, vh] = [keyed(base.graph.meta.violations), keyed(head.graph.meta.violations)]
  const unmatchedBefore = new Map((base.graph.meta.rules ?? []).map(r => [r.name, new Set(r.unmatched)]))
  const unmatched = (head.graph.meta.rules ?? [])
    .map(r => ({ rule: r.name, severity: r.severity, parts: (r.unmatched ?? []).filter(u => !unmatchedBefore.get(r.name)?.has(u)) }))
    .filter(r => r.parts.length)
  const cycleKey = (c: string[]) => [...c].sort().join('\0')
  const [cb, ch] = [new Set(base.graph.meta.cycles.map(cycleKey)), new Set(head.graph.meta.cycles.map(cycleKey))]

  // jobs
  const ids = [...new Set([...base.coherence.concerns, ...head.coherence.concerns].map(s => s.concern.id))]
  const jobs: JobChange[] = []
  for (const id of ids) {
    const b = base.coherence.byId.get(id)
    const h = head.coherence.byId.get(id)
    const s = (h ?? b)!
    const labelOf = (id: string) => (h ?? b)!.paradigms.find(p => p.id === id)?.label ?? b?.paradigms.find(p => p.id === id)?.label ?? id
    const legacy = (id: string) => !!(h?.paradigms.find(p => p.id === id)?.legacy ?? b?.paradigms.find(p => p.id === id)?.legacy)
    const waysIn = (m: CoherenceModel, file: string) => m.ways.get(file)?.get(id) ?? []
    const newWays = (h?.paradigms ?? []).filter(p => !b?.paradigms.some(q => q.id === p.id)).map(p => p.label)
    const goneWays = (b?.paradigms ?? []).filter(p => !h?.paradigms.some(q => q.id === p.id)).map(p => p.label)

    const wasStray = new Set(b?.strays ?? [])
    const deviations: Deviation[] = []
    const progress: JobChange['progress'] = []
    for (const file of h?.strays ?? []) {
      const now = waysIn(head.coherence, file)
      const then = waysIn(base.coherence, file)
      if (wasStray.has(file) && now.join() === then.join()) continue // nothing new about it
      const block = input.blockOf(pathOf(file)) ?? ''
      const main = h!.blocks.find(x => x.block === block)?.paradigms[0]
      // the newer way where the block keeps a legacy one: progress
      if (main && legacy(main) && now.every(w => !legacy(w))) {
        progress.push({ path: pathOf(file), from: then.map(labelOf), to: now.map(labelOf) })
        continue
      }
      const examples = (h!.paradigms.find(p => p.id === main)?.files ?? [])
        .filter(f => f !== file && input.blockOf(pathOf(f)) === block && waysIn(head.coherence, f).join() === main)
        .map(pathOf)
        .slice(0, EXAMPLES)
      deviations.push({ path: pathOf(file), ways: now.map(labelOf), block, blockWay: main ? labelOf(main) : '', examples, touched: touched.has(pathOf(file)) })
    }
    // files that left a legacy way while their block hasn't (not strays before or after)
    for (const p of b?.paradigms ?? [])
      if (p.legacy)
        for (const file of p.files) {
          const now = waysIn(head.coherence, file)
          if (now.length && now.every(w => !legacy(w)) && !progress.some(x => x.path === pathOf(file)))
            progress.push({ path: pathOf(file), from: waysIn(base.coherence, file).map(labelOf), to: now.map(labelOf) })
        }
    const isStray = new Set(h?.strays ?? [])
    const resolved = [...wasStray].filter(f => !isStray.has(f)).map(pathOf).filter(p => !progress.some(x => x.path === p))
    const side = (x: ConcernStats | undefined) => x && { kind: x.kind, ways: x.paradigms.map(p => p.label), local: x.local }
    const changed = newWays.length || goneWays.length || deviations.length || resolved.length || progress.length || b?.kind !== h?.kind
    if (!changed) continue
    jobs.push({
      id,
      label: s.concern.label,
      stack: s.concern.stack,
      about: s.concern.about,
      ...(s.concern.accepted ? { accepted: s.concern.accepted } : {}),
      ...(b ? { before: side(b) } : {}),
      ...(h ? { after: side(h) } : {}),
      newWays,
      goneWays,
      deviations,
      resolved,
      progress,
    })
  }
  // the ones with something to look at first: deviations, new ways
  jobs.sort((x, y) => y.deviations.length - x.deviations.length || y.newWays.length - x.newWays.length || (x.id < y.id ? -1 : 1))

  // blocks that start or stop depending on each other
  const blockPairs = (g: Graph) => {
    const prod = new Set(g.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test')).map(n => n.id))
    const pairs = new Map<string, [string, string]>()
    for (const [a, b] of fileLinks(g)) {
      if (!prod.has(a) || !prod.has(b)) continue
      const x = input.blockOf(pathOf(a))
      const y = input.blockOf(pathOf(b))
      if (!x || !y || x === y) continue
      const k = `${x}\0${y}`
      if (!pairs.has(k)) pairs.set(k, [pathOf(a), pathOf(b)])
    }
    return pairs
  }
  const [pb, ph] = [blockPairs(base.graph), blockPairs(head.graph)]

  return {
    // new and removed files; with the touched paths known, only those (a generated, ignored file isn't the change's)
    files: {
      added: [...after].filter(p => !before.has(p) && (!input.touched || touched.has(p))).sort(),
      removed: [...before].filter(p => !after.has(p) && (!input.touched || touched.has(p))).sort(),
    },
    rules: {
      added: [...vh].filter(([k]) => !vb.has(k)).map(([, v]) => v),
      grew: [...vh].flatMap(([k, after]) => {
        const before = vb.get(k)
        return before?.measure && after.measure && (after.measure.bound === 'max' ? after.measure.value > before.measure.value : after.measure.value < before.measure.value) ? [{ before, after }] : []
      }),
      fixed: [...vb].filter(([k]) => !vh.has(k)).map(([, v]) => v),
      unmatched,
    },
    cycles: { added: head.graph.meta.cycles.filter(c => !cb.has(cycleKey(c))), fixed: base.graph.meta.cycles.filter(c => !ch.has(cycleKey(c))) },
    jobs,
    blocks: {
      added: [...ph].filter(([k]) => !pb.has(k)).map(([k, via]) => ({ from: k.split('\0')[0], to: k.split('\0')[1], via })),
      removed: [...pb.keys()].filter(k => !ph.has(k)).map(k => ({ from: k.split('\0')[0], to: k.split('\0')[1] })),
    },
    reach: reachDiff(base.graph, head.graph, input.touched),
    docs: docsToCheck(base.graph, head.graph, [...before].filter(p => !after.has(p)), input.touched),
  }
}

/** The places in current documents naming what the change removes or reshapes (only touched files, when known). */
function docsToCheck(base: Graph, head: Graph, removed: string[], touched?: readonly string[]): StaleDoc[] {
  if (!head.meta.docs && !base.meta.docs) return []
  const [b, h] = [new GraphIndex(base), new GraphIndex(head)]
  const changed = touched ? new Set(touched) : undefined
  const inChange = (node: string, index: GraphIndex) => {
    const path = index.node(node)?.path
    return !!path && (!changed || changed.has(path) || [...changed].some(p => p.startsWith(`${path}/`)))
  }
  return staleDocs(base.meta.docs, head.meta.docs, {
    removed: changed ? removed.filter(p => changed.has(p)) : removed,
    gone: node => !!b.node(node) && !h.node(node) && inChange(node, b),
    reshaped: node => !!b.node(node) && !!h.node(node) && inChange(node, h) && surfaceOf(b, node) !== surfaceOf(h, node),
  })
}
