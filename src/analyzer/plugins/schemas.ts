// Databases and their schemas (meta.databases), from what the readers found
// while extracting (schema facts, cached per file) and the Prisma schema.
// Assembled every run, after the datastores plugin made the database nodes.
//
// - Prisma: one database per datasource (schema-prisma.ts). Its own
//   migrations (`<schema folder>/migrations/**`) repeat the schema and are
//   left out.
// - Dexie: one database per Dexie class (schema-dexie.ts).
// - SQL, JPA and Mongo: per module (the folder of the nearest build file, or
//   a mount) and store family (SQL or Mongo). A module's SQL files are
//   grouped by engine (the folders name it: `db/migration/mysql/`); when the
//   module's configuration names a database, only the group of its engine
//   counts (an H2 copy for tests is left out). Within a group, migrations
//   win over schema scripts: when the group has any migration, its scripts
//   (`db/schema-mysql.sql`, often a generated snapshot) are left out;
//   otherwise the scripts are applied in name order. Entities join the SQL
//   table of the same name (schema-entities.ts).
// - A module's database is the database node its configuration names first
//   (its own; a second one such as `…-restore` is a copy and gets no schema of
//   its own), else the one its SQL files create, else `db:<source>:<module>`.
// - Entities of a module without a database of their family (a library's)
//   join the tables of that name in other modules' databases; those no
//   database has get a database of their own module.
// - Test files' schemas are left out: they describe fixtures, not the system.
import { fileId } from '../../core/ids.ts'
import type { ColumnMeta, DatabaseMeta, IndexMeta, SchemaSource, TableMeta } from '../../core/model.ts'
import { foundDatabases } from './datastores.ts'
import type { FoundDatabase, FoundDatabases } from './datastores.ts'
import { moduleDirs, moduleOf } from './module-config.ts'
import { prismaSchema } from './prisma.ts'
import { dexieDatabases } from './schema-dexie.ts'
import { entityTable, joinEntities, mergeWithSql, namingOf, resolveTargets } from './schema-entities.ts'
import type { EntityTable } from './schema-entities.ts'
import type { DdlFact, SchemaFact } from './schema-facts.ts'
import { prismaDatabases } from './schema-prisma.ts'
import { SqlSchema, isMigration, migrationOrder, natural, tableKey } from './schema-sql.ts'
import type { AssembleApi, Plugin } from './types.ts'

/** Sources in the order their columns are trusted. */
const TRUST: SchemaSource[] = ['sql', 'prisma', 'dexie', 'jpa', 'mongo']

type Family = 'sql' | 'mongodb'
type Located<T> = { file: string; fact: T }
type SqlTable = TableMeta & { file?: string }

interface Ctx {
  api: AssembleApi
  moduleOf: (path: string) => string
  found: FoundDatabases
}

/** One module's tables of one store family, before they become a database. */
interface Part {
  module: string
  family: Family
  /** SQL files by engine. */
  sql: Map<string, Located<DdlFact>[]>
  entities: EntityTable[]
}

export const schemas: Plugin = {
  name: 'schemas',
  version: 1,

  assemble(api) {
    const ctx: Ctx = { api, moduleOf: moduleLocator(api), found: foundDatabases(api) }
    const facts = factsOf(api)
    const prisma = prismaSchema(api)
    const dbs = [
      ...(prisma ? prismaDatabases(prisma.path, prisma.text, prisma.blocks, ctx.moduleOf(prisma.path)) : []),
      ...dexieDatabases(ofType(facts, 'dexie-class'), ofType(facts, 'dexie-stores').map(f => f.fact), ctx.moduleOf),
      ...serviceDatabases(ctx, facts, prisma?.path),
    ]
    // always set: an empty list is "read, none found"; none at all, a graph analyzed before schemas were read
    api.meta.databases = finish(dbs, api)
  },
}

