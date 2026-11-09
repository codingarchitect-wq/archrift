// Bridges and questions worth asking, for init's first look (after graphify's
// report, but on archrift's file graph and with no LLM):
// - bridges: the production files the most shortest dependency paths between
//   two other files pass through (betweenness), that tie blocks together: a
//   change there ripples furthest;
// - questions: what the data points at but can't answer, one type at a time so
//   no type crowds out the rest: bridges, files that change together with no
//   dependency between them, much-used files that keep changing, files nothing
//   uses, blocks their dependencies split, and links guessed from names.
// Plain data in and out, deterministic.
import { betweenness, louvain, reach } from './algorithms.ts'
import { fileLinks } from './coherence.ts'
import { GraphIndex } from './graph-index.ts'
import type { Graph, GraphEdge, GraphNode } from './model.ts'

/**
 * The production code's file-level dependencies: coherence's `fileLinks` between
 * two of its files, navigations left out (a link to a page needs its URL, not
 * its code, and would make every linked page a bridge).
 */
export interface CodeGraph {
  /** The production code files, by path. */
  files: GraphNode[]
  byId: ReadonlyMap<string, GraphNode>
  /** File → the production files it depends on, sorted. */
  out: ReadonlyMap<string, string[]>
  /** File → the production files depending on it, sorted. */
  in: ReadonlyMap<string, string[]>
  /** File → how many test files depend on it. */
  tests: ReadonlyMap<string, number>
  /** The block of a production file, by id. */
  blockOf: (id: string) => string | undefined
}

export function codeGraph(graph: Graph, files: readonly GraphNode[], blockOf: (path: string) => string | undefined, index = new GraphIndex(graph)): CodeGraph {
  const sorted = [...files].sort((a, b) => cmp(a.path!, b.path!))
  const byId = new Map(sorted.map(f => [f.id, f]))
  const testIds = new Set(graph.nodes.filter(n => n.kind === 'file' && n.tags?.includes('test')).map(n => n.id))
  const out = new Map<string, string[]>()
  const into = new Map<string, string[]>()
  const tests = new Map<string, number>()
  for (const [a, b] of fileLinks({ ...graph, edges: graph.edges.filter(e => e.kind !== 'navigates') }, index)) {
    if (!byId.has(b)) continue
    if (byId.has(a)) {
      push(out, a, b)
      push(into, b, a)
    } else if (testIds.has(a)) tests.set(b, (tests.get(b) ?? 0) + 1)
  }
  for (const list of [...out.values(), ...into.values()]) list.sort()
  const block = new Map(sorted.map(f => [f.id, blockOf(f.path!)]))
  return { files: sorted, byId, out, in: into, tests, blockOf: id => block.get(id) }
}

export interface BlockCount {
  block: string
  files: number
}

export interface Bridge {
  path: string
  block: string
  /** Betweenness, normalized: the share of ordered pairs of other files whose shortest dependency paths run through it (0–1). */
  score: number
  /** Production files depending on it, and that it depends on. */
  fanIn: number
  fanOut: number
  /** The blocks with files depending on it, its own included, most files first. */
  above: BlockCount[]
  /** The blocks it depends on, its own included, most files first. */
  below: BlockCount[]
}

/** How many bridges the report lists. */
export const BRIDGES = 8

/**
 * The files the most shortest dependency paths pass through, among those that
 * connect two blocks other than their own or more (using them, used by them).
 */
export function bridgesOf(code: CodeGraph, isVendored: (path: string) => boolean, limit = BRIDGES): Bridge[] {
  const ids = code.files.map(f => f.id)
  const raw = betweenness(ids, code.out)
  const n = ids.length
  const scale = n > 2 ? 1 / ((n - 1) * (n - 2)) : 0
  return ids
    .filter(id => raw.get(id)! > 0 && !isVendored(code.byId.get(id)!.path!))
    .sort((a, b) => raw.get(b)! - raw.get(a)! || cmp(a, b))
    .map(id => bridgeOf(code, id, raw.get(id)! * scale))
    .filter(b => new Set([...b.above, ...b.below].map(c => c.block).filter(x => x !== b.block)).size >= 2)
    .slice(0, limit)
}

function bridgeOf(code: CodeGraph, id: string, score: number): Bridge {
  const block = code.blockOf(id) ?? '(root)'
  const users = code.in.get(id) ?? []
  const uses = code.out.get(id) ?? []
  return { path: code.byId.get(id)!.path!, block, score: Number(score.toPrecision(3)), fanIn: users.length, fanOut: uses.length, above: blockCounts(code, users), below: blockCounts(code, uses) }
}

