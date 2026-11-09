// Architecture rules, checked against an assembled graph. Rules
// look at file-level dependencies: import edges (type-only ones too, unless
// `runtimeOnly`; `apart` keeps each folder its globs match from depending on
// another, services/* or apps/*), and for `forbidReach` the runtime import graph of one build
// target, transitively, which is what ends up in that target's bundle.
// `requireReach` asks the opposite of the code itself: each `from` must run `to`,
// through what it calls, renders or creates (an API route checks the session).
// `limit` rules bound what the analysis measures on files or functions. A rule
// that matches nothing checks nothing, so it says so (`unmatched`) instead of
// passing.
import { cycles } from './algorithms.ts'
import { matcher } from './glob.ts'
import { isRuntimeImport } from './model.ts'
import type { Graph, GraphEdge, GraphNode } from './model.ts'

/**
 * Which nodes a rule is about: path globs (`src/lib/**`), `tag:<tag>`
 * (`tag:entrypoint`, `tag:use-client`; `*` in a tag matches anything:
 * `tag:api:*`), `layer:<name>`, external ids (`x:npm:@tauri-apps/*`), or
 * symbol ids, globs too (`s:src/lib/auth.ts#requireSession`, `s:src/app/api/**#{GET,POST}`).
 */
export type Selector = string | string[]

/**
 * What a `limit` can bound. Files: lines, cyclomatic complexity, declarations,
 * production files depending on it and files it depends on, packages it uses,
 * instability (fanOut / (fanIn + fanOut)), tests reaching it and tests
 * importing it. Functions (functions, methods, components, hooks): lines,
 * complexity, who refers to them and what they refer to. Git history is left
 * out on purpose: churn grows with time whatever a change does.
 */
export const FILE_METRICS = ['loc', 'complexity', 'symbols', 'fanIn', 'fanOut', 'externalDeps', 'instability', 'testReach', 'testedDirectly'] as const
export const FUNCTION_METRICS = ['loc', 'complexity', 'fanIn', 'fanOut'] as const
export type FileMetric = (typeof FILE_METRICS)[number]
export type FunctionMetric = (typeof FUNCTION_METRICS)[number]

/** The declarations a `functions` limit looks at (and `archrift query crap` scores). */
export const FUNCTION_KINDS = new Set(['function', 'method', 'constructor', 'accessor', 'component', 'hook'])

/** A function, method, React component or hook: not a class, which an Angular component is (tagged `class`). */
export const isFunction = (n: GraphNode) => (n.kind === 'symbol' || n.kind === 'member') && FUNCTION_KINDS.has(n.subkind ?? '') && !n.tags?.includes('class')

interface RuleBase {
  name: string
  description?: string
  severity?: 'error' | 'warn'
  /** Only this build target (default: all of them). */
  target?: string
}

export type Limit =
  | { files: Selector; except?: Selector; max?: Partial<Record<FileMetric, number>>; min?: Partial<Record<FileMetric, number>> }
  | { functions: Selector; except?: Selector; max?: Partial<Record<FunctionMetric, number>>; min?: Partial<Record<FunctionMetric, number>> }

export type Rule = RuleBase &
  (
    | { forbid: { from: Selector; to: Selector; except?: Selector }; runtimeOnly?: boolean }
    | { allow: { from: Selector; to: Selector }; runtimeOnly?: boolean }
    | { apart: Selector; runtimeOnly?: boolean }
    | { forbidReach: { from: Selector; to: Selector; except?: Selector } }
    | { requireReach: { from: Selector; to: Selector; except?: Selector } }
    | { cycles: 'forbid'; scope?: Selector }
    | { layers: 'down'; runtimeOnly?: boolean }
    | { limit: Limit }
  )

export const RULE_KINDS = ['forbid', 'allow', 'apart', 'forbidReach', 'requireReach', 'cycles', 'layers', 'limit'] as const
export type RuleKind = (typeof RULE_KINDS)[number]

/** What the viewer and `archrift check` show for a configured rule, broken or not. */
export interface RuleSummary {
  name: string
  kind: RuleKind
  severity: 'error' | 'warn'
  description?: string
  target?: string
  /** Why the rule checks nothing, or less than it says: a pattern no file matches, a target or layer that isn't there. Breaks the rule. */
  unmatched?: string[]
}

