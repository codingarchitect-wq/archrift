// Transit view, part 1: the lines. Each line starts at an entry point (a page
// or an API route; without Next.js, a file tagged `entrypoint`) and runs down
// through the architecture layers to the data layer: a file that code queries
// (a Prisma schema, a Dexie database, an entity), or failing that a tRPC router
// or an HTTP handler. Of the
// paths there, it takes the one along the heaviest dependencies, found with a
// small dynamic program over the file graph. A line may fork once or twice
// towards other data. Pure and deterministic: no scene, no store.
import type { GraphEdge, GraphNode } from '../../../core/model.ts'

export interface TransitLine {
  /** The entry file, which is also the line's id. */
  id: string
  /** The route it serves (`/accounts`), or the entry file's name. */
  name: string
  /** The main path, entry first. */
  stations: string[]
  /** Short forks towards other data, each starting at a station of the main path. */
  branches: string[][]
  /** What the main path ends at. */
  end: 'data' | 'router' | 'none'
}

export interface Network {
  /** Best first (most stations), at most MAX_LINES. */
  lines: TransitLine[]
  /** Column names, left to right: the layers the lines pass through, then `data` for data files outside every layer. */
  columns: string[]
  /** Station → column index, for every station of every line. */
  column: Map<string, number>
  /** Entry points found (lines with fewer than two stations are left out). */
  entries: number
}

/** How two files depend on each other, from the edge kinds between them. */
export interface PairKinds {
  /** source → target → RUNTIME | RPC | QUERIES | REEXPORTS bits. */
  flags: Map<string, Map<string, number>>
  /** Files code queries: the data layer. */
  queried: Set<string>
  /** Files holding procedures a client calls: server routers. */
  called: Set<string>
}

export interface NetworkInput {
  /** The files shown (the filters applied). */
  files: readonly GraphNode[]
  /** File-level dependencies with summed reference counts (the viewer's DepGraph). */
  out: ReadonlyMap<string, readonly string[]>
  in: ReadonlyMap<string, readonly string[]>
  weight: ReadonlyMap<string, ReadonlyMap<string, number>>
  kinds: PairKinds
  /** Architecture layers, top to bottom. */
  order: readonly string[]
  layerOf: (file: GraphNode) => string | undefined
}

export const MAX_LINES = 40
/** Stations on a main path, and on a branch after its fork. */
const MAX_STATIONS = 9
const BRANCH_STATIONS = 3
const MAX_BRANCHES = 2
/** Forks tried per station, heaviest first. */
const BRANCH_TRIES = 4
/** Beyond this many entry points, the ones with the most dependencies. */
const MAX_ENTRIES = 600

// what ending somewhere is worth: data most, a router less, otherwise a little for each layer down
const DATA_BONUS = 20
const ROUTER_BONUS = 10
const DEPTH_BONUS = 0.5
/** A step is worth log2(1 + references) minus this, so a line takes a light dependency only when it leads somewhere. */
const STEP_COST = 1
/** A step within one layer costs more: it has to be heavy to be worth taking. */
const LEVEL_COST = 3

const RUNTIME = 1
const RPC = 2
const QUERIES = 4
const REEXPORTS = 8

const NONE = 0
const DOWN = 1
const CROSS = 2
const LEVEL = 3

const memo = new WeakMap<readonly GraphEdge[], { target: string; kinds: PairKinds }>()

/** File pairs by edge kind, over one build target (the last target's result is kept per edge list). */
export function pairKinds(edges: readonly GraphEdge[], target: string): PairKinds {
  const cached = memo.get(edges)
  if (cached?.target === target) return cached.kinds
  const kinds: PairKinds = { flags: new Map(), queried: new Set(), called: new Set() }
  for (const e of edges) {
    if (e.kind === 'co-changes' || e.kind === 'mocks' || !e.targets.includes(target)) continue
    if (!e.source.startsWith('f:') || !e.target.startsWith('f:') || e.source === e.target) continue
    let bits = 0
    // what a request can travel along: not types, not an href to another page
    const typeOnly = e.kind === 'type-ref' || ((e.kind === 'imports' || e.kind === 're-exports') && e.subkind === 'type-only')
    if (!typeOnly && e.kind !== 'navigates') bits |= RUNTIME
    // a call across the network: tRPC, or HTTP to another service's handler
    if (e.kind === 'rpc-call' || e.kind === 'http-call') {
      bits |= RPC
      kinds.called.add(e.target)
    }
    if (e.kind === 'queries') {
      bits |= QUERIES
      kinds.queried.add(e.target)
    }
    if (e.kind === 're-exports') bits |= REEXPORTS
    const row = kinds.flags.get(e.source) ?? new Map<string, number>()
    row.set(e.target, (row.get(e.target) ?? 0) | bits)
    kinds.flags.set(e.source, row)
  }
  memo.set(edges, { target, kinds })
  return kinds
}

