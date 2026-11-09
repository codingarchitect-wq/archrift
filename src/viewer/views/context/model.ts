// §3 Context view, part 2: the system's neighbors and the ties to them.
// Outbound: the packages that reach outside (the catalog), the message broker
// its topics run through, and the data stores code queries (a Prisma schema,
// a Dexie database, the databases services' configuration names). Inbound: whoever
// calls the system: people through its pages, and API routes grouped by
// their first segment, with a guess at the caller (a webhook route is called
// back by the service it talks to, a cron route by a scheduler). Each tie
// enters the system at the layer most of its files are in (a second or third
// layer when it holds a fair share), so the context diagram shows which layer
// talks to whom. Pure and deterministic: no scene, no store.
import { dirId } from '../../../core/ids.ts'
import type { GraphEdge, GraphNode } from '../../../core/model.ts'
import { BROKER, databaseSystem, excludedSystem, packageOf, systemOf } from './catalog.ts'
import type { NeighborKind, Side, SystemInfo } from './catalog.ts'

export const NO_LAYER = '(no layer)'

export interface ContextInput {
  /** The system's name. */
  name: string
  /** The overview graph: directories, files and externals, edges at file level. */
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  /** The build target the edges count in. */
  target: string
  /** The files shown (the filters applied). */
  isShown: (file: GraphNode) => boolean
  /** Architecture layers, top to bottom, and a file's layer. */
  order: readonly string[]
  layerOf: (file: GraphNode) => string | undefined
  /** Layer labels, when they differ from the names (layers derived from dependencies). */
  labels?: ReadonlyMap<string, string>
}

/** A connection between a neighbor and one layer of the system. */
export interface Tie {
  dir: 'in' | 'out'
  /** The tower slab it enters. */
  slab: number
  /** The system's files on its end. */
  files: string[]
  channel: string
  /** Inbound: the route groups it comes in through (`/api/cron`, `pages`). */
  routes: string[]
  /** Its share of the neighbor's files in its direction (0–1). */
  share: number
  /** What clicking it selects. */
  select: string
}

export interface Neighbor {
  key: string
  name: string
  kind: NeighborKind
  side: Side
  about: string
  /** The node selected for it: the store file code queries, the package most files use, or the routes' folder. */
  select: string
  /** Nodes that stand for it: packages, store files, route files. */
  ids: string[]
  ties: Tie[]
  /** Distinct system files tied to it. */
  files: number
}

export interface Slab {
  name: string
  label: string
  /** Files shown in the layer. */
  files: number
  /** The folder that best stands for the layer (clicking the slab selects it), if any. */
  select?: string
}

export interface ContextModel {
  name: string
  /** One per layer, top first; `(no layer)` last when a tie needs it. */
  slabs: Slab[]
  /** Callers first, then the services the system calls, then its data stores; within each, most files first. */
  neighbors: Neighbor[]
  /** Packages the system uses that don't reach outside it. */
  libraries: string[]
}

/** A layer holding at least this share of a neighbor's files gets a tie of its own. */
const TIE_SHARE = 0.15
const MAX_TIES = 3
/** How far a webhook route is followed to find the service calling it back. */
const WEBHOOK_REACH = 3

const CALLERS: Record<string, SystemInfo> = {
  user: { key: 'user', name: 'User (browser)', kind: 'person', side: 'in', channel: 'HTTPS', about: 'people using the app', rank: 1 },
  scheduler: { key: 'scheduler', name: 'Scheduler', kind: 'scheduler', side: 'in', channel: 'HTTPS', about: 'timed jobs', rank: 1 },
  monitor: { key: 'monitor', name: 'Monitoring', kind: 'monitor', side: 'in', channel: 'HTTPS', about: 'health checks', rank: 1 },
  webhooks: { key: 'webhooks', name: 'Webhook senders', kind: 'clients', side: 'in', channel: 'HTTPS', about: 'outside systems calling back', rank: 1 },
  clients: { key: 'clients', name: 'API clients', kind: 'clients', side: 'in', channel: 'HTTPS', about: 'other callers of the API', rank: 1 },
  callers: { key: 'callers', name: 'Callers', kind: 'person', side: 'in', channel: 'calls', about: 'whoever runs the entry points', rank: 1 },
}