export interface Violation {
  rule: string
  severity: 'error' | 'warn'
  message: string
  /** The dependent file and what it shouldn't depend on (for cycles: the first two members). */
  from: string
  to: string
  targets: string[]
  /** File ids along the offending dependency, from → to (reach and cycles). */
  path?: string[]
  /** forbidReach: every `from` node that reaches `to`. */
  sources?: string[]
  /** limit: the measure out of bounds (`from` and `to` are its file), and the function it's about. */
  measure?: { metric: string; value: number; bound: 'max' | 'min'; limit: number; symbol?: string }
  /** requireReach: what it never reaches (`to`, in words), and the function that doesn't when `from` is a symbol (`from` and `to` are its file). */
  expects?: { to: string; symbol?: string }
}

const IMPORTS = new Set(['imports', 're-exports', 'spawns-worker'])
/** What code runs, for requireReach: the edges `findFeatures` walks too (core/features.ts). */
const RUNS = new Set(['calls', 'renders', 'instantiates', 'references', 'rpc-call', 'queries', 'spawns-worker'])
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
const EXCLUDED = 'x:excluded:'

/** The rule for the viewer and `archrift check`; with the graph, also what of it matches nothing. */
export function summarize(rule: Rule, graph?: Graph): RuleSummary {
  const kind = RULE_KINDS.find(k => k in rule)!
  const summary: RuleSummary = { name: rule.name, kind, severity: rule.severity ?? 'error', description: rule.description, target: rule.target }
  const unmatched = graph ? unmatchedParts(graph, rule) : []
  if (unmatched.length) summary.unmatched = unmatched
  return summary
}

/**
 * What makes a rule check nothing, or less than it says: a pattern that matches
 * no file (a folder renamed, a typo), a target or layer the project doesn't have,
 * a metric nothing carries. A package pattern (`x:…`) may match nothing: no file
 * using the package is what a rule against it wants. Exceptions aren't looked
 * at: one that matches nothing excuses nothing, and the violations show.
 */
export function unmatchedParts(graph: Graph, rule: Rule): string[] {
  const out: string[] = []
  const patterns = (field: string, sel: Selector | undefined) => {
    for (const p of sel === undefined ? [] : [sel].flat()) {
      if (p.startsWith('x:')) continue
      const test = selector(p)
      if (!graph.nodes.some(test)) out.push(`${field} ${p} matches no ${p.startsWith('s:') ? 'symbol' : 'file'}`)
    }
  }
  if (rule.target && !graph.meta.targets.includes(rule.target)) out.push(`target ${rule.target} is not a build target (${graph.meta.targets.join(', ')})`)
  if ('forbid' in rule) {
    patterns('from', rule.forbid.from)
    patterns('to', rule.forbid.to)
  } else if ('allow' in rule) {
    patterns('from', rule.allow.from)
    patterns('to', rule.allow.to)
  } else if ('apart' in rule) {
    const folders = foldersOf(graph)
    for (const p of [rule.apart].flat()) if (!folders.some(matcher([p]))) out.push(`apart ${p} matches no folder`)
    // a glob matches the folders below a match too: the parts are the outermost
    const part = partOf(rule.apart)
    const parts = new Set(folders.map(f => part(`${f}/`)).filter(Boolean))
    if (parts.size === 1) out.push(`apart ${[rule.apart].flat().join(', ')} matches one folder: nothing to keep it apart from`)
  } else if ('forbidReach' in rule) {
    patterns('from', rule.forbidReach.from)
    patterns('to', rule.forbidReach.to)
  } else if ('requireReach' in rule) {
    patterns('from', rule.requireReach.from)
    patterns('to', rule.requireReach.to)
  } else if ('cycles' in rule) patterns('scope', rule.scope)
  else if ('layers' in rule) {
    const layers = graph.meta.layers ?? []
    if (layers.length < 2) out.push(layers.length ? 'only one layer is configured' : 'no layers are configured')
    for (const l of layers) if (!graph.nodes.some(n => n.tags?.includes(`layer:${l}`))) out.push(`layer ${l} holds no file`)
  } else if ('limit' in rule) {
    const { field, nodes } = limited(graph, rule.limit)
    const before = out.length
    patterns(field, 'files' in rule.limit ? rule.limit.files : rule.limit.functions)
    const what = field === 'files' ? 'file' : 'function'
    if (!nodes.length) {
      if (out.length === before) out.push(field === 'files' ? 'it limits no file: except takes them all' : 'it limits no function: its files hold none, or except takes them')
    } else
      for (const metric of new Set([...Object.keys(rule.limit.max ?? {}), ...Object.keys(rule.limit.min ?? {})]))
        if (!nodes.some(n => n.metrics?.[metric] !== undefined)) out.push(`no ${what} it limits has ${metric}`)
  }
  return out
}