/** A file's module: the deepest folder with a build file, else the mount it is in, else the root (''). */
function moduleLocator(api: AssembleApi): (path: string) => string {
  const dirs = moduleDirs(api)
  const mounts = Object.keys(api.config.mounts ?? {})
  return p => moduleOf(dirs, p) || mounts.find(m => p.startsWith(`${m}/`)) || ''
}

function factsOf(api: AssembleApi): Located<SchemaFact>[] {
  const isTest = (file: string) => api.nodes.get(fileId(file))?.tags?.includes('test') ?? false
  return api
    .facts<SchemaFact>('schema')
    .filter(f => !isTest(f.file))
    .sort((a, b) => natural(a.file, b.file))
}

function ofType<T extends SchemaFact['type']>(facts: Located<SchemaFact>[], type: T): Located<Extract<SchemaFact, { type: T }>>[] {
  return facts.filter((f): f is Located<Extract<SchemaFact, { type: T }>> => f.fact.type === type)
}

// ── SQL, JPA, Mongo ──

function serviceDatabases(ctx: Ctx, facts: Located<SchemaFact>[], prismaPath: string | undefined): DatabaseMeta[] {
  const parts = partsOf(ctx, facts, prismaPath)
  const dbs: DatabaseMeta[] = []
  const homeless: Part[] = []
  for (const p of parts) {
    const made = partDatabases(ctx, p)
    if (made.length) dbs.push(...made)
    else homeless.push(p)
  }
  return [...dbs, ...adopt(ctx, dbs, homeless)]
}

/** The facts by module and store family, in module order. */
function partsOf(ctx: Ctx, facts: Located<SchemaFact>[], prismaPath: string | undefined): Part[] {
  const parts = new Map<string, Part>()
  const part = (module: string, family: Family) => {
    const key = `${module}\u0000${family}`
    if (!parts.has(key)) parts.set(key, { module, family, sql: new Map(), entities: [] })
    return parts.get(key)!
  }
  const prismaOwn = prismaMigrations(prismaPath)
  for (const f of ofType(facts, 'ddl').filter(f => !prismaOwn(f.file))) {
    const sql = part(ctx.moduleOf(f.file), 'sql').sql
    sql.set(f.fact.engine, [...(sql.get(f.fact.engine) ?? []), f])
  }
  const entities = ofType(facts, 'entity').map(({ file, fact }) => ({ module: ctx.moduleOf(file), table: entityTable(fact, namingOf(ctx.api, ctx.moduleOf(file))) }))
  resolveTargets(entities.map(e => e.table))
  for (const e of entities) part(e.module, e.table.fact.source === 'mongo' ? 'mongodb' : 'sql').entities.push(e.table)
  return [...parts.values()].sort(byModule)
}

const byModule = (a: Part, b: Part) => natural(a.module, b.module) || (a.family < b.family ? -1 : 1)

/** Prisma's own migrations (`<schema folder>/migrations/`) repeat its schema. */
function prismaMigrations(schemaPath: string | undefined): (file: string) => boolean {
  if (schemaPath === undefined) return () => false
  const dir = `${schemaPath.slice(0, schemaPath.lastIndexOf('/') + 1)}migrations/`
  return file => file.startsWith(dir)
}

/** A module's databases of one family; none when it has neither SQL nor a database node (its entities are homeless). */
function partDatabases(ctx: Ctx, p: Part): DatabaseMeta[] {
  const node = nodeOf(ctx, p.module, p.family)
  const engines = chooseEngines(p.sql, node?.engine)
  const entityTables = entitiesByTable(p.entities)
  if (!engines.length) return node ? [database(ctx, p, { tables: [...entityTables.values()], node, sources: entitySources(p) })] : []
  // entities join the first engine's tables only (several engines without a node to choose from: rare)
  return engines.map((engine, i) => sqlDatabase(ctx, p, engine, node, i === 0 ? entityTables : undefined, engines.length > 1))
}

