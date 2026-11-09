// Questions asked about the code before changing it (`archrift query`, an
// agent's or a person's; docs/QUERY.md): how a place does each job and which
// way to follow, which rules hold for it, whether a new dependency would break
// one, how two parts connect, one file at a glance, and which functions are
// riskiest to change (CRAP, with the last coverage run). Answers come from an
// analyzed graph, its coherence and the config's rules. A path no file has yet
// (one about to be written) is answered from where it would be: its block, its
// layer, the rules its path matches. Pure: the CLI analyzes and formats.
import { shortestPaths } from './algorithms.ts'
import type { CoherenceModel, ConcernStats } from './coherence.ts'
import { byRisk, functionRisk } from './crap.ts'
import { docsNaming, findDoc, findId, idsCitedBy } from './docs.ts'
import type { CitedId, DocMeta, DocRef, IdMeta } from './docs.ts'
import type { CoverageSource, FunctionRisk } from './crap.ts'
import { GraphIndex } from './graph-index.ts'
import { dirId, fileId, npmId, packageName } from './ids.ts'
import { DEPENDENCY_KINDS } from './model.ts'
import type { Graph, GraphEdge, GraphNode, Sites } from './model.ts'
import type { Description, ResolvedDescriptions } from './descriptions.ts'
import { evaluateRules, importCycles, isFunction, partOf, selector, symbolWords } from './rules.ts'
import type { Rule, RuleKind, Selector, Violation } from './rules.ts'

export interface QueryInput {
  graph: Graph
  coherence: CoherenceModel
  /** Any path's block (as the coherence has them), whether a file has it or not. */
  blockOf: (path: string) => string | undefined
  /** The tags a file at a path gets from the config (test, entrypoint, layer:, group:). */
  tagsFor: (path: string) => string[]
  rules: readonly Rule[]
  /** The last coverage run (`coverage/coverage-final.json`), for CRAP; without it, functions rank by complexity. */
  coverage?: CoverageSource
  /** The names and descriptions written for the code (`archrift describe`). */
  descriptions?: ResolvedDescriptions
}

/** What a path (or id, or file name) given to a question stands for. */
export type Place =
  | { kind: 'file'; path: string; id: string }
  | { kind: 'folder'; path: string; files: string[] }
  /** No file there yet: answered from where it would be. */
  | { kind: 'new'; path: string }
  | { kind: 'external'; path: string; id: string }
  /** Several files have that name: which one? */
  | { kind: 'ambiguous'; path: string; candidates: string[] }
  | { kind: 'missing'; path: string }

/** Most candidates an ambiguous name lists. */
const CANDIDATES = 10
/** Files an answer gives as examples to follow. */
const EXAMPLES = 3

export class Query {
  readonly input: QueryInput
  readonly index: GraphIndex
  private readonly files: GraphNode[]
  private violationsCache?: Violation[]
  /** A file → the files depending on it (impact), with how. */
  private dependentsCache?: Map<string, Map<string, Link>>

  constructor(input: QueryInput) {
    this.input = input
    this.index = new GraphIndex(input.graph)
    this.files = input.graph.nodes.filter(n => n.kind === 'file')
  }