/** The folders holding the graph's files (the root's own files: none). */
function foldersOf(graph: Graph): string[] {
  const out = new Set<string>()
  for (const n of graph.nodes) {
    if (n.kind !== 'file' || !n.path) continue
    for (let i = n.path.indexOf('/'); i > 0; i = n.path.indexOf('/', i + 1)) out.add(n.path.slice(0, i))
  }
  return [...out]
}

/**
 * For an `apart` rule: the folder a file belongs to, of those its patterns match (the outermost
 * when they nest), or undefined for a file in none of them.
 */
export function partOf(sel: Selector): (path: string | undefined) => string | undefined {
  const m = matcher([sel].flat())
  const memo = new Map<string, string | undefined>()
  return path => {
    if (!path) return undefined
    let part = memo.get(path)
    if (part === undefined && !memo.has(path)) {
      for (let i = path.indexOf('/'); i > 0 && part === undefined; i = path.indexOf('/', i + 1)) if (m(path.slice(0, i))) part = path.slice(0, i)
      memo.set(path, part)
    }
    return part
  }
}

/** The files, or the functions in the files, a limit is about. */
function limited(graph: Graph, limit: Limit): { field: 'files' | 'functions'; nodes: GraphNode[] } {
  const field = 'files' in limit ? 'files' : 'functions'
  const take = selector('files' in limit ? limit.files : limit.functions)
  const skip = selector(limit.except)
  const files = new Set(graph.nodes.filter(n => n.kind === 'file' && take(n) && !skip(n)).map(n => n.path!))
  if (field === 'files') return { field, nodes: graph.nodes.filter(n => n.kind === 'file' && files.has(n.path!)) }
  return { field, nodes: graph.nodes.filter(n => isFunction(n) && files.has(n.path!)) }
}

export function selector(sel: Selector | undefined): (n: GraphNode) => boolean {
  if (sel === undefined) return () => false
  const patterns = [sel].flat()
  const tests = patterns.map(p => {
    if (p.startsWith('tag:') && p.includes('*')) {
      const re = new RegExp(`^${p.slice(4).split('*').map(escape).join('.*')}$`)
      return (n: GraphNode) => !!n.tags?.some(t => re.test(t))
    }
    if (p.startsWith('tag:')) return (n: GraphNode) => !!n.tags?.includes(p.slice(4))
    if (p.startsWith('s:')) {
      const m = matcher([p])
      return (n: GraphNode) => (n.kind === 'symbol' || n.kind === 'member') && m(n.id)
    }
    if (p.startsWith('layer:')) return (n: GraphNode) => !!n.tags?.includes(p)
    if (p.startsWith('x:')) {
      const m = matcher([p])
      return (n: GraphNode) => n.kind === 'external' && m(n.id)
    }
    // project files, and files inside the root the config excludes (src/generated/**)
    const m = matcher([p])
    return (n: GraphNode) => {
      const path = n.kind === 'file' ? n.path : n.id.startsWith(EXCLUDED) ? n.id.slice(EXCLUDED.length) : undefined
      return path !== undefined && m(path)
    }
  })
  return n => tests.some(t => t(n))
}

/** Checks the rules against the graph and records them, what breaks them and the counts in its metadata. */
export function applyRules(graph: Graph, rules: readonly Rule[]) {
  graph.meta.rules = rules.map(r => summarize(r, graph))
  graph.meta.violations = evaluateRules(graph, rules)
  graph.meta.counts.violations = graph.meta.violations.filter(v => v.severity === 'error').length
  graph.meta.counts.warnings = graph.meta.violations.length - graph.meta.counts.violations
  const unmatched = graph.meta.rules.filter(r => r.unmatched).length
  if (unmatched) graph.meta.counts.unmatchedRules = unmatched
  else delete graph.meta.counts.unmatchedRules
}

