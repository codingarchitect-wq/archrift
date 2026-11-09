// Databases (docs/POLYGLOT.md, P4): one node per database
// (`x:db:<engine>:<key>`, tagged `database` and `infra`). A module with
// Spring Data repositories uses the databases its configuration connects to
// (`spring.datasource.url`, `spring.data.mongodb.uri` …): its repositories
// `queries` them. A script or manifest that creates one (`datastore` facts)
// `references` it (subkind `declares`). Only the database's name is taken
// from a URL, never its host or credentials.
//
// Names differ per environment and per source (`acme-orders` locally,
// `acme_orders_db` in the provisioning script), so a database's key keeps the
// name's own words: no environment, no `db`, and not a first word that most
// names of one engine from one source share (an organisation's prefix).
import type { DatastoreFact } from './datastore-facts.ts'
import { canonical, moduleConfig, moduleDirs, moduleOf } from './module-config.ts'
import type { AssembleApi, Plugin } from './types.ts'

const URL_KEY = /(^|\.)(datasource(\.[a-z0-9]+)?\.(url|jdbcurl)|mongodb\.uri|r2dbc\.url)$/
const MONGO_DATABASE_KEY = /(^|\.)mongodb\.database$/
const ENVIRONMENTS = /^(local|dev\d*|test\d*|int|qa|stage|staging|prod|production|docker)$/

/** A database from a connection URL: its engine and name (jdbc:mysql://h:3306/name?…, mongodb://…/name). */
export function databaseOf(url: string): { engine: string; name: string } | undefined {
  const jdbc = /^(?:jdbc|r2dbc):(mysql|mariadb|postgresql|postgres|sqlserver|oracle|h2)(?::[a-z]+)*:\/{0,2}[^/;?]*[/;:]?(?:databaseName=)?([\w.-]+)?/i.exec(url)
  if (jdbc) return jdbc[2] ? { engine: engineName(jdbc[1]), name: jdbc[2] } : undefined
  const mongo = /^mongodb(?:\+srv)?:\/\/[^/]*\/([\w.-]+)/i.exec(url)
  return mongo ? { engine: 'mongodb', name: mongo[1] } : undefined
}

const engineName = (e: string) => (/^postgres/i.test(e) ? 'postgres' : e.toLowerCase())
const family = (engine: string) => (engine === 'mongodb' ? 'mongodb' : 'sql')
const words = (name: string) =>
  name
    .toLowerCase()
    .split(/[-_.]+/)
    .filter(w => w && w !== 'db' && w !== 'database' && !ENVIRONMENTS.test(w))

interface Found {
  engine: string
  name: string
  /** Where the name comes from: names from one source share their organisation prefix. */
  source: 'config' | 'declare'
  /** The repositories that use it (config), or the code that creates it (declare). */
  owners: string[]
  site: [number, number]
  /** The module whose configuration names it, or the file declaring it. */
  module?: string
  file?: string
}

/** The database nodes each module's configuration names (in its order: the first is its own), and those each file declares. */
export interface FoundDatabases {
  byModule: Map<string, FoundDatabase[]>
  byFile: Map<string, FoundDatabase[]>
}

/** A database node, and the name a configuration or script gives it. */
export interface FoundDatabase {
  id: string
  engine: string
  name: string
}

const recorded = new WeakMap<AssembleApi, FoundDatabases>()

/** What the datastores plugin found in this assembly (plugins/schemas.ts links the schemas it reads to these nodes). */
export function foundDatabases(api: AssembleApi): FoundDatabases {
  return recorded.get(api) ?? { byModule: new Map(), byFile: new Map() }
}

function record(api: AssembleApi, found: Found[], idOf: (f: Found) => string) {
  const out: FoundDatabases = { byModule: new Map(), byFile: new Map() }
  for (const f of found) {
    const [map, key] = f.module !== undefined ? [out.byModule, f.module] : f.source === 'declare' && f.file !== undefined ? [out.byFile, f.file] : []
    if (!map || key === undefined) continue
    const id = idOf(f)
    const list = map.get(key) ?? []
    if (!list.some(e => e.id === id)) list.push({ id, engine: f.engine, name: f.name })
    map.set(key, list)
  }
  recorded.set(api, out)
}