  /**
   * A file path, a folder, an id (`f:`, `s:`, `x:`) or a file name that's unique
   * (`api-client.ts`, `api-client`), or a package (`@tanstack/react-query`, `lodash/fp`).
   * A path with a slash or an extension that nothing has is a new file.
   */
  place(ref: string): Place {
    const p = ref.trim().replace(/^\.\//, '').replace(/\/+$/, '')
    if (p === '' || p === '.') return { kind: 'folder', path: '', files: this.files.map(f => f.id) }
    if (p.startsWith('x:')) return { kind: 'external', path: p, id: p }
    if (p.startsWith('s:') || p.startsWith('f:')) {
      const file = this.index.fileOf(p)
      return file ? { kind: 'file', path: file.path!, id: file.id } : { kind: 'missing', path: p }
    }
    if (this.index.node(fileId(p))?.kind === 'file') return { kind: 'file', path: p, id: fileId(p) }
    const under = this.files.filter(f => f.path!.startsWith(`${p}/`))
    if (under.length) return { kind: 'folder', path: p, files: under.map(f => f.id) }
    const named = this.files.filter(f => f.path!.endsWith(`/${p}`) || stem(f.path!) === p || stem(f.path!).endsWith(`/${p}`))
    if (named.length === 1) return { kind: 'file', path: named[0].path!, id: named[0].id }
    if (named.length > 1) return { kind: 'ambiguous', path: p, candidates: named.map(f => f.path!).sort().slice(0, CANDIDATES) }
    // a package: scoped, or a bare name whose first part is no folder of the project
    const top = p.split('/')[0]
    if (p.startsWith('@') || (!/\.\w+$/.test(p) && p.includes('/') && !this.files.some(f => f.path!.startsWith(`${top}/`)))) return { kind: 'external', path: p, id: npmId(packageName(p)) }
    if (p.includes('/') || /\.\w+$/.test(p)) return { kind: 'new', path: p }
    return { kind: 'missing', path: p }
  }

  // ── ways ─────────────────────────────────────────────────────────────────

  /**
   * How the place does each job (all it does, or those `job` names), and the way
   * to follow: its block's main way, or, when that is legacy, the newer one the
   * project moves to. Without `job`, also the jobs the project does elsewhere.
   */
  ways(place: Place, job?: string): WaysAnswer {
    const c = this.input.coherence
    const here = this.filesAt(place)
    const blocks = this.blocksAt(place)
    const tests = place.kind === 'file' || place.kind === 'new' ? this.input.tagsFor(place.path).includes('test') : here.some(id => this.tagsOf(id).includes('test'))
    const inBlocks = (s: ConcernStats) => s.paradigms.some(p => p.files.some(f => blocks.includes(this.blockOfId(f) ?? '')))
    const concerns = job ? findJobs(c, job) : c.concerns.filter(s => inBlocks(s) && (tests || !s.concern.tests))
    const jobs = concerns.map(s => this.job(s, place, blocks, here))
    return { place, blocks, jobs, elsewhere: this.otherJobs(concerns, job) }
  }

  /** Besides the jobs answered: without a job asked, the others the project does; a job asked that matches none, every job it does, to ask instead. */
  private otherJobs(answered: ConcernStats[], job?: string): WaysAnswer['elsewhere'] {
    const all = this.input.coherence.concerns
    const others = job ? (answered.length ? [] : all) : all.filter(s => !answered.includes(s) && !s.concern.tests)
    return others.map(s => ({ id: s.concern.id, label: s.concern.label, stack: s.concern.stack, use: label(s, this.newer(s, s.main.id)) }))
  }

  private job(s: ConcernStats, place: Place, blocks: string[], here: string[]): JobAnswer {
    const ways = this.input.coherence.ways
    const project = s.paradigms.map(p => ({ id: p.id, label: p.label, ...(p.legacy ? { legacy: true } : {}), files: p.files.length }))
    const users = s.paradigms.flatMap(p => p.files)
    const stray = new Set(s.strays)
    const perBlock = blocks.map(block => {
      const files = [...new Set(users.filter(f => this.blockOfId(f) === block))]
      const counts = new Map<string, number>()
      for (const f of files) for (const w of ways.get(f)?.get(s.concern.id) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1)
      const order = new Map(s.paradigms.map((p, i) => [p.id, i]))
      const ranked = [...counts].sort((a, b) => b[1] - a[1] || order.get(a[0])! - order.get(b[0])!)
      const main = ranked[0]?.[0] ?? s.main.id
      const use = this.newer(s, main)
      // files to copy: in the block if it does it so, else anywhere; on that way alone, nearest the place first
      const alone = (f: string) => (ways.get(f)?.get(s.concern.id) ?? []).join() === use
      const pool = files.filter(alone)
      const examples = (pool.length ? pool : users.filter(alone))
        .map(f => this.pathOf(f))
        .sort((a, b) => near(b, place.path) - near(a, place.path) || cmp(a, b))
        .slice(0, EXAMPLES)
      return {
        block,
        files: files.length,
        ways: ranked.map(([id, files]) => ({ id, label: label(s, id), ...(legacyOf(s, id) ? { legacy: true } : {}), files })),
        ...(files.length ? { main: { id: main, label: label(s, main) } } : {}),
        use: { id: use, label: label(s, use) },
        examples,
      }
    })
    // a folder over several blocks: the blocks that do it (all, when none does)
    const shown = place.kind === 'folder' && perBlock.some(b => b.files) ? perBlock.filter(b => b.files) : perBlock
    const doing = here
      .filter(f => ways.get(f)?.has(s.concern.id))
      .map(f => ({ path: this.pathOf(f), ways: ways.get(f)!.get(s.concern.id)!.map(id => label(s, id)), differs: stray.has(f) }))
    return {
      id: s.concern.id,
      label: s.concern.label,
      stack: s.concern.stack,
      about: s.concern.about,
      ...(s.concern.accepted ? { accepted: s.concern.accepted } : {}),
      kind: s.kind,
      project,
      ...(s.migration ? { migration: { from: s.migration.from.map(id => label(s, id)), to: label(s, s.migration.to), done: s.migration.done } } : {}),
      blocks: shown,
      here: doing,
    }
  }

  /** The way new code should take where `main` is the way: itself, unless it's legacy and there's a newer one. */
  private newer(s: ConcernStats, main: string): string {
    if (!legacyOf(s, main)) return main
    return s.migration?.to ?? s.paradigms.find(p => !p.legacy)?.id ?? main
  }

  // ── rules ────────────────────────────────────────────────────────────────

  /** The rules that hold for the place: what it may depend on, who may depend on it, and what breaks them now. */
  rules(place: Place): RulesAnswer {
    const nodes = this.nodesAt(place)
    const layers = this.input.graph.meta.layers ?? []
    const layerName = nodes.map(n => n.tags?.find(t => t.startsWith('layer:'))?.slice(6)).find(Boolean)
    const own: Constraint[] = []
    const guarded: Constraint[] = []
    const any = (sel: Selector | undefined, except?: Selector) => {
      const test = selector(sel)
      const skip = selector(except)
      return nodes.some(n => test(n) && !skip(n))
    }
    for (const rule of this.input.rules) {
      const base = { rule: rule.name, severity: rule.severity ?? 'error', ...(rule.description ? { description: rule.description } : {}) }
      const runtime = 'runtimeOnly' in rule && rule.runtimeOnly ? ' at runtime' : ''
      const where = rule.target ? ` (in ${rule.target})` : ''
      if ('forbid' in rule) {
        const f = rule.forbid
        if (any(f.from, f.except)) own.push({ ...base, kind: 'forbid', says: `must not depend${runtime} on ${sel(f.to)}${where}` })
        if (any(f.to)) guarded.push({ ...base, kind: 'forbid', says: `${sel(f.from)}${f.except ? ` (except ${sel(f.except)})` : ''} must not depend${runtime} on it${where}` })
      } else if ('allow' in rule) {
        if (any(rule.allow.from)) own.push({ ...base, kind: 'allow', says: `may depend${runtime} only on ${sel(rule.allow.to)}${where}` })
      } else if ('apart' in rule) {
        const part = partOf(rule.apart)
        const mine = nodes.map(n => part(n.path)).find(Boolean)
        if (mine) {
          own.push({ ...base, kind: 'apart', says: `is in ${mine}: must not depend${runtime} on the other folders ${sel(rule.apart)} matches${where}` })
          guarded.push({ ...base, kind: 'apart', says: `the other folders ${sel(rule.apart)} matches must not depend on it${where}` })
        }
      } else if ('forbidReach' in rule) {
        const f = rule.forbidReach
        if (any(f.from)) own.push({ ...base, kind: 'forbidReach', says: `must not reach ${sel(f.to)} at runtime, not even through other files${where}` })
        if (any(f.to, f.except)) guarded.push({ ...base, kind: 'forbidReach', says: `${sel(f.from)} must not reach it at runtime${where}` })
      } else if ('requireReach' in rule) {
        const r = rule.requireReach
        const what = [r.to].flat().map(symbolWords).join(' or ')
        if (any(r.from, r.except)) own.push({ ...base, kind: 'requireReach', says: `must reach ${what} through what it runs (calls, renders, creates)${where}` })
        if (any(r.to)) guarded.push({ ...base, kind: 'requireReach', says: `${sel(r.from)}${r.except ? ` (except ${sel(r.except)})` : ''} must reach it through what they run${where}` })
      } else if ('cycles' in rule) {
        if (rule.scope === undefined || any(rule.scope)) own.push({ ...base, kind: 'cycles', says: 'must not take part in an import cycle' })
      } else if ('limit' in rule) {
        const l = rule.limit
        const bounds = [...Object.entries(l.max ?? {}).map(([m, n]) => `${m} at most ${n}`), ...Object.entries(l.min ?? {}).map(([m, n]) => `${m} at least ${n}`)].join(', ')
        if ('files' in l ? any(l.files, l.except) : any(l.functions, l.except)) own.push({ ...base, kind: 'limit', says: `${'files' in l ? 'each file' : 'each function'}: ${bounds}` })
      } else if ('layers' in rule && layerName) {
        const i = layers.indexOf(layerName)
        const above = layers.slice(0, i)
        const below = layers.slice(i + 1)
        own.push({ ...base, kind: 'layers', says: `is in layer ${layerName}: may depend${runtime} on ${[layerName, ...below].join(', ')}${above.length ? `, not on ${above.join(', ')}` : ''}` })
        if (below.length) guarded.push({ ...base, kind: 'layers', says: `${below.join(', ')} must not depend on it (layers below ${layerName})` })
      }
    }
    const ids = new Set(this.filesAt(place))
    if (place.kind === 'external') ids.add(place.id)
    const violations = this.violations().filter(v => ids.has(v.from) || ids.has(v.to) || v.path?.some(id => ids.has(id)))
    return { place, ...(layerName ? { layer: layerName } : {}), own, guarded, violations }
  }

  /**
   * Would `from` depending on `to` break a rule? The dependency (a runtime import)
   * is added to the graph and the rules evaluated again: the violations that
   * weren't there before are what it would break. A folder stands for a new file
   * in it; a bare name nothing has, for an npm package.
   */
  mayDepend(from: Place, to: Place): DependAnswer {
    const graph = this.input.graph
    const source = this.nodeFor(from, 'new.ts')
    const target = to.kind === 'missing' ? ({ id: npmId(to.path), kind: 'external', name: to.path } satisfies GraphNode) : this.nodeFor(to, 'index.ts')
    const exists = graph.edges.some(e => DEPENDENCY_KINDS.has(e.kind) && this.index.fileOf(e.source)?.id === source.id && (this.index.fileOf(e.target)?.id ?? e.target) === target.id)
    const added = [source, target].filter(n => !this.index.node(n.id))
    const edge: GraphEdge = { source: source.id, target: target.id, kind: 'imports', subkind: 'static', count: 1, targets: graph.meta.targets, confidence: 'exact' }
    const next: Graph = { ...graph, nodes: [...graph.nodes, ...added], edges: [...graph.edges, edge] }
    next.meta = { ...graph.meta, cycles: importCycles(next) }
    const before = new Set(this.violations().map(violationKey))
    const breaks = evaluateRules(next, this.input.rules).filter(v => !before.has(violationKey(v)))
    return { from: source.path ?? source.id, to: target.path ?? target.id, exists, allowed: !breaks.some(v => v.severity === 'error'), breaks }
  }

  // ── paths ────────────────────────────────────────────────────────────────

  /** Up to `limit` shortest dependency paths from one place to another, each hop with its kinds; the other way round when there's none. */
  paths(from: Place, to: Place, limit = 5): PathsAnswer {
    const adjacency = new Map<string, string[]>()
    const kinds = new Map<string, Set<string>>()
    for (const e of this.input.graph.edges) {
      if (!DEPENDENCY_KINDS.has(e.kind) || e.kind === 'mocks') continue
      const a = this.endOf(e.source)
      const b = this.endOf(e.target)
      if (!a || !b || a === b) continue
      const k = `${a}\0${b}`
      if (!kinds.has(k)) {
        kinds.set(k, new Set())
        adjacency.set(a, [...(adjacency.get(a) ?? []), b])
      }
      kinds.get(k)!.add(e.kind)
    }
    const search = (a: Place, b: Place) => {
      const FROM = '\0from'
      const TO = '\0to'
      const graph = new Map(adjacency)
      graph.set(FROM, this.endsAt(a))
      for (const id of this.endsAt(b)) graph.set(id, [...(graph.get(id) ?? []), TO])
      return shortestPaths(graph, FROM, TO, limit).map(p => {
        const ids = p.slice(1, -1)
        return ids.slice(1).map((id, i) => ({ from: this.pathOf(ids[i]), to: this.pathOf(id), kinds: [...kinds.get(`${ids[i]}\0${id}`)!].sort() }))
      })
    }
    const forward = search(from, to)
    if (forward.length) return { from, to, reversed: false, paths: forward }
    return { from, to, reversed: true, paths: search(to, from) }
  }

  // ── impact ───────────────────────────────────────────────────────────────

  /**
   * What `impact` starts from: a function or class (an `s:` id, or `<path>#<name>`), else a place.
   * A package nothing uses is missing.
   */
  impactSeed(ref: string): ImpactSeed {
    const p = ref.trim()
    if (p.startsWith('s:')) return this.symbolSeed(p)
    const hash = p.indexOf('#')
    if (hash < 0 || p.startsWith('x:')) {
      const place = this.place(p)
      return place.kind === 'external' && !this.index.node(place.id) ? { kind: 'missing', path: place.path } : place
    }
    const file = this.place(p.slice(0, hash))
    if (file.kind === 'ambiguous') return file
    return file.kind === 'file' ? this.symbolSeed(`s:${file.path}#${p.slice(hash + 1)}`, p) : { kind: 'missing', path: p }
  }

  private symbolSeed(id: string, typed = id): ImpactSeed {
    const node = this.index.node(id)
    const file = this.index.fileOf(id)
    if (!node || !file || node.kind === 'file') return { kind: 'missing', path: typed }
    return { kind: 'symbol', path: file.path!, id, name: id.slice(id.indexOf('#') + 1), file: file.id }
  }

  /**
   * What depends on the seed, directly or through other files (`depth` steps at most): a reverse
   * walk over every dependency kind, mocks and type references included, at file level. A folder's
   * files are the seed together, so only dependents outside it count. A function or class's first
   * step is the files using it (or the symbols of its file that use it), and the tests mocking its
   * module, not every importer of its file. Mocks and links to pages count on the first step only
   * (stepBack). A file that only re-exports (an index.ts) is listed but not walked through: whoever
   * uses what it passes on refers to the original, and is reached from there.
   */
  impact(seed: ImpactStart, depth?: number): ImpactAnswer {
    const steps = seed.kind === 'new' ? new Map<string, Step>() : this.walkBack(seed)
    const all = [...steps].map(([id, s]) => this.impactHit(id, s)).sort(byImpact)
    const hits = depth ? all.filter(h => h.depth <= depth) : all
    return { seed, ...(depth ? { depth } : {}), ...this.impactSummary(hits), beyond: all.length - hits.length, hits }
  }

  private walkBack(seed: Exclude<ImpactStart, { kind: 'new' }>): Map<string, Step> {
    const own = new Set(seed.kind === 'symbol' ? [seed.file] : seed.kind === 'external' ? [seed.id] : this.filesAt(seed))
    const reached = seed.kind === 'symbol' ? this.symbolUsers(seed) : this.stepBack([...own], id => own.has(id), 1)
    const seen = (id: string) => own.has(id) || reached.has(id)
    for (let frontier = [...reached.keys()], depth = 2; frontier.length; depth++) {
      const next = this.stepBack(frontier.filter(f => !this.reExportsOnly(f)), seen, depth)
      for (const [id, s] of next) reached.set(id, s)
      frontier = [...next.keys()]
    }
    return reached
  }

  /**
   * The files depending on any of `from` that aren't `seen`, each through the first of `from` (by
   * path) it depends on. Past the first step, a mock or a link to a page passes nothing on: a test
   * mocking a file doesn't run what it uses, and a link works whatever the page's code does.
   */
  private stepBack(from: string[], seen: (id: string) => boolean, depth: number): Map<string, Step> {
    const dependents = this.dependents()
    const passes = (link: Link) => depth === 1 || [...link.kinds].some(k => !FIRST_STEP_ONLY.has(k))
    const out = new Map<string, Step>()
    for (const f of [...from].sort())
      for (const [user, link] of dependents.get(f) ?? []) if (!seen(user) && !out.has(user) && passes(link)) out.set(user, { depth, via: f, ...link })
    return out
  }

  /** The files using a function or class (or one of its file's symbols that does), and the tests mocking its module: one step from it. */
  private symbolUsers(seed: ImpactSeed & { kind: 'symbol' }): Map<string, Step> {
    const edges = this.input.graph.edges
    const into = [...this.symbolScope(seed)].flatMap(id => this.index.incoming.get(id) ?? [])
    const mocks = (this.index.incoming.get(seed.file) ?? []).filter(i => edges[i].kind === 'mocks')
    const out = new Map<string, Step>()
    for (const i of [...into, ...mocks]) {
      const user = this.index.fileOf(edges[i].source)?.id
      if (!user || user === seed.file || !DEPENDENCY_KINDS.has(edges[i].kind)) continue
      const step = out.get(user) ?? { depth: 1, via: seed.file, kinds: new Set<string>(), edges: [] }
      step.kinds.add(edges[i].kind)
      step.edges.push(i)
      out.set(user, step)
    }
    return out
  }

  /** The symbol, its members, and the symbols of its file that use any of them, however indirectly. */
  private symbolScope(seed: ImpactSeed & { kind: 'symbol' }): Set<string> {
    const scope = new Set([seed.id, ...this.index.descendants(seed.id).map(n => n.id)])
    const others = this.index.descendants(seed.file).filter(n => !scope.has(n.id))
    const uses = (n: GraphNode) => this.index.out(n.id).some(e => DEPENDENCY_KINDS.has(e.kind) && scope.has(e.target))
    for (let grew = true; grew; ) {
      const users = others.filter(n => !scope.has(n.id) && uses(n))
      for (const n of users) for (const id of [n.id, ...this.index.descendants(n.id).map(d => d.id)]) scope.add(id)
      grew = users.length > 0
    }
    return scope
  }

  /** A file → the files depending on it, at file level; a subscriber depends on the files publishing to its topic. */
  private dependents(): Map<string, Map<string, Link>> {
    if (this.dependentsCache) return this.dependentsCache
    const out = new Map<string, Map<string, Link>>()
    this.input.graph.edges.forEach((e, i) => {
      const user = this.index.fileOf(e.source)?.id
      const used = DEPENDENCY_KINDS.has(e.kind) ? this.endOf(e.target) : undefined
      if (user && used && user !== used) linkTo(out, used, user, e.kind, [i])
    })
    for (const { publishers, subscribers } of this.topics()) for (const [sub, edges] of subscribers) linkTopic(out, publishers, sub, edges)
    return (this.dependentsCache = out)
  }

  /** Each message topic's publishing files, and its subscribing files with their edges to it. */
  private topics(): { publishers: Set<string>; subscribers: Map<string, number[]> }[] {
    const byTopic = new Map<string, { publishers: Set<string>; subscribers: Map<string, number[]> }>()
    this.input.graph.edges.forEach((e, i) => {
      const file = this.index.fileOf(e.source)?.id
      if ((e.kind !== 'publishes' && e.kind !== 'subscribes') || !file || !this.tagsOf(e.target).includes('topic')) return
      const t = byTopic.get(e.target) ?? { publishers: new Set<string>(), subscribers: new Map<string, number[]>() }
      if (e.kind === 'publishes') t.publishers.add(file)
      else t.subscribers.set(file, [...(t.subscribers.get(file) ?? []), i])
      byTopic.set(e.target, t)
    })
    return [...byTopic.values()]
  }

  /** A file that declares nothing and re-exports others (a barrel, an index.ts). */
  private reExportsOnly(id: string): boolean {
    return !this.index.children.get(id)?.length && this.index.out(id).some(e => e.kind === 're-exports')
  }

  private impactHit(id: string, s: Step): ImpactHit {
    const line = firstLine(this.input.graph.sites, s.edges)
    const via = this.index.node(s.via)
    return {
      path: this.pathOf(id),
      depth: s.depth,
      via: via?.path ?? via?.name ?? s.via,
      kinds: [...s.kinds].sort(),
      ...(line ? { line } : {}),
      ...(this.tagsOf(id).includes('test') ? { test: true as const } : {}),
    }
  }

  private impactSummary(hits: ImpactHit[]): Omit<ImpactAnswer, 'seed' | 'depth' | 'beyond' | 'hits'> {
    const code = hits.filter(h => !h.test)
    return {
      levels: levelsOf(hits),
      production: code.length,
      tests: hits.length - code.length,
      features: this.featuresOf(code),
      entryPoints: code.flatMap(h => this.entryPointsOf(h)).sort((a, b) => ENTRY_ORDER.indexOf(a.kind) - ENTRY_ORDER.indexOf(b.kind) || cmp(a.route ?? a.path, b.route ?? b.path)),
      testsToRun: hits.filter(h => h.test && RUNNABLE.test(h.path)).map(h => h.path),
    }
  }

  /** The features of the files, most files first. */
  private featuresOf(hits: ImpactHit[]): { name: string; files: number }[] {
    const count = new Map<string, number>()
    for (const h of hits) for (const t of this.tagsOf(fileId(h.path))) if (t.startsWith('feature:')) count.set(t.slice(8), (count.get(t.slice(8)) ?? 0) + 1)
    return [...count].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files || cmp(a.name, b.name))
  }