const SIDE_ORDER: Record<Side, number> = { in: 0, out: 1, store: 2 }

export function contextModel(input: ContextInput): ContextModel {
  const byId = new Map(input.nodes.map(n => [n.id, n]))
  const shown = new Set(input.nodes.filter(n => n.kind === 'file' && input.isShown(n)).map(n => n.id))
  const counts = (e: GraphEdge) => e.targets.includes(input.target) && e.kind !== 'co-changes' && e.kind !== 'mocks'
  // what runs: no types, no links to other pages
  const runs = (e: GraphEdge) => counts(e) && e.kind !== 'type-ref' && e.kind !== 'navigates' && !((e.kind === 'imports' || e.kind === 're-exports') && e.subkind === 'type-only')

  // neighbors by key, with the files on the system's side per direction
  const found = new Map<string, { info: SystemInfo; ids: Set<string>; out: Set<string>; in: Map<string, string>; stores: Map<string, number>; users: Map<string, number> }>()
  const neighbor = (info: SystemInfo) => {
    let n = found.get(info.key)
    if (!n) found.set(info.key, (n = { info, ids: new Set(), out: new Set(), in: new Map(), stores: new Map(), users: new Map() }))
    else if (info.rank > n.info.rank) n.info = { ...n.info, name: info.name, rank: info.rank }
    return n
  }

  // packages: catalogued ones are neighbors, the rest libraries
  const systemOfNode = new Map<string, SystemInfo>()
  const libraries = new Set<string>()
  const runtimeOut = new Map<string, Set<string>>()
  for (const e of input.edges) {
    if (!runs(e) || !shown.has(e.source)) continue
    const set = runtimeOut.get(e.source) ?? new Set<string>()
    set.add(e.target)
    runtimeOut.set(e.source, set)
  }
  for (const n of input.nodes) {
    if (n.kind !== 'external') continue
    const pkg = packageOf(n.id)
    const info = n.tags?.includes('topic') ? BROKER : (pkg ? systemOf(pkg) : undefined) ?? excludedSystem(n.id)
    if (info) systemOfNode.set(n.id, info)
  }
  for (const e of input.edges) {
    if (!runs(e) || !shown.has(e.source)) continue
    const info = systemOfNode.get(e.target)
    if (info) {
      const nb = neighbor(info)
      nb.ids.add(e.target)
      nb.out.add(e.source)
      nb.users.set(e.target, (nb.users.get(e.target) ?? 0) + 1)
    } else if (byId.get(e.target)?.kind === 'external' && packageOf(e.target)) libraries.add(packageOf(e.target)!)
  }

  // data stores: what code queries. A database node is its engine's store, a Prisma schema the SQL database, an
  // entity's file its store's (db:sql, db:mongodb), anything else the analyzer queries is a Dexie database
  const dbTag = (n: GraphNode) => n.tags?.find(t => t.startsWith('db:'))?.slice(3)
  for (const e of input.edges) {
    if (e.kind !== 'queries' || !counts(e) || !shown.has(e.source)) continue
    const store = byId.get(e.target)
    if (!store) continue
    const info = store.tags?.includes('database')
      ? databaseSystem(store.tags.find(t => t !== 'database' && t !== 'infra'))
      : store.tags?.includes('prisma-schema')
        ? systemOf('prisma')!
        : dbTag(store)
          ? databaseSystem(dbTag(store) === 'mongodb' ? 'mongodb' : undefined)
          : (storeSystemOf(e.target, runtimeOut, systemOfNode) ?? systemOf('dexie')!)
    const nb = neighbor(info)
    nb.ids.add(e.target)
    nb.out.add(e.source)
    nb.stores.set(e.target, (nb.stores.get(e.target) ?? 0) + e.count)
  }

  // callers: pages and API routes, or the entry points of a project without them
  const routeOf = (n: GraphNode) => n.tags?.find(t => t.startsWith('route:') || t.startsWith('api:'))
  const routed = [...shown].map(id => byId.get(id)!).filter(routeOf).sort((a, b) => cmp(a.id, b.id))
  for (const file of routed) {
    const route = routeOf(file)!
    const path = route.slice(route.indexOf(':') + 1)
    const segments = path.split('/').filter(Boolean)
    const group = route.startsWith('route:') ? 'pages' : `/${segments.slice(0, 2).join('/')}`
    neighbor(callerOf(file, route, segments, runtimeOut, systemOfNode)).in.set(file.id, group)
  }
  if (!routed.length) {
    const entries = [...shown].map(id => byId.get(id)!).filter(n => n.tags?.includes('entrypoint') && !n.tags.includes('test') && !n.tags.includes('prisma-schema') && !/(^|\.)config\.[cm]?[jt]sx?$/.test(n.name))
    for (const file of entries.sort((a, b) => cmp(a.id, b.id))) neighbor(CALLERS.callers).in.set(file.id, 'entry points')
  }

  // the tower: configured (or derived) layers, and a last slab for files in none when a tie needs one
  const layerIndex = new Map(input.order.map((l, i) => [l, i]))
  const slabOf = (id: string) => {
    const layer = input.layerOf(byId.get(id)!)
    const i = layer === undefined ? undefined : layerIndex.get(layer)
    return i ?? input.order.length
  }
  const tiesOf = (files: string[], dir: Tie['dir'], channel: string, groupOf: (f: string) => string | undefined, select: (files: string[]) => string): Tie[] => {
    const bySlab = new Map<number, string[]>()
    for (const f of files) push(bySlab, slabOf(f), f)
    const ranked = [...bySlab].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
    return ranked
      .filter(([, list], i) => i === 0 || list.length / files.length >= TIE_SHARE)
      .slice(0, MAX_TIES)
      .map(([slab, list]) => ({
        dir,
        slab,
        files: list.sort(cmp),
        channel,
        routes: [...new Set(list.map(groupOf).filter((g): g is string => !!g))].sort(routeOrder),
        share: list.length / files.length,
        select: select(list),
      }))
  }

  const neighbors: Neighbor[] = []
  for (const nb of found.values()) {
    const { info } = nb
    const inFiles = [...nb.in.keys()]
    const outFiles = [...nb.out]
    const strongest = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0]
    const routesFolder = (files: string[]) => commonFolder(files, byId)
    const select = strongest(nb.stores) ?? strongest(nb.users) ?? routesFolder(inFiles)
    const ties = [
      ...(inFiles.length ? tiesOf(inFiles, 'in', info.side === 'in' ? info.channel : 'HTTPS', f => nb.in.get(f), routesFolder) : []),
      ...(outFiles.length ? tiesOf(outFiles, 'out', info.channel, () => undefined, () => select) : []),
    ]
    neighbors.push({
      key: info.key,
      name: info.name,
      kind: info.kind,
      side: info.side,
      about: info.about,
      select,
      ids: [...new Set([...nb.ids, ...inFiles])].sort(cmp),
      ties,
      files: new Set([...inFiles, ...outFiles]).size,
    })
  }
  neighbors.sort((a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || b.files - a.files || cmp(a.name, b.name))

  const needsNoLayer = neighbors.some(n => n.ties.some(t => t.slab === input.order.length))
  const names = needsNoLayer ? [...input.order, NO_LAYER] : [...input.order]
  const taken = new Set(neighbors.map(n => n.select))
  const slabs: Slab[] = names.map((name, i) => {
    const files = [...shown].filter(id => slabOf(id) === i)
    const select = i < input.order.length ? layerFolder(files, shown, slabOf, i, byId) : undefined
    const free = select && !taken.has(select) ? select : undefined
    if (free) taken.add(free)
    return { name, label: input.labels?.get(name) ?? name, files: files.length, select: free }
  })
  return { name: input.name, slabs, neighbors, libraries: [...libraries].sort(cmp) }
}