function blockCounts(code: CodeGraph, ids: readonly string[]): BlockCount[] {
  const counts = new Map<string, number>()
  for (const id of ids) {
    const b = code.blockOf(id) ?? '(root)'
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  return [...counts].map(([block, files]) => ({ block, files })).sort((x, y) => y.files - x.files || cmp(x.block, y.block))
}

export type QuestionType = 'bridge' | 'hidden coupling' | 'risky hub' | 'unused file' | 'split block' | 'inferred link'

export interface Question {
  type: QuestionType
  /** The question, file and block names in backticks. */
  question: string
  /** What in the data asks it. */
  why: string
  /** The files it is about. */
  files: string[]
}

export const MAX_QUESTIONS = 7
/** Co-changing files with no dependency within this many steps either way are coupled out of sight. */
export const COUPLING_DEPTH = 3
/** A risky hub is among this many most-used production files and this many hotspots. */
export const HUB_TOP = 20
/** A block is split when its files fall into this many dependency modules of this many files each. */
export const SPLIT = { parts: 3, files: 3 } as const

export interface QuestionsInput {
  graph: Graph
  code: CodeGraph
  bridges: readonly Bridge[]
  isVendored: (path: string) => boolean
  index?: GraphIndex
}

/** At most MAX_QUESTIONS questions, the types taking turns. */
export function questionsOf(input: QuestionsInput): Question[] {
  const index = input.index ?? new GraphIndex(input.graph)
  return interleave(
    [bridgeQuestions(input.bridges), hiddenCoupling(input), riskyHubs(input), unusedFiles(input), splitBlocks(input), inferredLinks(input.graph, input.code, index)],
    MAX_QUESTIONS,
  )
}

/** Round-robin over the lists (first of each, then second of each …), each keeping its order, up to `cap`. */
export function interleave<T>(lists: readonly (readonly T[])[], cap: number): T[] {
  const out: T[] = []
  const longest = Math.max(0, ...lists.map(l => l.length))
  for (let i = 0; i < longest; i++)
    for (const list of lists) {
      if (out.length >= cap) return out
      if (i < list.length) out.push(list[i])
    }
  return out
}

/**
 * Bridges other blocks use, that use some block: why does the file tie them
 * together? Its own block counts below (a barrel ties its users to the files
 * beside it), not above.
 */
function bridgeQuestions(bridges: readonly Bridge[]): Question[] {
  return bridges
    .map(b => ({ b, users: b.above.filter(a => a.block !== b.block) }))
    .filter(({ b, users }) => users.length && b.below.length)
    .slice(0, MAX_QUESTIONS)
    .map(({ b, users }) => ({
      type: 'bridge',
      question: `Why does \`${b.path}\` connect ${names(users)} to ${names(b.below)}?`,
      why: `${percent(b.score)} of the shortest dependency paths between two other files run through it (betweenness ${b.score}); ${plural(b.fanIn, 'file')} ${b.fanIn === 1 ? 'uses' : 'use'} it, it uses ${b.fanOut}`,
      files: [b.path],
    }))
}

/**
 * Files that change together the most (co-changes), with no dependency between
 * them within a few steps. Twins (files of one name in the same two folders: a
 * translation, a platform's variant) make one question for the two folders.
 */
function hiddenCoupling({ graph, code, isVendored }: QuestionsInput): Question[] {
  const own = (id: string) => code.byId.has(id) && !isVendored(code.byId.get(id)!.path!)
  const pairs = graph.edges.filter(e => e.kind === 'co-changes' && own(e.source) && own(e.target)).sort(strongest)
  const out: Question[] = []
  for (const group of twinGroups(code, pairs)) {
    if (out.length >= MAX_QUESTIONS) break
    const loose = group.filter(e => !dependent(code, e.source, e.target))
    if (loose.length) out.push(loose.length > 1 ? twinsQuestion(code, loose) : couplingQuestion(code, loose[0]))
  }
  return out
}

/** The pairs in order, each group of twins where its strongest pair is. */
function twinGroups(code: CodeGraph, pairs: readonly GraphEdge[]): GraphEdge[][] {
  const groups: GraphEdge[][] = []
  const byFolders = new Map<string, GraphEdge[]>()
  for (const e of pairs) {
    const key = twinFolders(code, e)?.join('\0')
    const group = key === undefined ? undefined : byFolders.get(key)
    if (group) group.push(e)
    else groups.push(key === undefined ? [e] : byFolders.set(key, [e]).get(key)!)
  }
  return groups
}

/** The two folders, sorted, when the pair's files have one name in two folders. */
function twinFolders(code: CodeGraph, e: GraphEdge): [string, string] | undefined {
  const [a, b] = [code.byId.get(e.source)!.path!, code.byId.get(e.target)!.path!].map(p => [p.slice(0, p.lastIndexOf('/') + 1), p.slice(p.lastIndexOf('/') + 1)])
  if (a[1] !== b[1] || a[0] === b[0]) return undefined
  return [a[0].slice(0, -1) || '.', b[0].slice(0, -1) || '.'].sort() as [string, string]
}

function twinsQuestion(code: CodeGraph, twins: readonly GraphEdge[]): Question {
  const [x, y] = twinFolders(code, twins[0])!
  const name = (e: GraphEdge) => code.byId.get(e.source)!.name
  const shown = twins.slice(0, 3).map(e => `\`${name(e)}\` ${plural(e.count, 'commit')}`)
  return {
    type: 'hidden coupling',
    question: `Why do files in \`${x}\` change together with their namesakes in \`${y}\` (${twins.length} pairs) without depending on them?`,
    why: `${shown.join(', ')}${twins.length > 3 ? ` and ${twins.length - 3} more` : ''}; none depends on its namesake, not even through ${COUPLING_DEPTH - 1} other files`,
    files: twins.slice(0, 3).flatMap(e => [code.byId.get(e.source)!.path!, code.byId.get(e.target)!.path!]),
  }
}

const strongest = (a: GraphEdge, b: GraphEdge) => (b.weight ?? 0) - (a.weight ?? 0) || b.count - a.count || cmp(a.source, b.source) || cmp(a.target, b.target)

/** Does either file reach the other within COUPLING_DEPTH steps? */
const dependent = (code: CodeGraph, a: string, b: string) => reach(code.out, [a], COUPLING_DEPTH).has(b) || reach(code.out, [b], COUPLING_DEPTH).has(a)

function couplingQuestion(code: CodeGraph, e: GraphEdge): Question {
  const [x, y] = [code.byId.get(e.source)!.path!, code.byId.get(e.target)!.path!]
  return {
    type: 'hidden coupling',
    question: `Why do \`${x}\` and \`${y}\` change together (${plural(e.count, 'commit')}) without depending on each other?`,
    why: `${plural(e.count, 'commit')} changed both, ${percent(e.weight ?? 0)} of those of the one that changes less; neither depends on the other, not even through ${COUPLING_DEPTH - 1} other files`,
    files: [x, y],
  }
}

/** Files among the most used (production dependents) that are also among the hotspots, the most used first. */
function riskyHubs({ graph, code, isVendored }: QuestionsInput): Question[] {
  const fanIn = (f: GraphNode) => code.in.get(f.id)?.length ?? 0
  const files = code.files.filter(f => !isVendored(f.path!))
  const used = new Set(top(files, fanIn))
  return top(files, f => f.metrics?.hotspot ?? 0)
    .filter(f => used.has(f))
    .sort((a, b) => fanIn(b) - fanIn(a) || cmp(a.path!, b.path!))
    .map(f => hubQuestion(f, fanIn(f), graph.meta.history?.windowDays))
}

/** The HUB_TOP files with the highest value above 0, ties by path. */
const top = (files: readonly GraphNode[], value: (f: GraphNode) => number) =>
  files
    .filter(f => value(f) > 0)
    .sort((a, b) => value(b) - value(a) || cmp(a.path!, b.path!))
    .slice(0, HUB_TOP)

function hubQuestion(f: GraphNode, users: number, days = 90): Question {
  const m = f.metrics ?? {}
  return {
    type: 'risky hub',
    question: `\`${f.path}\` is used by ${plural(users, 'file')} and changed in ${plural(m.commits ?? 0, 'commit')}: is its interface settled?`,
    why: `among the ${HUB_TOP} most used production files and the ${HUB_TOP} hotspots: ${(m.churn ?? 0).toLocaleString('en-US')} lines changed in the last ${days} days, complexity ${m.complexity ?? 0}`,
    files: [f.path!],
  }
}

/** Configuration files: tools load them by name. */
const CONFIG = /(?:^|\/)(?:[^/]+\.config|\.[^/]+rc)\.[cm]?[jt]sx?$/
/** Tags of files a framework serves or calls: Next.js and Angular routes, HTTP handlers, tRPC procedures. */
const SERVED = /^(?:route|api|layout|template|default|loading|error|not-found|http|trpc):/

/**
 * The files a framework, the HTML page, a package script or the config loads:
 * entry points (config `entrypoints`, init's detection), files serving a route,
 * type declarations, and files declaring what a framework calls (a Spring
 * bean, an HTTP handler, a `main` function).
 */
export function entryPaths(graph: Graph): Set<string> {
  const out = new Set<string>()
  for (const n of graph.nodes) if (n.path && isEntry(n)) out.add(n.path)
  return out
}

const isEntry = (n: GraphNode) =>
  (n.tags ?? []).some(t => t === 'entrypoint' || t === 'declaration' || SERVED.test(t)) || (n.kind === 'symbol' && n.subkind === 'function' && n.name === 'main')

/** Production code no other production file depends on, that no framework loads: the largest first. */
function unusedFiles({ graph, code, isVendored }: QuestionsInput): Question[] {
  const entries = entryPaths(graph)
  return code.files
    .filter(f => !code.in.get(f.id)?.length && !entries.has(f.path!) && !CONFIG.test(f.path!) && !isVendored(f.path!))
    .sort((a, b) => (b.metrics?.loc ?? 0) - (a.metrics?.loc ?? 0) || cmp(a.path!, b.path!))
    .slice(0, MAX_QUESTIONS)
    .map(f => unusedQuestion(f, code.tests.get(f.id) ?? 0))
}

function unusedQuestion(f: GraphNode, tests: number): Question {
  const lines = plural(f.metrics?.loc ?? 0, 'line')
  return {
    type: 'unused file',
    question: `Is \`${f.path}\` still used? ${tests ? 'Only tests depend on it.' : 'Nothing depends on it.'}`,
    why: `${lines}; no production file imports or calls it${tests ? ` (only ${plural(tests, 'test file')})` : ''}, and no framework, page or script loads it`,
    files: [f.path!],
  }
}

/** Blocks whose files fall into SPLIT.parts dependency modules (Louvain over the production files) of SPLIT.files each, or more. */
function splitBlocks({ code, isVendored }: QuestionsInput): Question[] {
  const ids = code.files.map(f => f.id)
  const edges = [...code.out].flatMap(([source, targets]) => targets.map(target => ({ source, target })))
  const moduleOf = louvain(ids, edges)
  const byBlock = new Map<string, Map<number, string[]>>()
  for (const id of ids) {
    const block = code.blockOf(id)
    if (!block || block === '(root)') continue
    const modules = byBlock.get(block) ?? byBlock.set(block, new Map()).get(block)!
    push(modules, moduleOf.get(id)!, id)
  }
  return [...byBlock]
    .map(([block, modules]) => ({ block, files: [...modules.values()].flat().length, parts: [...modules.values()].filter(p => p.length >= SPLIT.files).sort((a, b) => b.length - a.length || cmp(a[0], b[0])) }))
    .filter(s => s.parts.length >= SPLIT.parts)
    .sort((a, b) => b.parts.length - a.parts.length || b.files - a.files || cmp(a.block, b.block))
    .slice(0, MAX_QUESTIONS)
    .map(s => splitQuestion(code, s, isVendored))
}

function splitQuestion(code: CodeGraph, s: { block: string; files: number; parts: string[][] }, isVendored: (path: string) => boolean): Question {
  const own = (p: string[]) => p.filter(id => !isVendored(code.byId.get(id)!.path!))
  const anchors = s.parts.map(p => mostUsed(code, own(p).length ? own(p) : p))
  const shown = s.parts.slice(0, 4).map((p, i) => `${p.length} around \`${anchors[i]}\``)
  return {
    type: 'split block',
    question: `Is \`${s.block}\` one block or ${s.parts.length}?`,
    why: `the dependencies split its ${plural(s.files, 'file')} into ${s.parts.length} groups of ${SPLIT.files} or more that use each other more than the rest: ${shown.join(', ')}${s.parts.length > 4 ? ` and ${s.parts.length - 4} more` : ''}`,
    files: anchors,
  }
}

/** The file of a group the most production files use (ties: the first by path). */
function mostUsed(code: CodeGraph, ids: readonly string[]): string {
  const fanIn = (id: string) => code.in.get(id)?.length ?? 0
  const best = [...ids].sort((a, b) => fanIn(b) - fanIn(a) || cmp(a, b))[0]
  return code.byId.get(best)!.path!
}

interface Guess {
  from: string
  to: string
  blocks: [string, string]
  kind: string
  subkind?: string
}

/**
 * Links guessed from names (`confidence: 'inferred'`: an HTTP call matched by
 * its URL, a link matched to a page …) between two production files of
 * different blocks: navigations last (a URL matched to a page is seldom
 * wrong); before that, the ones no exact dependency between their blocks
 * backs up first, then those between the blocks the fewest guesses link.
 */
function inferredLinks(graph: Graph, code: CodeGraph, index: GraphIndex): Question[] {
  const { exact, guessed } = linksAcross(graph, code, index)
  const pairs = new Map<string, number>()
  for (const g of guessed) pairs.set(blocksOf(g), (pairs.get(blocksOf(g)) ?? 0) + 1)
  const backed = (g: Guess) => exact.has(blocksOf(g))
  const doubt = (g: Guess) => [g.kind === 'navigates' ? 1 : 0, backed(g) ? 1 : 0, pairs.get(blocksOf(g))!]
  return guessed
    .sort((a, b) => byNumbers(doubt(a), doubt(b)) || cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind))
    .slice(0, MAX_QUESTIONS)
    .map(g => guessQuestion(g, !backed(g)))
}