  /** A page, layout or API route by its route (an HTTP handler's, when its file has none); else an entry point the config names. */
  private entryPointsOf(h: ImpactHit): EntryPoint[] {
    const id = fileId(h.path)
    const own = this.tagsOf(id)
    const tags = own.some(t => /^(route|api|layout):/.test(t)) ? own : [...own, ...this.index.descendants(id).flatMap(n => n.tags ?? [])]
    const found = tags.map(t => ROUTE.exec(t)).filter(m => m !== null)
    if (found.length) return found.map(m => ({ kind: ENTRY_KIND[m[1]], route: m[2], path: h.path, depth: h.depth }))
    return own.includes('entrypoint') ? [{ kind: 'entry', path: h.path, depth: h.depth }] : []
  }

  // ── one file ─────────────────────────────────────────────────────────────

  /** One file at a glance: where it sits, its size and history, what it uses and who uses it, how it does its jobs, its rules. */
  file(place: Place & { kind: 'file' }): FileAnswer {
    const node = this.index.node(place.id)!
    const out = new Map<string, Set<string>>()
    const inc = new Map<string, Set<string>>()
    for (const e of this.input.graph.edges) {
      if (!DEPENDENCY_KINDS.has(e.kind)) continue
      const a = this.endOf(e.source)
      const b = this.endOf(e.target)
      if (!a || !b || a === b) continue
      if (a === place.id) addTo(out, b, e.kind)
      if (b === place.id) addTo(inc, a, e.kind)
    }
    // production code first, then the tests
    const said = (id: string) => {
      const d = this.input.descriptions?.entries[id]
      return d ? { described: d.name ?? (d.summary.length > 90 ? `${d.summary.slice(0, 89)}…` : d.summary) } : {}
    }
    const list = (m: Map<string, Set<string>>) =>
      [...m]
        .map(([id, k]) => ({ path: this.pathOf(id), kinds: [...k].sort(), ...(this.tagsOf(id).includes('test') ? { test: true } : {}), ...said(id) }))
        .sort((a, b) => Number(!!a.test) - Number(!!b.test) || cmp(a.path, b.path))
    const tags = node.tags ?? []
    const c = this.input.coherence
    const jobs = [...(c.ways.get(place.id) ?? [])].map(([id, ways]) => {
      const s = c.byId.get(id)!
      const block = this.job(s, place, [this.blockOfId(place.id) ?? ''], [place.id]).blocks[0]
      return { id, label: s.concern.label, stack: s.concern.stack, ways: ways.map(w => label(s, w)), use: block.use.label, differs: s.strays.includes(place.id) }
    })
    const symbols = this.index.descendants(place.id)
    // where it ranks among the production files by churn × complexity
    const hot = node.metrics?.hotspot
    const ranked = this.files.filter(f => !f.tags?.includes('test') && (f.metrics?.hotspot ?? 0) > 0)
    const rank = hot ? ranked.filter(f => f.metrics!.hotspot! > hot).length + 1 : undefined
    const described = this.input.descriptions?.entries[place.id]
    const block = this.blockOfId(place.id)
    const blockDescribed = block ? this.input.descriptions?.entries[`d:${block}`] : undefined
    return {
      place,
      ...(block ? { block } : {}),
      ...(described ? { described } : {}),
      ...(blockDescribed ? { blockDescribed } : {}),
      tags: tags.filter(t => !t.startsWith('paradigm:')),
      metrics: node.metrics ?? {},
      ...(rank ? { hotspot: { rank, of: ranked.length } } : {}),
      dependsOn: list(out),
      usedBy: list(inc),
      jobs,
      rules: this.rules(place),
      deadExports: symbols.filter(s => s.tags?.includes('dead-export')).map(s => s.name),
      testOnlyExports: symbols.filter(s => s.tags?.includes('test-only')).map(s => s.name),
      functions: this.risks(place).functions,
      docs: this.docsAbout(place),
    }
  }