/** Who calls an API route: a webhook the service it reaches, a cron route a scheduler, health checks monitoring, the app's own endpoints its user. */
function callerOf(file: GraphNode, route: string, segments: string[], out: ReadonlyMap<string, ReadonlySet<string>>, systems: ReadonlyMap<string, SystemInfo>): SystemInfo {
  if (route.startsWith('route:')) return CALLERS.user
  const parts = segments.slice(1).map(s => s.toLowerCase())
  if (parts.some(s => /^webhooks?$/.test(s) || s.endsWith('webhook'))) {
    // the nearest service: what the route uses itself, failing that what the code it calls uses
    for (let depth = 1; depth <= WEBHOOK_REACH; depth++) {
      const services = new Map<string, SystemInfo>()
      for (const id of reachable(file.id, out, depth)) {
        const info = systems.get(id)
        if (info?.side === 'out' && info.kind === 'service') services.set(info.key, info)
      }
      if (services.size) return services.size === 1 ? [...services.values()][0] : CALLERS.webhooks
    }
    return CALLERS.webhooks
  }
  if (parts.some(s => /^(cron|crons|jobs?|scheduled?)$/.test(s))) return CALLERS.scheduler
  if (parts.some(s => /^(health|healthz|status|ready|readyz|live|livez|ping)$/.test(s))) return CALLERS.monitor
  if (/^(trpc|auth|graphql|session|me)$/.test(parts[0] ?? '')) return CALLERS.user
  return CALLERS.clients
}

