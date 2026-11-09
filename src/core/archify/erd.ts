// One database's tables as an archify ERD (diagram_type "erd"): the stored
// columns with their key roles, and a relationship per foreign key in crow's
// foot notation. Relation fields the code navigates (virtual columns) are
// left out: an ERD shows what's stored.
import type { ColumnMeta, DatabaseMeta, ForeignKeyMeta, TableMeta } from '../model.ts'
import type { Card } from './common.ts'
import { GRID_MAX, Ids, engineLabel, gridCells, outputName } from './common.ts'

type KeyRole = 'pk' | 'fk' | 'uk'

export interface ErdAttribute {
  name: string
  type?: string
  key?: KeyRole | KeyRole[]
  references?: string
}

export interface ErdEntity {
  id: string
  label: string
  sublabel?: string
  row: number
  col: number
  attributes: ErdAttribute[]
}

export interface ErdRelationship {
  id: string
  from: string
  to: string
  label?: string
  fromCardinality: 'one' | 'many'
  toCardinality: 'one' | 'many'
  fromOptional?: boolean
  toOptional?: boolean
  identifying?: boolean
}

export interface ArchifyErd {
  schema_version: 1
  diagram_type: 'erd'
  meta: { title: string; subtitle?: string; output: string; quality_profile: 'standard' | 'showcase' }
  layout: { mode: 'grid' }
  entities: ErdEntity[]
  relationships: ErdRelationship[]
  cards?: Card[]
}

/** The most tables one ERD grid holds (13 × 13 cells). */
export const MAX_TABLES = (GRID_MAX + 1) ** 2

/** archify asks for its dense profile past about 8 tables or 50 fields. */
const SHOWCASE = { tables: 8, fields: 50 }

export function archifyErd(db: DatabaseMeta, options: { project: string }): ArchifyErd {
  if (!db.tables.length) throw new Error(`${db.name} has no tables`)
  if (db.tables.length > MAX_TABLES) throw new Error(`${db.name} has ${db.tables.length} tables; an archify ERD holds at most ${MAX_TABLES}`)
  const ids = new Ids()
  const byName = new Map(db.tables.map(t => [t.name, t]))
  const { cells } = gridCells(squareRows(connectedOrder(db.tables)))
  const entities = db.tables.map(t => entity(t, ids, byName, cells.get(t.name)!))
  // archify draws a relationship between two tables; one a table has to itself (a tree of categories) is told in a card
  const relationships = db.tables.flatMap(t => t.references.filter(fk => byName.has(fk.table) && fk.table !== t.name).map(fk => relationship(t, fk, ids)))
  const fields = entities.reduce((s, e) => s + e.attributes.length, 0)
  const dense = db.tables.length > SHOWCASE.tables || fields > SHOWCASE.fields
  const told = (keep: (t: TableMeta, fk: ForeignKeyMeta) => boolean) =>
    db.tables.flatMap(t => t.references.filter(fk => keep(t, fk)).map(fk => `${t.name}.${fk.columns.join(', ')} → ${fk.table}`))
  const cards: Card[] = []
  const own = told((t, fk) => fk.table === t.name)
  if (own.length) cards.push({ dot: 'violet', title: 'Foreign keys to their own table', items: own })
  // a foreign key into another database has no table here to point at
  const crossing = told((_, fk) => !byName.has(fk.table))
  if (crossing.length) cards.push({ dot: 'slate', title: 'Foreign keys to tables outside this database', items: crossing })
  return {
    schema_version: 1,
    diagram_type: 'erd',
    meta: {
      title: `${db.name} · ${engineLabel(db.engine)}`,
      subtitle: `${db.tables.length} ${db.tables.length === 1 ? 'table' : 'tables'}, read by archrift from ${db.sources.join(', ')}${db.module ? ` in ${db.module}` : ''}`,
      output: outputName(options.project, db.name, 'erd'),
      quality_profile: dense ? 'standard' : 'showcase',
    },
    layout: { mode: 'grid' },
    entities,
    relationships,
    ...(cards.length ? { cards } : {}),
  }
}