  // ── documents ────────────────────────────────────────────────────────────

  /**
   * What a question about documents names: a decision id the code cites (`D34`), a document
   * (`SPEC.md`, `../architecture/05-building-block-view.html`), a function (`s:…` or
   * `src/lib/x.ts#name`), else a place.
   */
  docsQuestion(ref: string): DocsAnswer {
    const meta = this.input.graph.meta.docs
    const id = findId(meta, ref)
    if (id) return { kind: 'id', id, current: this.currentDocs() }
    const doc = findDoc(meta, ref)
    if (doc) return { kind: 'doc', doc, defines: this.definedIn(doc.path) }
    const symbol = this.symbolOf(ref)
    const place = this.place(symbol ? this.index.fileOf(symbol)!.path! : ref)
    if (place.kind === 'missing' || place.kind === 'ambiguous' || place.kind === 'new') return { kind: 'none', place, read: !!meta }
    return { kind: 'code', place, ...(symbol ? { symbol } : {}), read: !!meta, ...this.docsAbout(place, symbol) }
  }

  /** The documents naming a place (with its functions and subfolders), or one function and its members; and the ids its files cite. */
  docsAbout(place: Place, symbol?: string): { named: DocRef[]; cites: CitedId[] } {
    const meta = this.input.graph.meta.docs
    if (!meta) return { named: [], cites: [] }
    const ids = symbol ? [symbol] : place.kind === 'external' ? [place.id] : [...this.filesAt(place), ...(place.kind === 'folder' ? [dirId(place.path)] : [])]
    const nodes = new Set(ids.flatMap(id => [id, ...this.index.descendants(id).map(n => n.id)]))
    const files = new Set(symbol ? [] : this.filesAt(place).map(id => this.pathOf(id)))
    return { named: docsNaming(meta, nodes), cites: idsCitedBy(meta, files) }
  }