export function evaluateRules(graph: Graph, rules: readonly Rule[]): Violation[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const fileLevel = (id: string) => byId.get(id)?.kind === 'file' || byId.get(id)?.kind === 'external'
  const importEdges = graph.edges.filter(e => IMPORTS.has(e.kind) && fileLevel(e.source) && fileLevel(e.target) && e.source !== e.target)
  const out: Violation[] = []

  for (const rule of rules) {
    const severity = rule.severity ?? 'error'
    const inTarget = (e: GraphEdge) => !rule.target || e.targets.includes(rule.target)
    const edgesFor = (runtimeOnly?: boolean) => importEdges.filter(e => inTarget(e) && (!runtimeOnly || isRuntimeImport(e)))
    /** One violation per dependent/dependency pair, with every target it exists in. */
    const pairs = (edges: GraphEdge[], message: (e: GraphEdge) => string) => {
      const seen = new Map<string, Violation>()
      for (const e of edges) {
        const key = `${e.source}\u0000${e.target}`
        const v = seen.get(key)
        if (v) {
          for (const t of e.targets) if (!v.targets.includes(t)) v.targets.push(t)
          continue
        }
        seen.set(key, { rule: rule.name, severity, message: message(e), from: e.source, to: e.target, targets: [...e.targets] })
      }
      out.push(...seen.values())
    }
    const name = (id: string) => byId.get(id)?.path ?? byId.get(id)?.name ?? id

    if ('forbid' in rule) {
      const from = selector(rule.forbid.from)
      const to = selector(rule.forbid.to)
      const except = selector(rule.forbid.except)
      pairs(
        edgesFor(rule.runtimeOnly).filter(e => from(byId.get(e.source)!) && !except(byId.get(e.source)!) && to(byId.get(e.target)!)),
        e => `${name(e.source)} must not depend on ${name(e.target)}`,
      )
    } else if ('allow' in rule) {
      const from = selector(rule.allow.from)
      const to = selector(rule.allow.to)
      pairs(
        edgesFor(rule.runtimeOnly).filter(e => from(byId.get(e.source)!) && !to(byId.get(e.target)!)),
        e => `${name(e.source)} may not depend on ${name(e.target)} (outside what "${rule.name}" allows)`,
      )
    } else if ('apart' in rule) {
      const part = partOf(rule.apart)
      pairs(
        edgesFor(rule.runtimeOnly).filter(e => {
          const a = part(byId.get(e.source)?.path)
          const b = part(byId.get(e.target)?.path)
          return a !== undefined && b !== undefined && a !== b
        }),
        e => `${name(e.source)} must not depend on ${name(e.target)}: ${part(byId.get(e.source)?.path)} and ${part(byId.get(e.target)?.path)} are kept apart`,
      )
    } else if ('layers' in rule) {
      const order = graph.meta.layers ?? []
      const layerOf = (id: string) => {
        const tag = byId.get(id)?.tags?.find(t => t.startsWith('layer:'))
        return tag ? order.indexOf(tag.slice(6)) : -1
      }
      pairs(
        edgesFor(rule.runtimeOnly).filter(e => {
          const a = layerOf(e.source)
          const b = layerOf(e.target)
          return a >= 0 && b >= 0 && b < a
        }),
        e => `${order[layerOf(e.source)]} → ${order[layerOf(e.target)]} points up: ${name(e.source)} depends on ${name(e.target)}`,
      )
    } else if ('limit' in rule) {
      // one violation per node and metric out of bounds, the furthest out first
      const found: (Violation & { measure: NonNullable<Violation['measure']> })[] = []
      const { field, nodes } = limited(graph, rule.limit)
      for (const bound of ['max', 'min'] as const)
        for (const [metric, limit] of Object.entries(rule.limit[bound] ?? {}) as [string, number][])
          for (const n of nodes) {
            const value = n.metrics?.[metric]
            if (value === undefined || (bound === 'max' ? value <= limit : value >= limit)) continue
            const file = field === 'files' ? n.id : `f:${n.path}`
            const where = field === 'files' ? n.path! : `${n.path} › ${n.name}`
            found.push({
              rule: rule.name,
              severity,
              message: `${where}: ${metric} ${value}, ${bound === 'max' ? 'more' : 'less'} than ${limit}`,
              from: file,
              to: file,
              targets: graph.meta.targets,
              measure: { metric, value, bound, limit, ...(field === 'functions' ? { symbol: n.id } : {}) },
            })
          }
      const excess = (m: NonNullable<Violation['measure']>) => (m.bound === 'max' ? m.value - m.limit : m.limit - m.value) / Math.max(Math.abs(m.limit), 1)
      out.push(...found.sort((a, b) => excess(b.measure) - excess(a.measure) || cmp(a.measure.symbol ?? a.from, b.measure.symbol ?? b.from)))
    } else if ('cycles' in rule) {
      const scope = rule.scope === undefined ? () => true : selector(rule.scope)
      for (const c of graph.meta.cycles) {
        if (!c.some(id => byId.has(id) && scope(byId.get(id)!))) continue
        out.push({
          rule: rule.name,
          severity,
          message: `${c.length} files import each other: ${c.map(name).join(' → ')}`,
          from: c[0],
          to: c[1] ?? c[0],
          targets: graph.meta.targets,
          path: [...c, c[0]],
        })
      }
    } else if ('requireReach' in rule) {
      out.push(...requireReach(graph, rule, byId, severity))
    } else if ('forbidReach' in rule) {
      const from = selector(rule.forbidReach.from)
      const to = selector(rule.forbidReach.to)
      const except = selector(rule.forbidReach.except)
      for (const target of rule.target ? [rule.target] : graph.meta.targets) {
        const forward = new Map<string, string[]>()
        const backward = new Map<string, string[]>()
        for (const e of importEdges) {
          if (!e.targets.includes(target) || !isRuntimeImport(e)) continue
          push(forward, e.source, e.target)
          push(backward, e.target, e.source)
        }
        // one pass forward from every source finds what's reached at all; then, per offending
        // node (usually few), one pass backward finds who reaches it and the shortest way
        const starts = graph.nodes.filter(n => from(n)).map(n => n.id)
        const isStart = new Set(starts)
        const reached = bfs(starts, forward)
        const offending = [...reached.keys()].filter(id => to(byId.get(id)!) && !except(byId.get(id)!)).sort()
        for (const id of offending) {
          const back = bfs([id], backward)
          const sources = [...back.keys()].filter(s => s !== id && isStart.has(s))
          if (!sources.length) continue // only itself, as a source
          const path: string[] = []
          for (let p: string | undefined = sources[0]; p; p = back.get(p)) path.push(p)
          out.push({
            rule: rule.name,
            severity,
            message: `${name(id)} is reachable in ${target} from ${sources.length === 1 ? name(sources[0]) : `${sources.length} places`}: ${path.map(name).join(' → ')}`,
            from: path[0],
            to: id,
            targets: [target],
            path,
            sources: sources.sort(),
          })
        }
      }
    }
  }
  return out
}