export const datastores: Plugin = {
  name: 'datastores',
  version: 1,

  assemble(api) {
    const found: Found[] = []
    // repositories by module and store family
    const dirs = moduleDirs(api)
    const repositories = new Map<string, { id: string; family: string }[]>()
    for (const n of api.nodes.values()) {
      if (n.kind !== 'symbol' || n.subkind !== 'repository' || !n.path) continue
      const db = n.tags?.find(t => t === 'db:sql' || t === 'db:mongodb')
      if (!db) continue
      const m = moduleOf(dirs, n.path)
      if (!m) continue
      const list = repositories.get(m) ?? []
      list.push({ id: n.id, family: db.slice(3) })
      repositories.set(m, list)
    }
    for (const [module, repos] of repositories) {
      const config = moduleConfig(api, module)
      const urls = config.keys(k => URL_KEY.test(k)).flatMap(k => config.values(k).map(v => config.resolve(v)).filter((v): v is string => v !== undefined))
      const dbs = urls.map(databaseOf).filter(d => d !== undefined)
      for (const k of config.keys(k => MONGO_DATABASE_KEY.test(canonical(k)))) for (const v of config.values(k)) {
        const name = config.resolve(v)
        if (name) dbs.push({ engine: 'mongodb', name })
      }
      const seen = new Set<string>()
      for (const db of dbs) {
        if (seen.has(`${db.engine}:${db.name}`)) continue
        seen.add(`${db.engine}:${db.name}`)
        const owners = repos.filter(r => r.family === family(db.engine)).map(r => r.id)
        if (owners.length) found.push({ ...db, source: 'config', owners, site: [1, 1], module })
      }
    }
    for (const { file, fact } of api.facts<DatastoreFact>('datastore'))
      if (fact.name && api.nodes.has(fact.owner)) found.push({ engine: fact.engine, name: fact.name, source: fact.type === 'declare' ? 'declare' : 'config', owners: [fact.owner], site: fact.site, file })
    if (!found.length) return

    // an organisation's prefix: a first word most names of one engine from one source share
    // (a provisioning script's acme_*_db, Helm values' acme-cloud-*)
    const groupOf = (f: Found) => `${f.source}:${f.engine}`
    const prefixOf = new Map<string, string | undefined>()
    for (const group of new Set(found.map(groupOf))) {
      const names = [...new Set(found.filter(f => groupOf(f) === group).map(f => f.name))]
      const counts = new Map<string, number>()
      for (const n of names) {
        const w = words(n)[0]
        if (w && words(n).length > 1) counts.set(w, (counts.get(w) ?? 0) + 1)
      }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0]
      prefixOf.set(group, top && top[1] >= 2 && top[1] * 2 >= names.length ? top[0] : undefined)
    }
    const keyOf = (f: Found) => {
      const w = words(f.name)
      const prefix = prefixOf.get(groupOf(f))
      return (w.length > 1 && w[0] === prefix ? w.slice(1) : w).join('-') || f.name.toLowerCase()
    }
    const nodes = new Map<string, { engine: string; names: Set<string>; key: string }>()
    for (const f of found) {
      const key = keyOf(f)
      const id = `x:db:${f.engine}:${key}`
      const n = nodes.get(id) ?? { engine: f.engine, names: new Set<string>(), key }
      n.names.add(f.name)
      nodes.set(id, n)
    }
    record(api, found, f => `x:db:${f.engine}:${keyOf(f)}`)
    for (const [id, n] of [...nodes].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
      api.addNode({ id, kind: 'external', name: n.key, tags: ['database', 'infra', n.engine], signature: `${n.engine}: ${[...n.names].sort().join(', ')}` })
    for (const f of found) {
      const target = `x:db:${f.engine}:${keyOf(f)}`
      for (const owner of f.owners)
        api.addEdge(
          f.source === 'declare'
            ? { source: owner, target, kind: 'references', subkind: 'declares', count: 1, targets: api.targets, confidence: 'inferred' }
            : { source: owner, target, kind: 'queries', count: 1, targets: api.targets, confidence: 'inferred' },
          [f.site[0], f.site[1]],
        )
    }
  },
}