  /** The function or class a reference names (an `s:` id, or `<path>#<name>`, as impact reads it), when the graph has it. */
  private symbolOf(ref: string): string | undefined {
    if (!ref.startsWith('s:') && !ref.includes('#')) return undefined
    const seed = this.impactSeed(ref)
    return seed.kind === 'symbol' ? seed.id : undefined
  }

  private currentDocs(): Set<string> {
    return new Set((this.input.graph.meta.docs?.docs ?? []).filter(d => d.current).map(d => d.path))
  }

  /** The ids a document defines that the code cites, with how many files cite each. */
  private definedIn(doc: string): DocDefines[] {
    return (this.input.graph.meta.docs?.ids ?? []).flatMap(id => {
      const def = id.defined.find(d => d.doc === doc)
      if (!def) return []
      const meant = id.cited.filter(c => c.docs.includes(doc)).length
      return [{ id: id.id, line: def.line, label: def.label, cited: id.cited.length, meant }]
    })
  }

  // ── risk ─────────────────────────────────────────────────────────────────

  /**
   * The functions, methods, components and hooks of a file or folder (production code), riskiest
   * first: by CRAP from the last coverage run, by complexity where there is none or the file
   * changed after it.
   */
  risks(place: Place): RisksAnswer {
    const files = new Set(
      this.filesAt(place)
        .filter(id => place.kind === 'file' || !this.tagsOf(id).includes('test'))
        .map(id => this.pathOf(id)),
    )
    const coverage = this.input.coverage
    const functions = this.input.graph.nodes
      .filter(n => isFunction(n) && files.has(n.path!) && n.range && n.metrics?.complexity !== undefined)
      .map(n => {
        const owner = n.kind === 'member' && n.parent ? this.index.node(n.parent) : undefined
        const name = owner && owner.kind !== 'file' ? `${owner.name}.${n.name}` : n.name
        return functionRisk({ name, path: n.path!, range: [n.range![0], n.range![2]], complexity: n.metrics!.complexity }, coverage?.of)
      })
      .sort(byRisk)
    return {
      place,
      ...(coverage ? { coverage: { file: coverage.file, at: coverage.at } } : {}),
      functions,
      stale: [...new Set(functions.filter(f => f.stale).map(f => f.path))].sort(),
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private violations(): Violation[] {
    return (this.violationsCache ??= evaluateRules(this.input.graph, this.input.rules))
  }

  private filesAt(place: Place): string[] {
    return place.kind === 'file' ? [place.id] : place.kind === 'folder' ? place.files : []
  }

  /** The blocks a place covers: a file's (or a new one's), or those of a folder's files. */
  private blocksAt(place: Place): string[] {
    if (place.kind === 'folder') return [...new Set(place.files.map(id => this.blockOfId(id)).filter((b): b is string => !!b))].sort()
    const b = place.kind === 'file' || place.kind === 'new' ? this.input.blockOf(place.path) : undefined
    return b ? [b] : []
  }

  /** The nodes a rule's selectors are tried on: the file, a folder's files, or the node a new path would have. */
  private nodesAt(place: Place): GraphNode[] {
    if (place.kind === 'file') return [this.index.node(place.id)!]
    if (place.kind === 'folder') return place.files.map(id => this.index.node(id)!)
    return [this.nodeFor(place, 'new.ts')]
  }

  /** The node a place stands for in a dependency: itself, or the file it would be (a folder: `<folder>/<name>`). */
  private nodeFor(place: Place, name: string): GraphNode {
    if (place.kind === 'file' || place.kind === 'external') return this.index.node(place.id) ?? { id: place.id, kind: 'external', name: place.id }
    const path = place.kind === 'folder' ? `${place.path ? `${place.path}/` : ''}${name}` : place.path
    return this.index.node(fileId(path)) ?? { id: fileId(path), kind: 'file', name: path.split('/').pop()!, path, tags: this.input.tagsFor(path) }
  }

  /** A dependency's end at file level: its file, or the external itself. */
  private endOf(id: string): string | undefined {
    return this.index.fileOf(id)?.id ?? (this.index.node(id)?.kind === 'external' ? id : undefined)
  }

  private endsAt(place: Place): string[] {
    return place.kind === 'external' ? [place.id] : this.filesAt(place)
  }

  private tagsOf(id: string) {
    return this.index.node(id)?.tags ?? []
  }

  private pathOf(id: string) {
    return this.index.node(id)?.path ?? id
  }

  private blockOfId(id: string) {
    return this.input.blockOf(this.pathOf(id))
  }
}

/**
 * The jobs a question names: an id (`js.http`, or its last part `http`), else
 * the jobs whose label and description share the most words with it
 * ("call the server" → HTTP calls, "calling a server").
 */
export function findJobs(c: CoherenceModel, text: string): ConcernStats[] {
  const q = text.trim().toLowerCase()
  const exact = c.concerns.filter(s => s.concern.id === q || s.concern.id.split('.').pop() === q || s.concern.label.toLowerCase() === q)
  if (exact.length) return exact
  const words = q.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w))
  if (!words.length) return []
  const scored = c.concerns.map(s => {
    const hay = `${s.concern.id} ${s.concern.label} ${s.concern.about} ${s.paradigms.map(p => p.label).join(' ')}`.toLowerCase()
    return { s, score: words.filter(w => hay.includes(w) || (w.length > 4 && hay.includes(w.slice(0, -1)))).length }
  })
  const best = Math.max(0, ...scored.map(x => x.score))
  return best ? scored.filter(x => x.score === best).map(x => x.s) : []
}

