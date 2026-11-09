// JPA entities and Mongo documents as tables (meta.databases), from their
// schema facts (jvm/entities.ts). JPA names go through the module's physical
// naming strategy: Spring Boot's default, CamelCaseToUnderscores (`orderItem`
// → `order_item`, explicit names too), unless the module's configuration
// picks PhysicalNamingStrategyStandardImpl (names as written). A foreign key
// or virtual column names its target by class; here it gets the target's
// table and key columns.
//
// An entity and a SQL table of the same name in one module are one table:
// its nodes are the entity, then the CREATE TABLE statements; its columns,
// keys and indexes are the SQL's (the physical truth), plus the entity's
// virtual columns, and a column the entity declares takes the entity's line.
import type { ColumnMeta, ForeignKeyMeta, TableMeta } from '../../core/model.ts'
import { canonical, moduleConfig } from './module-config.ts'
import type { EntityFact } from './schema-facts.ts'
import { tableKey } from './schema-sql.ts'
import type { AssembleApi } from './types.ts'

export type Naming = (name: string) => string

/** Hibernate's CamelCaseToUnderscoresNamingStrategy: `_` between a lower-case letter (or digit) and an upper-case one before a lower-case one, then lower case. */
export function snakeCase(name: string): string {
  const s = name.replace(/\./g, '_').split('')
  const lowerOrDigit = (c: string | undefined) => !!c && /[a-z0-9]/.test(c)
  for (let i = 1; i < s.length - 1; i++) {
    if (lowerOrDigit(s[i - 1]) && /[A-Z]/.test(s[i]) && lowerOrDigit(s[i + 1])) {
      s.splice(i, 0, '_')
      i++
    }
  }
  return s.join('').toLowerCase()
}

/** The module's JPA naming: snake_case unless it configures the standard (as written) strategy. */
export function namingOf(api: AssembleApi, module: string): Naming {
  const config = moduleConfig(api, module)
  const keys = config.keys(k => /physical(naming)?strategy$/.test(canonical(k)))
  const standard = keys.some(k => config.values(k).some(v => /PhysicalNamingStrategyStandardImpl/.test(v)))
  return standard ? n => n : snakeCase
}

/** An entity with its names made physical; foreign keys and virtual columns still name their targets by class. */
export interface EntityTable {
  fact: EntityFact
  table: TableMeta
  /** Per foreign key (in table.references' order): the target class. */
  fkEntities: (string | undefined)[]
  /** Per column: the class a virtual column leads to. */
  columnEntities: (string | undefined)[]
}

export function entityTable(fact: EntityFact, naming: Naming): EntityTable {
  const name = fact.source === 'jpa' ? naming : (n: string) => n
  // a virtual column keeps the property's name; the table it leads to (an element collection's) is physical
  const columns: ColumnMeta[] = fact.columns.map(({ entity: _, ...c }) => ({ ...c, name: c.virtual ? c.name : name(c.name), ...(c.target ? { target: name(c.target) } : {}) }))
  const references: ForeignKeyMeta[] = fact.references.map(({ entity: _, ...fk }) => ({ ...fk, columns: fk.columns.map(name), table: fk.table ?? '', to: (fk.to ?? []).map(name) }))
  const physical = name(fact.name)
  const table: TableMeta = {
    name: physical,
    kind: fact.source === 'mongo' ? 'collection' : 'table',
    ...(fact.entity !== physical ? { entity: fact.entity } : {}),
    nodes: [fact.owner],
    columns,
    references,
    indexes: fact.indexes.map(i => ({ ...i, columns: i.columns.map(name) })),
  }
  return { fact, table, fkEntities: fact.references.map(r => r.entity), columnEntities: fact.columns.map(c => c.entity) }
}

/** Foreign keys and virtual columns get their targets' tables (and a key's columns, its target's primary key). */
export function resolveTargets(tables: EntityTable[]) {
  const byOwner = new Map(tables.map(t => [t.fact.owner, t.table]))
  for (const t of tables) {
    t.table.references.forEach((fk, i) => {
      const target = byOwner.get(t.fkEntities[i] ?? '')
      if (!target) return
      fk.table = target.name
      if (!fk.to.length) fk.to = target.columns.filter(c => c.pk).map(c => c.name)
    })
    t.table.columns.forEach((c, i) => {
      const target = byOwner.get(t.columnEntities[i] ?? '')
      if (target) c.target = target.name
    })
    // a key whose target isn't an entity the reader saw leads nowhere
    t.table.references = t.table.references.filter(fk => fk.table)
  }
}

/** Several entities of one table (a collection several document types share): one table, the first one's columns, then the others' new ones. */
export function joinEntities(group: EntityTable[]): TableMeta {
  const [first, ...rest] = group
  const table: TableMeta = { ...first.table, nodes: group.map(g => g.fact.owner), columns: [...first.table.columns], references: [...first.table.references], indexes: [...first.table.indexes] }
  for (const other of rest) {
    for (const c of other.table.columns) if (!table.columns.some(x => x.name === c.name)) table.columns.push(c)
    table.references.push(...other.table.references.filter(fk => !table.references.some(x => sameKey(x, fk))))
    table.indexes.push(...other.table.indexes.filter(i => !table.indexes.some(x => x.columns.join() === i.columns.join() && !!x.unique === !!i.unique)))
  }
  return table
}

/** A SQL table with the entities that map to it. */
export function mergeWithSql(sql: TableMeta, entities: TableMeta): TableMeta {
  const lineOf = new Map(entities.columns.filter(c => c.line !== undefined).map(c => [c.name.toLowerCase(), c.line!]))
  const columns = sql.columns.map(({ line: _, ...c }) => {
    const line = lineOf.get(c.name.toLowerCase())
    return line === undefined ? c : { ...c, line }
  })
  const own = new Set(columns.map(c => c.name.toLowerCase()))
  for (const c of entities.columns) if (c.virtual && !own.has(c.name.toLowerCase())) columns.push(c)
  return { ...sql, entity: entities.entity, nodes: [...entities.nodes, ...sql.nodes], columns }
}

const sameKey = (a: ForeignKeyMeta, b: ForeignKeyMeta) => a.columns.join() === b.columns.join() && tableKey(a.table) === tableKey(b.table)