function entity(t: TableMeta, ids: Ids, byName: Map<string, TableMeta>, [row, col]: [number, number]): ErdEntity {
  const stored = t.columns.filter(c => !c.virtual)
  return {
    id: ids.of(t.name),
    label: t.name,
    ...(t.entity && t.entity !== t.name ? { sublabel: t.entity } : {}),
    row,
    col,
    attributes: stored.map(c => attribute(c, t, ids, byName)),
  }
}

function attribute(c: ColumnMeta, t: TableMeta, ids: Ids, byName: Map<string, TableMeta>): ErdAttribute {
  const roles: KeyRole[] = []
  if (c.pk) roles.push('pk')
  const ref = referenceOf(c.name, t, ids, byName)
  if (ref) roles.push('fk')
  if (!c.pk && isUnique(c, t)) roles.push('uk')
  return {
    name: c.name,
    ...(c.type ? { type: c.type } : {}),
    ...(roles.length ? { key: roles.length === 1 ? roles[0] : roles } : {}),
    ...(ref ? { references: ref } : {}),
  }
}

/** `entity.attribute` for a column that's part of a foreign key to a table drawn here. */
function referenceOf(column: string, t: TableMeta, ids: Ids, byName: Map<string, TableMeta>): string | undefined {
  for (const fk of t.references) {
    const i = fk.columns.indexOf(column)
    const target = byName.get(fk.table)
    if (i < 0 || !target || !fk.to[i]) continue
    return `${ids.of(target.name)}.${fk.to[i]}`
  }
  return undefined
}

const isUnique = (c: ColumnMeta, t: TableMeta) => !!c.unique || t.indexes.some(ix => ix.unique && ix.columns.length === 1 && ix.columns[0] === c.name)

/** A foreign key reads child → parent: many children (one when its columns are unique), one parent, optional when they may be null. */
function relationship(t: TableMeta, fk: ForeignKeyMeta, ids: Ids): ErdRelationship {
  const columns = fk.columns.map(name => t.columns.find(c => c.name === name))
  const pk = t.columns.filter(c => c.pk).map(c => c.name)
  const unique =
    (fk.columns.length === 1 && columns[0] !== undefined && isUnique(columns[0], t)) ||
    sameSet(fk.columns, pk) ||
    t.indexes.some(ix => ix.unique && sameSet(ix.columns, fk.columns))
  const from = ids.of(t.name)
  const to = ids.of(fk.table)
  return {
    id: ids.of(`${t.name}__${fk.columns.join('_')}__${fk.table}`),
    from,
    to,
    label: fk.columns.join(', '),
    fromCardinality: unique ? 'one' : 'many',
    toCardinality: 'one',
    fromOptional: true,
    ...(columns.some(c => c?.nullable) ? { toOptional: true } : {}),
    // a key that is part of the child's own primary key identifies it
    identifying: fk.columns.every(c => pk.includes(c)),
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length > 0 && a.length === b.length && a.every(x => b.includes(x))

/** Tables in the order a walk along their foreign keys meets them: the most connected first, each group of connected tables together. */
export function connectedOrder(tables: readonly TableMeta[]): string[] {
  const links = new Map<string, Set<string>>(tables.map(t => [t.name, new Set<string>()]))
  for (const t of tables)
    for (const fk of t.references) {
      if (!links.has(fk.table) || fk.table === t.name) continue
      links.get(t.name)!.add(fk.table)
      links.get(fk.table)!.add(t.name)
    }
  const degree = (n: string) => links.get(n)!.size
  const byDegree = [...links.keys()].sort((a, b) => degree(b) - degree(a) || (a < b ? -1 : 1))
  const seen = new Set<string>()
  const order: string[] = []
  for (const start of byDegree) {
    if (seen.has(start)) continue
    const queue = [start]
    seen.add(start)
    while (queue.length) {
      const n = queue.shift()!
      order.push(n)
      for (const m of [...links.get(n)!].sort((a, b) => degree(b) - degree(a) || (a < b ? -1 : 1)))
        if (!seen.has(m)) {
          seen.add(m)
          queue.push(m)
        }
    }
  }
  return order
}

/** Rows of a near-square grid, filled in order. */
function squareRows(order: readonly string[]): string[][] {
  const cols = Math.min(GRID_MAX + 1, Math.max(1, Math.ceil(Math.sqrt(order.length))))
  const rows: string[][] = []
  for (let i = 0; i < order.length; i += cols) rows.push(order.slice(i, i + cols))
  return rows
}