const STOP = new Set(['the', 'and', 'how', 'does', 'this', 'that', 'folder', 'file', 'code', 'what', 'which', 'with', 'for', 'way', 'ways', 'use', 'uses', 'here', 'there', 'into', 'from', 'about', 'should'])

export interface WayCount {
  id: string
  label: string
  legacy?: boolean
  files: number
}

export interface JobAnswer {
  id: string
  label: string
  stack: string
  about: string
  /** Several ways on purpose: why (the config). */
  accepted?: string
  kind: ConcernStats['kind']
  /** Its ways across the project, most files first. */
  project: WayCount[]
  migration?: { from: string[]; to: string; done: number }
  /** Per block of the place: its ways, the way to follow (`use`) and files that do it so. */
  blocks: { block: string; files: number; ways: WayCount[]; main?: { id: string; label: string }; use: { id: string; label: string }; examples: string[] }[]
  /** The place's own files that do it, and whether they differ from their block. */
  here: { path: string; ways: string[]; differs: boolean }[]
}

export interface WaysAnswer {
  place: Place
  blocks: string[]
  jobs: JobAnswer[]
  /** Without a job asked: the jobs the project does but not here, with the way it takes. With a job that matches none: every job the project does. */
  elsewhere: { id: string; label: string; stack: string; use: string }[]
}