function sqlDatabase(ctx: Ctx, p: Part, engine: string, node: FoundDatabase | undefined, entities: Map<string, TableMeta> | undefined, several: boolean): DatabaseMeta {
  const files = p.sql.get(engine)!
  const sqlTables = applySql(files)
  const linked = node ?? declaredNode(ctx, files)
  return database(ctx, p, {
    tables: entities ? withEntities(sqlTables, entities) : sqlTables,
    node: linked,
    engine: engine === 'sql' ? linked?.engine : engine,
    sources: ['sql', ...(entities ? entitySources(p) : [])],
    suffix: several ? `.${engine}` : '',
  })
}

/** The engine groups that make the module's SQL databases: the configured database's engine (or unnamed SQL) when there is one, else each. */
function chooseEngines(sql: Map<string, Located<DdlFact>[]>, configured: string | undefined): string[] {
  const engines = [...sql.keys()].sort()
  if (engines.length <= 1 || !configured) return engines
  if (sql.has(configured)) return [configured]
  if (sql.has('sql')) return ['sql']
  return [engines.reduce((a, b) => (sql.get(b)!.length > sql.get(a)!.length ? b : a))]
}

/** A group's files applied in order: its migrations, or its scripts when it has none. */
function applySql(files: Located<DdlFact>[]): SqlTable[] {
  const byPath = new Map(files.map(f => [f.file, f.fact]))
  const migrations = [...byPath.keys()].filter(isMigration)
  const order = migrations.length ? migrationOrder(migrations) : [...byPath.keys()].sort(natural)
  const schema = new SqlSchema()
  for (const file of order) schema.applyFile(file, byPath.get(file)!.ops)
  return schema.result()
}