/**
 * requireReach: each `from` (a file, or a function when the selector names
 * symbols) must run some `to` through what it calls, renders, creates or
 * queries, directly or through other code, a call into an interface counting
 * for its implementations. A file counts when any of its code does (its
 * module-level code too); a `to` file is reached by reaching any of its code.
 * One violation per `from` that doesn't, with the build targets it fails in.
 */
function requireReach(graph: Graph, rule: Rule & { requireReach: { from: Selector; to: Selector; except?: Selector } }, byId: Map<string, GraphNode>, severity: 'error' | 'warn'): Violation[] {
  const { from: fromSel, to: toSel, except: exceptSel } = rule.requireReach
  const [from, to, except] = [selector(fromSel), selector(toSel), selector(exceptSel)]
  const fileOf = (n: GraphNode) => (n.kind === 'file' ? n : n.path ? byId.get(`f:${n.path}`) : undefined)
  const children = new Map<string, string[]>()
  for (const n of graph.nodes) if (n.parent && (n.kind === 'symbol' || n.kind === 'member')) push(children, n.parent, n.id)
  // a path exception also spares the functions in that file
  const spared = (n: GraphNode) => except(n) || (n.kind !== 'file' && !!fileOf(n) && except(fileOf(n)!))
  const sources = graph.nodes.filter(n => (n.kind === 'file' || n.kind === 'symbol' || n.kind === 'member') && from(n) && !spared(n))
  const goals = new Set(graph.nodes.filter(to).map(n => n.id))
  const isGoal = (id: string) => {
    if (goals.has(id)) return true
    const n = byId.get(id)
    return (n?.kind === 'symbol' || n?.kind === 'member') && !!n.path && goals.has(`f:${n.path}`)
  }
  const implementations = new Map<string, string[]>()
  for (const e of graph.edges) if (e.kind === 'implements' || e.kind === 'overrides') push(implementations, e.target, e.source)
  const failing = new Map<string, string[]>() // source → the targets it fails in
  for (const target of rule.target ? [rule.target] : graph.meta.targets) {
    const runs = new Map<string, string[]>()
    for (const e of graph.edges) if (RUNS.has(e.kind) && e.targets.includes(target)) push(runs, e.source, e.target)
    for (const source of sources) {
      // what runs when it does: the function and its members (a class's methods), or all of a file
      const start = [source.id, ...descendants(source.id, children)]
      if (!reaches(start, runs, implementations, children, byId, isGoal)) push(failing, source.id, target)
    }
  }
  const words = [toSel].flat().map(symbolWords).join(' or ')
  return [...failing].sort((a, b) => cmp(a[0], b[0])).map(([id, targets]) => {
    const n = byId.get(id)!
    const file = fileOf(n)?.id ?? id
    const where = n.kind === 'file' ? n.path! : `${n.path} › ${id.slice(id.indexOf('#') + 1)}`
    return {
      rule: rule.name,
      severity,
      message: `${where} never reaches ${words}`,
      from: file,
      to: file,
      targets,
      expects: { to: words, ...(n.kind === 'file' ? {} : { symbol: id }) },
    }
  })
}