export interface Constraint {
  rule: string
  severity: 'error' | 'warn'
  kind: RuleKind
  description?: string
  /** The rule as it applies here, in words: "must not depend on src/server/**". */
  says: string
}

export interface RulesAnswer {
  place: Place
  layer?: string
  /** What the place may depend on. */
  own: Constraint[]
  /** Who may depend on the place. */
  guarded: Constraint[]
  /** Broken now, involving the place. */
  violations: Violation[]
}

export interface DependAnswer {
  from: string
  to: string
  /** It depends on it already. */
  exists: boolean
  /** No rule with severity error would break. */
  allowed: boolean
  /** The violations the dependency would add. */
  breaks: Violation[]
}

export interface PathsAnswer {
  from: Place
  to: Place
  /** No path from → to: these go to → from. */
  reversed: boolean
  paths: { from: string; to: string; kinds: string[] }[][]
}

/** What `impact` starts from: a place, or a function or class (`name` as in its id: `useX`, `Store.load`). */
export type ImpactSeed = Place | { kind: 'symbol'; path: string; id: string; name: string; file: string }
/** A seed there is something at (or a file not written yet, which nothing uses). */
export type ImpactStart = Exclude<ImpactSeed, { kind: 'ambiguous' | 'missing' }>

/** A file depending on the seed. */
export interface ImpactHit {
  path: string
  /** Steps from the seed: 1 uses it directly. */
  depth: number
  /** The file one step closer to the seed (at depth 1, the seed's file or package). */
  via: string
  /** How it depends on `via`. */
  kinds: string[]
  /** Where it first refers to `via`, when the graph has the sites. */
  line?: number
  test?: true
}

export interface EntryPoint {
  /** A page, an API route (or an HTTP handler), a layout, or another entry point of the config (a worker, a script). */
  kind: 'page' | 'api' | 'layout' | 'entry'
  route?: string
  path: string
  depth: number
}

export interface ImpactAnswer {
  seed: ImpactStart
  /** The most steps walked (--depth); all the way when absent. */
  depth?: number
  /** Nearest first: by depth, production code before tests, then by path. */
  hits: ImpactHit[]
  /** Files further than `depth` steps. */
  beyond: number
  levels: { depth: number; production: number; tests: number }[]
  production: number
  tests: number
  /** The features of the production files, most files first. */
  features: { name: string; files: number }[]
  entryPoints: EntryPoint[]
  /** The test files among them (helpers, fixtures and setup files aside): the tests to run after the change. */
  testsToRun: string[]
}

