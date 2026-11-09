// Functional features: the vertical slices a user would name (accounts,
// contracts, plans …), found across the technical layers a codebase is
// folded into. Seeds are the pages and API routes, one feature per first
// route segment (`/accounts`, `/api/upgrade/webhook` → upgrade; layouts are
// the app shell). A feature reaches what its seeds run: calls, renders,
// `new`, references, tRPC calls and queries at symbol level, through an
// interface to the classes implementing it, so one shared service class
// doesn't tie every feature together. Then each file gets its owner:
//   1. a file named after a feature (`routers/contracts.ts`,
//      `order-cost-history.ts`; route groups like `(dashboard)` aren't
//      names) belongs to it, outside folders most of whose files are shared:
//      what such a folder holds is common code (a UI kit's `progress.tsx`
//      isn't the /progress page's, nor is its `sheet.tsx` the one feature's
//      using it);
//   2. else a file one feature reaches belongs to it;
//   3. else one a few features reach belongs to the one whose own files use
//      it most;
//   4. else, reached by many, it is shared: common code, not a module.
// Files no feature reaches and no name ties to one stay without. Pure and
// deterministic.
import { GraphIndex } from './graph-index.ts'
import type { Graph, GraphNode } from './model.ts'

export interface FeatureOptions {
  /** A feature's name → route prefixes it stands for (`auth: ["/login", "/api/auth"]`); also renames one. */
  merge: Record<string, string[]>
  /** Route prefixes that are no feature (beside the transports left out by default). */
  exclude: string[]
}

export interface FeatureSummary {
  name: string
  /** The routes it was found from (`layout:/` for the shell). */
  routes: string[]
  /** Files it owns. */
  files: number
}

export interface Features {
  /** Most files first. */
  features: FeatureSummary[]
  /** A file → the feature owning it. */
  owner: Map<string, string>
  /** Files many features reach: common code. */
  shared: Set<string>
  /** A file → the features reaching it (for tests and the inspector). */
  reachedBy: Map<string, string[]>
}

/** The feature layouts seed: the frame every page sits in. */
export const SHELL = 'app shell'

/** Routes that carry every feature's calls, not one feature: a tRPC or GraphQL endpoint, health checks. */
const TRANSPORTS = new Set(['trpc', 'graphql', 'rpc', 'health', 'healthz', 'livez', 'readyz', 'status', 'metrics', 'ping'])
/** What a feature runs through. */
const WALKED = new Set(['calls', 'renders', 'instantiates', 'references', 'rpc-call', 'queries', 'spawns-worker'])
/**
 * Common code: a folder whose reached files most (this share) are used by two features or more,
 * and hardly any (less than NAMED_FOLDER) are named after a feature (a UI kit, chart primitives).
 */
const SHARED_FOLDER = 0.6
const NAMED_FOLDER = 0.1