/** Breadth-first over what runs, from `start`, until a goal: an interface member leads to its implementations, a class to its constructor. */
function reaches(start: string[], runs: Map<string, string[]>, implementations: Map<string, string[]>, children: Map<string, string[]>, byId: Map<string, GraphNode>, isGoal: (id: string) => boolean): boolean {
  const seen = new Set(start)
  const queue = [...start]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (isGoal(id)) return true
    const next = [...(runs.get(id) ?? []), ...(implementations.get(id) ?? [])]
    if (byId.get(id)?.subkind === 'class') next.push(...(children.get(id) ?? []).filter(c => byId.get(c)?.subkind === 'constructor'))
    for (const n of next)
      if (!seen.has(n)) {
        seen.add(n)
        queue.push(n)
      }
  }
  return false
}

function descendants(id: string, children: Map<string, string[]>): string[] {
  const out: string[] = []
  for (const c of children.get(id) ?? []) out.push(c, ...descendants(c, children))
  return out
}

/** A selector in words: `s:src/lib/auth.ts#requireSession` → `requireSession (src/lib/auth.ts)`. */
export function symbolWords(p: string): string {
  if (!p.startsWith('s:') || !p.includes('#')) return p.replace(/^x:npm:/, '')
  return `${p.slice(p.indexOf('#') + 1)} (${p.slice(2, p.indexOf('#'))})`
}

/** File-level import cycles over runtime imports between project files, largest first (graph.meta.cycles). */
export function importCycles(graph: Graph): string[][] {
  const files = graph.nodes.filter(n => n.kind === 'file').map(n => n.id)
  const isFile = new Set(files)
  const adjacency = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!isRuntimeImport(e) || !isFile.has(e.target) || e.source === e.target) continue
    adjacency.set(e.source, [...(adjacency.get(e.source) ?? []), e.target])
  }
  return cycles(files, adjacency)
}

/** Breadth-first from `starts`: every reached node → the node it was reached from (undefined for a start), in visiting order. */
function bfs(starts: readonly string[], adjacency: ReadonlyMap<string, string[]>): Map<string, string | undefined> {
  const via = new Map<string, string | undefined>(starts.map(s => [s, undefined]))
  const queue = [...starts]
  for (let i = 0; i < queue.length; i++)
    for (const next of adjacency.get(queue[i]) ?? [])
      if (!via.has(next)) {
        via.set(next, queue[i])
        queue.push(next)
      }
  return via
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