const routeOf = (n: GraphNode) => n.tags?.find(t => t.startsWith('route:') || t.startsWith('api:'))
const stem = (name: string) => name.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, '')

/** A file's name without its extension, after its folder's: `routers/index`. */
const withFolder = (n: GraphNode) => {
  const dir = n.path?.split('/').slice(-2, -1)[0]
  return dir ? `${dir}/${stem(n.name)}` : stem(n.name)
}

/** A station's name on the map: the file name without its extension; with its folder for an index file. */
export function stationName(n: GraphNode): string {
  return /^(index|page|route|layout|main|mod)$/.test(stem(n.name)) ? withFolder(n) : stem(n.name)
}

export function buildNetwork(input: NetworkInput): Network {
  const { out, weight, kinds } = input
  const byId = new Map(input.files.map(f => [f.id, f]))
  const layerIndex = new Map(input.order.map((l, i) => [l, i]))
  const dataColumn = input.order.length
  const isData = (id: string) => kinds.queried.has(id) || !!byId.get(id)?.tags?.includes('prisma-schema')

  // a barrel (a file that only re-exports) is passed through, not a station: its users call what it re-exports directly
  const isBarrel = (id: string) => {
    const row = kinds.flags.get(id)
    return !!row && row.size > 1 && [...row.values()].every(bits => bits & REEXPORTS || !(bits & RUNTIME))
  }

  // columns: a file's layer; data outside every layer goes to a last column
  const col = new Map<string, number>()
  for (const f of input.files) {
    if (f.tags?.includes('test') || f.tags?.includes('asset') || isBarrel(f.id)) continue
    const layer = input.layerOf(f)
    const i = layer === undefined ? undefined : layerIndex.get(layer)
    if (i !== undefined) col.set(f.id, i)
    else if (isData(f.id)) col.set(f.id, dataColumn)
  }

  // entry points: pages and API routes, else `entrypoint` files, else top-layer files nothing depends on
  let entries = input.files.filter(f => routeOf(f) && !f.tags?.includes('test'))
  if (!entries.length) entries = input.files.filter(f => f.tags?.includes('entrypoint') && !f.tags?.includes('test'))
  if (!entries.length) entries = input.files.filter(f => col.get(f.id) === 0 && !(input.in.get(f.id) ?? []).some(s => col.has(s)) && (out.get(f.id)?.length ?? 0) > 0)
  for (const f of entries) if (!col.has(f.id)) col.set(f.id, 0) // an entry outside every layer starts at the left
  if (entries.length > MAX_ENTRIES) {
    const degree = (f: GraphNode) => out.get(f.id)?.length ?? 0
    entries = [...entries].sort((a, b) => degree(b) - degree(a) || cmp(a.id, b.id)).slice(0, MAX_ENTRIES)
  }

  // with a single layer (areas all in one cycle), a line can't go down: it follows heavy dependencies within it
  const flat = new Set(col.values()).size <= 1
  const levelCost = flat ? -DEPTH_BONUS : LEVEL_COST
  const onward = (kind: number) => kind === DOWN || (flat && kind === LEVEL)

  // the steps a line may take, with what each is worth
  const ids = [...col.keys()].sort(cmp)
  const index = new Map(ids.map((id, i) => [id, i]))
  const steps: { v: number; kind: number; score: number }[][] = ids.map(u => {
    const cu = col.get(u)!
    const list: { v: number; kind: number; score: number }[] = []
    for (const v of out.get(u) ?? []) {
      const bits = kinds.flags.get(u)?.get(v) ?? 0
      const cv = col.get(v)
      if (!(bits & RUNTIME) || cv === undefined) continue
      // down a layer; a call to the server or a query anywhere (that's where the request goes); or within the layer
      const kind = cv > cu ? DOWN : bits & (RPC | QUERIES) ? CROSS : cv === cu ? LEVEL : NONE
      if (kind === NONE) continue
      const score = Math.log2(1 + (weight.get(u)?.get(v) ?? 1)) - STEP_COST - (kind === LEVEL ? levelCost : 0)
      list.push({ v: index.get(v)!, kind, score })
    }
    // code that queries data itself goes straight there
    const direct = list.filter(s => s.kind !== LEVEL && isData(ids[s.v]) && (kinds.flags.get(u)?.get(ids[s.v]) ?? 0) & QUERIES)
    return (direct.length ? direct : list).sort((a, b) => a.v - b.v)
  })

  /**
   * best[k][i]: the most a line from file i can still be worth in k more
   * steps, ending at data (or a router); without data in reach, going down
   * as far as heavy dependencies lead (within a layer only when there's one).
   */
  const plan = (toData: boolean) => {
    const endValue = ids.map(id => (isData(id) ? DATA_BONUS : kinds.called.has(id) ? ROUTER_BONUS : toData ? -Infinity : col.get(id)! * DEPTH_BONUS))
    const best: Float64Array[] = [Float64Array.from(endValue)]
    for (let k = 1; k < MAX_STATIONS; k++) {
      const prev = best[k - 1]
      const next = new Float64Array(ids.length)
      for (let i = 0; i < ids.length; i++) {
        let value = endValue[i]
        if (!isData(ids[i])) for (const s of steps[i]) if (toData || onward(s.kind)) value = Math.max(value, s.score + prev[s.v])
        next[i] = value
      }
      best.push(next)
    }
    return { toData, endValue, best }
  }
  const toData = plan(true)
  const downward = plan(false)

  /** The best path from `start` of at most `maxStations`, never through `avoid`. */
  const walk = (start: string, maxStations: number, avoid: ReadonlySet<string>, p: ReturnType<typeof plan>) => {
    const path = [start]
    const seen = new Set(avoid).add(start)
    let u = index.get(start)!
    for (let left = maxStations - 1; left > 0; left--) {
      if (path.length > 1 && isData(ids[u])) break
      let value = p.endValue[u] + 1e-9
      let next: (typeof steps)[number][number] | undefined
      for (const s of steps[u]) {
        if (seen.has(ids[s.v]) || (!p.toData && !onward(s.kind))) continue
        const v = s.score + p.best[left - 1][s.v]
        if (v > value) {
          value = v
          next = s
        }
      }
      if (!next) break
      path.push(ids[next.v])
      seen.add(ids[next.v])
      u = next.v
    }
    return path
  }

  const endOf = (id: string): TransitLine['end'] => (isData(id) ? 'data' : kinds.called.has(id) ? 'router' : 'none')
  const lines: TransitLine[] = []
  for (const entry of entries) {
    const start = index.get(entry.id)!
    const toward = toData.best[MAX_STATIONS - 1][start] > -Infinity ? toData : downward
    const stations = walk(entry.id, MAX_STATIONS, new Set(), toward)
    const on = new Set(stations)
    // forks towards other data: from each station, its most promising dependencies off the line
    const branches: string[][] = []
    for (let i = 0; i < stations.length - 1 && branches.length < MAX_BRANCHES; i++) {
      const u = index.get(stations[i])!
      const forks = steps[u]
        .filter(s => !on.has(ids[s.v]) && s.kind !== LEVEL && toData.best[BRANCH_STATIONS - 1][s.v] > -Infinity)
        .map(s => ({ s, value: s.score + toData.best[BRANCH_STATIONS - 1][s.v] }))
        .sort((a, b) => b.value - a.value || a.s.v - b.s.v)
        .slice(0, BRANCH_TRIES)
      for (const { s } of forks) {
        const path = walk(ids[s.v], BRANCH_STATIONS, on, toData)
        if (endOf(path[path.length - 1]) === 'none') continue
        branches.push([stations[i], ...path])
        path.forEach(id => on.add(id))
        break
      }
    }
    if (on.size < 2) continue
    const route = routeOf(entry)
    lines.push({ id: entry.id, name: route ? route.slice(route.indexOf(':') + 1) : stem(entry.name), stations, branches, end: endOf(stations[stations.length - 1]) })
  }

  // entry files sharing a name are told apart by their folder
  const names = new Map<string, number>()
  for (const l of lines) names.set(l.name, (names.get(l.name) ?? 0) + 1)
  for (const l of lines) if (names.get(l.name)! > 1 && !routeOf(byId.get(l.id)!)) l.name = withFolder(byId.get(l.id)!)

  const size = (l: TransitLine) => l.stations.length + l.branches.reduce((n, b) => n + b.length - 1, 0)
  const endRank = { data: 2, router: 1, none: 0 }
  lines.sort((a, b) => size(b) - size(a) || endRank[b.end] - endRank[a.end] || cmp(a.name, b.name) || cmp(a.id, b.id))
  const kept = lines.slice(0, MAX_LINES)

  // the columns the kept lines use, in layer order
  const used = new Set<number>()
  for (const l of kept) for (const id of [...l.stations, ...l.branches.flat()]) used.add(col.get(id)!)
  const usedColumns = [...used].sort((a, b) => a - b)
  const compact = new Map(usedColumns.map((c, i) => [c, i]))
  const column = new Map<string, number>()
  for (const l of kept) for (const id of [...l.stations, ...l.branches.flat()]) column.set(id, compact.get(col.get(id)!)!)
  const columns = usedColumns.map(c => (c === dataColumn ? 'data' : input.order[c]))
  return { lines: kept, columns, column, entries: entries.length }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