export interface FileAnswer {
  place: Place & { kind: 'file' }
  block?: string
  /** What was written about it (`archrift describe`), and about its block. */
  described?: Description
  blockDescribed?: Description
  tags: string[]
  metrics: Record<string, number>
  /** Its place among the production files by hotspot (churn × complexity), 1 the hottest. */
  hotspot?: { rank: number; of: number }
  /** Each with the name (else the summary) written for it, when there is one. */
  dependsOn: { path: string; kinds: string[]; test?: boolean; described?: string }[]
  usedBy: { path: string; kinds: string[]; test?: boolean; described?: string }[]
  jobs: { id: string; label: string; stack: string; ways: string[]; use: string; differs: boolean }[]
  rules: RulesAnswer
  deadExports: string[]
  testOnlyExports: string[]
  /** Its functions, riskiest first (see RisksAnswer). */
  functions: FunctionRisk[]
  /** The documents naming it or its functions, and the decision ids it cites (config `docs`). */
  docs: { named: DocRef[]; cites: CitedId[] }
}

export interface DocDefines {
  id: string
  line: number
  label: string
  /** Files citing the id, and those meaning it from this document. */
  cited: number
  meant: number
}

export type DocsAnswer =
  /** A file, folder, function or package: the documents naming it, the ids it cites. `read`: documents were read at all. */
  | { kind: 'code'; place: Place; symbol?: string; read: boolean; named: DocRef[]; cites: CitedId[] }
  /** A decision id: where it is defined (`current`: the documents kept current), who cites it. */
  | { kind: 'id'; id: IdMeta; current: Set<string> }
  /** A document: the code it names, the ids it defines. */
  | { kind: 'doc'; doc: DocMeta; defines: DocDefines[] }
  | { kind: 'none'; place: Place; read: boolean }

export interface RisksAnswer {
  place: Place
  /** The coverage run the scores come from; absent: none, so complexity only. */
  coverage?: { file: string; at: string }
  functions: FunctionRisk[]
  /** Files changed after the coverage run: their functions have complexity only. */
  stale: string[]
}

/** One rule violation, the same before and after a change: by rule and ends (reach: what's reached, where; cycles: the members). */
export function violationKey(v: Violation): string {
  if (v.measure) return `${v.rule}\0limit\0${v.measure.symbol ?? v.from}\0${v.measure.metric}\0${v.measure.bound}`
  if (v.expects) return `${v.rule}\0expects\0${v.expects.symbol ?? v.from}`
  if (v.sources) return `${v.rule}\0reach\0${v.to}\0${v.targets.join()}`
  if (v.path && v.path.length > 1 && v.path[0] === v.path.at(-1)) return `${v.rule}\0cycle\0${[...new Set(v.path)].sort().join()}`
  return `${v.rule}\0${v.from}\0${v.to}`
}

const sel = (s: Selector) => [s].flat().map(x => x.replace(/^x:npm:/, '')).join(' or ')
const label = (s: ConcernStats, id: string) => s.paradigms.find(p => p.id === id)?.label ?? id
const legacyOf = (s: ConcernStats, id: string) => !!s.paradigms.find(p => p.id === id)?.legacy
const stem = (p: string) => p.replace(/\.[^./]+$/, '')
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** How many leading folders two paths share. */
function near(a: string, b: string): number {
  const x = a.split('/')
  const y = b.split('/')
  let i = 0
  while (i < x.length - 1 && i < y.length && x[i] === y[i]) i++
  return i
}

function addTo(m: Map<string, Set<string>>, k: string, v: string) {
  const s = m.get(k)
  if (s) s.add(v)
  else m.set(k, new Set([v]))
}

// ── impact ─────────────────────────────────────────────────────────────────

/** How one file depends on another: the kinds, and the edges (for their sites). */
interface Link {
  kinds: Set<string>
  edges: number[]
}

/** A file the walk reached: how far, and through which file. */
interface Step extends Link {
  depth: number
  via: string
}

function linkTo(m: Map<string, Map<string, Link>>, used: string, user: string, kind: string, edges: number[]) {
  const users = m.get(used) ?? new Map<string, Link>()
  const link = users.get(user) ?? { kinds: new Set<string>(), edges: [] }
  link.kinds.add(kind)
  link.edges.push(...edges)
  users.set(user, link)
  m.set(used, users)
}

/** Through a message topic, a subscriber depends on the files publishing to it (their messages are its input). */
function linkTopic(m: Map<string, Map<string, Link>>, publishers: Set<string>, subscriber: string, edges: number[]) {
  for (const p of publishers) if (p !== subscriber) linkTo(m, p, subscriber, 'subscribes', edges)
}

/** The first line the edges refer at (an edge's sites: line, column, line, column …), when the graph has their sites. */
function firstLine(sites: Sites[], edges: number[]): number | undefined {
  const lines = edges.flatMap(i => (sites[i] ?? []).filter((_, k) => k % 2 === 0))
  return lines.length ? Math.min(...lines) : undefined
}

function levelsOf(hits: ImpactHit[]): ImpactAnswer['levels'] {
  const levels = new Map<number, { depth: number; production: number; tests: number }>()
  for (const h of hits) {
    const l = levels.get(h.depth) ?? { depth: h.depth, production: 0, tests: 0 }
    l[h.test ? 'tests' : 'production']++
    levels.set(h.depth, l)
  }
  return [...levels.values()]
}

/** Dependencies that count only on the seed itself: a mock of it, a link to its page. */
const FIRST_STEP_ONLY = new Set(['mocks', 'navigates'])

const byImpact = (a: ImpactHit, b: ImpactHit) => a.depth - b.depth || Number(!!a.test) - Number(!!b.test) || cmp(a.path, b.path)

/** The tags naming a route: a page's, an API route's, a layout's, an HTTP handler's (`http:GET /orders`). */
const ROUTE = /^(route|api|layout|http):(.+)$/
const ENTRY_KIND: Record<string, EntryPoint['kind']> = { route: 'page', api: 'api', http: 'api', layout: 'layout' }
const ENTRY_ORDER: EntryPoint['kind'][] = ['page', 'api', 'layout', 'entry']

/** Test files a runner runs; helpers, fixtures and setup files are test code that runs nothing. */
const RUNNABLE = /\.(test|tests|spec)\.[cm]?[jt]sx?$|_test\.go$|(Test|Tests|Spec|IT)\.(kt|java|scala|groovy)$|(^|\/)test_[^/]+\.py$|_test\.py$/