export function findFeatures(graph: Graph, options: FeatureOptions = { merge: {}, exclude: [] }): Features {
  const index = new GraphIndex(graph)
  const isTest = (f: GraphNode | undefined) => !!f?.tags?.includes('test')

  // seeds: pages and API routes by their feature; layouts make the shell
  const seeds = new Map<string, { files: string[]; routes: string[] }>()
  const seed = (feature: string, file: string, route: string) => {
    const s = seeds.get(feature) ?? { files: [], routes: [] }
    s.files.push(file)
    if (!s.routes.includes(route)) s.routes.push(route)
    seeds.set(feature, s)
  }
  for (const n of graph.nodes) {
    if (n.kind !== 'file' || isTest(n)) continue
    for (const tag of n.tags ?? []) {
      if (tag.startsWith('layout:')) seed(SHELL, n.id, tag)
      if (!tag.startsWith('route:') && !tag.startsWith('api:')) continue
      const route = tag.slice(tag.indexOf(':') + 1)
      const feature = featureOfRoute(route, options)
      if (feature) seed(feature, n.id, route)
    }
  }
  const empty: Features = { features: [], owner: new Map(), shared: new Set(), reachedBy: new Map() }
  if (![...seeds.keys()].some(f => f !== SHELL)) return empty

  // what each feature reaches, as files
  const implementations = new Map<string, string[]>()
  for (const e of graph.edges)
    if (e.kind === 'implements' || e.kind === 'overrides') implementations.set(e.target, [...(implementations.get(e.target) ?? []), e.source])
  const reachedBy = new Map<string, string[]>()
  for (const [feature, { files }] of [...seeds].sort((a, b) => cmp(a[0], b[0]))) {
    const seen = new Set<string>()
    const stack = files.flatMap(f => [f, ...index.descendants(f).map(d => d.id)])
    const reached = new Set<string>()
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const file = index.fileOf(id)
      if (!file || isTest(file)) continue
      if (!reached.has(file.id)) {
        reached.add(file.id)
        stack.push(file.id) // its module-level code runs too
      }
      for (const e of index.out(id)) if (WALKED.has(e.kind)) stack.push(e.target)
      for (const m of implementations.get(id) ?? []) stack.push(m)
    }
    for (const f of reached) reachedBy.set(f, [...(reachedBy.get(f) ?? []), feature])
  }

  const features = [...seeds.keys()]
  const sharedAt = Math.max(3, Math.ceil(features.length * 0.25))
  const tokensOf = new Map(features.map(f => [f, new Set(words(f))]))
  // the features a file is named after (route groups like `(dashboard)` only organize: no name), most specific first
  const namedAfter = (f: GraphNode) => {
    const mine = new Set(words((f.path ?? f.name).replace(/\([^/)]*\)/g, '')))
    const by = reachedBy.get(f.id) ?? []
    return features
      .filter(x => x !== SHELL && [...tokensOf.get(x)!].every(w => mine.has(w)))
      .sort((a, b) => tokensOf.get(b)!.size - tokensOf.get(a)!.size || Number(by.includes(b)) - Number(by.includes(a)) || cmp(a, b))
  }

  // folders of common code
  const reachedIn = new Map<string, { all: number; shared: number; named: number }>()
  for (const [file, by] of reachedBy) {
    const n = index.node(file)!
    const c = reachedIn.get(n.parent ?? '') ?? { all: 0, shared: 0, named: 0 }
    c.all++
    if (by.length >= 2) c.shared++
    if (namedAfter(n).length) c.named++
    reachedIn.set(n.parent ?? '', c)
  }
  const commonFolder = (dir: string) => {
    const c = reachedIn.get(dir)
    return !!c && c.all >= 3 && c.shared / c.all >= SHARED_FOLDER && c.named / c.all < NAMED_FOLDER
  }

  const owner = new Map<string, string>()
  const shared = new Set<string>()
  const files = graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('asset'))
  const contested: string[] = []
  for (const f of files) {
    const by = reachedBy.get(f.id) ?? []
    // a folder of common code: whatever reaches its files, they're shared
    if (commonFolder(f.parent ?? '')) {
      if (by.length) shared.add(f.id)
      continue
    }
    // 1. its name: the most specific; between equals, one that reaches it, then the first by name
    const named = namedAfter(f)
    if (named.length) {
      owner.set(f.id, named[0])
      continue
    }
    if (isTest(f)) continue
    // 2. the one feature reaching it; 4. many reaching it
    if (by.length === 1) owner.set(f.id, by[0])
    else if (by.length >= sharedAt) shared.add(f.id)
    else if (by.length > 1) contested.push(f.id)
  }
  // 3. a few reaching it: the one whose own files use it most (none or a tie: shared)
  const useBy = new Map<string, Map<string, number>>()
  const contestedSet = new Set(contested)
  for (const e of graph.edges) {
    const target = index.fileOf(e.target)?.id
    if (!target || !contestedSet.has(target)) continue
    const from = owner.get(index.fileOf(e.source)?.id ?? '')
    if (!from) continue
    const m = useBy.get(target) ?? new Map<string, number>()
    m.set(from, (m.get(from) ?? 0) + e.count)
    useBy.set(target, m)
  }
  for (const f of contested) {
    const by = new Set(reachedBy.get(f))
    const ranked = [...(useBy.get(f) ?? [])].filter(([x]) => by.has(x)).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) owner.set(f, ranked[0][0])
    else shared.add(f)
  }

  const owned = new Map<string, number>()
  for (const x of owner.values()) owned.set(x, (owned.get(x) ?? 0) + 1)
  const summaries = features
    .map(name => ({ name, routes: [...seeds.get(name)!.routes].sort(), files: owned.get(name) ?? 0 }))
    .filter(s => s.files > 0)
    .sort((a, b) => b.files - a.files || cmp(a.name, b.name))
  return { features: summaries, owner, shared, reachedBy }
}

/**
 * The feature a route belongs to: a merge that claims it, else its first
 * static segment (`/api/x/y` → x; parameters are `[id]` or Angular's `:id`, and
 * an Angular named outlet `(outlet:x)` counts as x); undefined when left out.
 */
export function featureOfRoute(route: string, options: FeatureOptions): string | undefined {
  // a prefix covers its route and the ones below it; `/` only itself (every route is below it)
  const within = (prefix: string) => route === prefix || (prefix !== '/' && route.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
  if (options.exclude.some(within)) return undefined
  for (const [name, prefixes] of Object.entries(options.merge)) if (prefixes.some(within)) return name
  let segments = route.split('/').filter(Boolean).map(s => s.replace(/^\([^:)]+:(.*)\)$/, '$1'))
  if (segments[0] === 'api') segments = segments.slice(1)
  if (segments.length && TRANSPORTS.has(segments[0])) return undefined
  // a variable ([id], :id, {id}) or an API version (v2) names no feature
  return segments.find(s => !/^\[.*\]$|^:|^\{.*\}$|^v\d+$/.test(s)) ?? (route.startsWith('/api') ? undefined : 'home')
}

/** A path's or name's words, lowercase and singular: split at separators and camel case (`useCurrentFinancesCrud` → use, current, finance, crud). */
export function words(text: string): string[] {
  return text
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[/\\._\-\s()[\]@+]+/)
    .flatMap(p => p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .map(w => singular(w.toLowerCase()))
    .filter(Boolean)
}

const singular = (w: string) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