const blocksOf = (g: Guess) => g.blocks.join('\0')

/** The first difference between two lists of numbers, as a comparator wants it. */
function byNumbers(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** The block pairs exact dependencies link, and the guessed links across blocks (one per two files and kind). */
function linksAcross(graph: Graph, code: CodeGraph, index: GraphIndex): { exact: Set<string>; guessed: Guess[] } {
  const exact = new Set<string>()
  const guessed = new Map<string, Guess>()
  for (const e of graph.edges) {
    const g = crossing(code, index, e)
    if (!g) continue
    const key = `${g.from}\0${g.to}\0${g.kind}`
    if (e.confidence === 'exact') exact.add(blocksOf(g))
    else if (!guessed.has(key)) guessed.set(key, g)
  }
  return { exact, guessed: [...guessed.values()] }
}

/** A dependency between two production files of different blocks, as a guess to ask about. */
function crossing(code: CodeGraph, index: GraphIndex, e: GraphEdge): Guess | undefined {
  if (e.kind === 'co-changes' || e.kind === 'mocks') return undefined
  const from = index.fileOf(e.source)?.id
  const to = index.fileOf(e.target)?.id
  const x = from && code.blockOf(from)
  const y = to && code.blockOf(to)
  if (!x || !y || x === y) return undefined
  return { from: code.byId.get(from!)!.path!, to: code.byId.get(to!)!.path!, blocks: [x, y], kind: e.kind, subkind: e.subkind }
}

const HOW: Record<string, (subkind?: string) => string> = {
  'http-call': s => `an HTTP call${s ? ` (${s})` : ''} matched to its handler by the URL`,
  navigates: s => `a link${s ? ` to ${s}` : ''} matched to the page that serves it`,
  queries: () => 'a database access matched by the table’s name',
  publishes: () => 'a message topic matched by its name',
  subscribes: () => 'a message topic matched by its name',
}

function guessQuestion(g: Guess, alone: boolean): Question {
  const how = HOW[g.kind]?.(g.subkind) ?? 'guessed from names, not from types'
  const [x, y] = g.blocks
  return {
    type: 'inferred link',
    question: `Is the inferred link \`${g.from}\` → \`${g.to}\` (${g.kind}) right?`,
    why: `${how}; ${alone ? `no other dependency links \`${x}\` to \`${y}\`` : `it links \`${x}\` to \`${y}\``}`,
    files: [g.from, g.to],
  }
}

/** `a`, `a` and `b`, `a`, `b` and `c`, `a`, `b`, `c` and 2 more. */
function names(blocks: readonly BlockCount[]): string {
  const shown = blocks.slice(0, 3).map(b => `\`${b.block}\``)
  if (blocks.length > 3) shown.push(`${blocks.length - 3} more`)
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0]
}

const percent = (share: number) => `${Number((share * 100).toPrecision(2))} %`
const plural = (x: number, one: string, many = `${one}s`) => `${x.toLocaleString('en-US')} ${x === 1 ? one : many}`

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