/** The store package a queried file uses itself, if it's one the catalog knows. */
function storeSystemOf(file: string, out: ReadonlyMap<string, ReadonlySet<string>>, systems: ReadonlyMap<string, SystemInfo>): SystemInfo | undefined {
  for (const id of out.get(file) ?? []) {
    const info = systems.get(id)
    if (info?.side === 'store') return info
  }
  return undefined
}

/** Everything a file reaches at run time within `depth` steps. */
function reachable(start: string, out: ReadonlyMap<string, ReadonlySet<string>>, depth: number): Set<string> {
  const seen = new Set([start])
  let frontier = [start]
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = []
    for (const id of frontier)
      for (const t of out.get(id) ?? []) {
        if (seen.has(t)) continue
        seen.add(t)
        next.push(t)
      }
    frontier = next
  }
  return seen
}

/** The innermost folder holding all of these files; the file itself when there's one. */
export function commonFolder(files: readonly string[], byId: ReadonlyMap<string, GraphNode>): string {
  if (files.length === 1) return files[0]
  const dirs = files.map(f => (byId.get(f)?.path ?? '').split('/').slice(0, -1))
  const first = dirs[0] ?? []
  let k = 0
  while (k < first.length && dirs.every(d => d[k] === first[k])) k++
  return dirId(first.slice(0, k).join('/'))
}

/** The folder that stands best for a layer: the most of its files below it, less any of another layer's. */
function layerFolder(files: readonly string[], shown: ReadonlySet<string>, slabOf: (id: string) => number, slab: number, byId: ReadonlyMap<string, GraphNode>): string | undefined {
  const score = new Map<string, number>()
  const add = (file: string, delta: number) => {
    const parts = (byId.get(file)?.path ?? '').split('/').slice(0, -1)
    for (let k = 0; k <= parts.length; k++) {
      const dir = dirId(parts.slice(0, k).join('/'))
      score.set(dir, (score.get(dir) ?? 0) + delta)
    }
  }
  for (const f of files) add(f, 1)
  for (const f of shown) if (slabOf(f) !== slab) add(f, -1)
  // the deepest of the best: a tie goes to the folder further down
  return [...score].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || cmp(a[0], b[0]))[0]?.[0]
}

/** Pages before API routes, then by name. */
const routeOrder = (a: string, b: string) => (a === 'pages' ? -1 : b === 'pages' ? 1 : cmp(a, b))

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