/** Entities by their table; of several, the one whose own table it is first (a single-table root before its subclasses). */
function entitiesByTable(entities: EntityTable[]): Map<string, TableMeta> {
  const groups = new Map<string, EntityTable[]>()
  const order = (e: EntityTable) => `${e.fact.sharesTableOf ? 1 : 0}${e.fact.owner}`
  for (const e of [...entities].sort((a, b) => (order(a) < order(b) ? -1 : 1))) {
    const key = tableKey(e.table.name)
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  return new Map([...groups].map(([k, g]) => [k, joinEntities(g)]))
}

function withEntities(sql: SqlTable[], entities: Map<string, TableMeta>): SqlTable[] {
  const keys = new Set(sql.map(t => tableKey(t.name)))
  const merged = sql.map(t => {
    const e = entities.get(tableKey(t.name))
    return e ? { ...mergeWithSql(t, e), file: t.file } : t
  })
  return [...merged, ...[...entities].filter(([k]) => !keys.has(k)).map(([, t]) => t)]
}

const entitySources = (p: Part): SchemaSource[] => (p.entities.length ? [p.family === 'mongodb' ? 'mongo' : 'jpa'] : [])

/** The database node the module's configuration names first for this family. */
function nodeOf(ctx: Ctx, module: string, family: Family) {
  return ctx.found.byModule.get(module)?.find(d => (d.engine === 'mongodb') === (family === 'mongodb'))
}

/** The one database node the files create (`CREATE DATABASE` in a script that also creates its tables). */
function declaredNode(ctx: Ctx, files: Located<DdlFact>[]): FoundDatabase | undefined {
  const declared = files.flatMap(f => ctx.found.byFile.get(f.file) ?? [])
  return new Set(declared.map(d => d.id)).size === 1 ? declared[0] : undefined
}

interface Made {
  tables: SqlTable[]
  node?: FoundDatabase
  engine?: string
  sources: SchemaSource[]
  suffix?: string
}

function database(ctx: Ctx, p: Part, m: Made): DatabaseMeta {
  const fallbackEngine = p.family === 'mongodb' ? 'mongodb' : 'sql'
  const label = (p.module || ctx.api.config.name) + (m.suffix ?? '')
  return {
    id: m.node?.id ?? `db:${m.sources[0]}:${label}`,
    name: m.node?.name ?? label.slice(label.lastIndexOf('/') + 1),
    engine: m.engine ?? m.node?.engine ?? fallbackEngine,
    sources: m.sources,
    module: p.module,
    ...(m.node ? { node: m.node.id } : {}),
    tables: m.tables,
  }
}

/** Homeless entities join the same-named tables of other modules' databases of their family; the rest make their module's database. */
function adopt(ctx: Ctx, dbs: DatabaseMeta[], homeless: Part[]): DatabaseMeta[] {
  const own: DatabaseMeta[] = []
  for (const p of homeless) {
    const left: TableMeta[] = []
    for (const [key, table] of entitiesByTable(p.entities)) {
      const homes = dbs.filter(db => db.module !== p.module && (db.engine === 'mongodb') === (p.family === 'mongodb'))
      let adopted = false
      for (const db of homes)
        db.tables.forEach((t, i) => {
          if (tableKey(t.name) !== key) return
          db.tables[i] = adoptInto(t, table)
          db.sources = [...db.sources, ...entitySources(p)]
          adopted = true
        })
      if (!adopted) left.push(table)
    }
    if (left.length) own.push(database(ctx, p, { tables: left, sources: entitySources(p) }))
  }
  return own
}

/** Another module's entity of this table: its node after the table's own entities, its virtual columns (without its lines, which are in its own file). */
function adoptInto(t: SqlTable, entity: TableMeta): SqlTable {
  const at = t.nodes.findIndex(n => n.includes('.sql#'))
  const nodes = at < 0 ? [...t.nodes, ...entity.nodes] : [...t.nodes.slice(0, at), ...entity.nodes, ...t.nodes.slice(at)]
  const names = new Set(t.columns.map(c => c.name.toLowerCase()))
  const extra = entity.columns.filter(c => (at < 0 || c.virtual) && !names.has(c.name.toLowerCase())).map(({ line: _, ...c }) => c)
  return { ...t, ...(t.entity || !entity.entity ? {} : { entity: entity.entity }), nodes, columns: [...t.columns, ...extra] }
}

// ── the finishing touches every source gets ──

function finish(dbs: DatabaseMeta[], api: AssembleApi): DatabaseMeta[] {
  const ids = new Set<string>()
  const out = dbs.map(db => {
    let id = db.id
    for (let n = 2; ids.has(id); n++) id = `${db.id}#${n}`
    ids.add(id)
    const sources = TRUST.filter(s => db.sources.includes(s))
    const tables = db.tables.map(t => finishTable(t, api)).sort((a, b) => natural(a.name.toLowerCase(), b.name.toLowerCase()))
    return { ...db, id, sources, tables }
  })
  return out.sort((a, b) => natural(a.module, b.module) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Nodes that are in the graph (a CREATE statement's file when its symbol isn't); a single-column
 * unique index marks its column unique and a unique column has its index; a key column is never null.
 */
function finishTable(t: SqlTable, api: AssembleApi): TableMeta {
  const { file, ...table } = t
  const nodes = table.nodes.filter(n => api.nodes.has(n))
  if (!nodes.length && file && api.nodes.has(fileId(file))) nodes.push(fileId(file))
  const indexes = [...table.indexes]
  const columns = table.columns.map(c => finishColumn(c, indexes))
  return { ...table, nodes, columns, indexes }
}

function finishColumn(c: ColumnMeta, indexes: IndexMeta[]): ColumnMeta {
  const indexed = indexes.some(i => isUniqueOn(i, c.name))
  if (c.unique && !indexed && !c.virtual) indexes.push({ columns: [c.name], unique: true })
  const { nullable, unique: _, ...rest } = c
  return { ...rest, ...(indexed || c.unique ? { unique: true } : {}), ...(nullable && !c.pk ? { nullable } : {}) }
}

const isUniqueOn = (i: IndexMeta, column: string) => !!i.unique && i.columns.length === 1 && i.columns[0].toLowerCase() === column.toLowerCase()
