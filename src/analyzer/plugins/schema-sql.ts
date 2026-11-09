// SQL schemas from migrations and scripts (infra/ddl.ts reads the
// statements): files ordered as a migration tool runs them, their schema
// changes applied one after another, and the tables that are left.
//
// Order: Flyway's versioned files (`V<version>__<description>.sql`, version
// parts such as `01_001` or `1.2` compared as numbers) first, then its
// repeatable ones (`R__…`, by description), then any other file by its path,
// numbers compared as numbers (timestamped or numbered migrations, Prisma's
// `0001_init/migration.sql`). Flyway's undo files (`U…`) are left out.
import { symbolId } from '../../core/ids.ts'
import type { ColumnMeta, ForeignKeyMeta, IndexMeta, TableMeta } from '../../core/model.ts'
import type { DdlColumn, DdlOp } from './schema-facts.ts'

const FLYWAY = /^([VRU])(\d+(?:[._]\d+)*)?__/i

/** A migration, not a schema script: in a migration(s) folder, or named the way Flyway names them. */
export function isMigration(path: string): boolean {
  return /(^|\/)(db\/)?migrations?\//i.test(path) || FLYWAY.test(baseName(path))
}

/** Paths in the order their migrations run. */
export function migrationOrder(paths: readonly string[]): string[] {
  return paths.filter(p => !/^U/i.test(flywayOf(p)?.kind ?? '')).sort(compareMigrations)
}

function compareMigrations(a: string, b: string): number {
  const fa = flywayOf(a)
  const fb = flywayOf(b)
  const byRank = rank(fa) - rank(fb)
  if (byRank) return byRank
  if (fa?.kind === 'V' && fb?.kind === 'V') return compareVersions(fa.version, fb.version) || natural(a, b)
  // repeatable ones by description, other files by path
  return natural(fa ? baseName(a) : a, fb ? baseName(b) : b) || natural(a, b)
}

/** Versioned, then repeatable, then any other file. */
const rank = (f: ReturnType<typeof flywayOf>) => (!f ? 2 : f.kind === 'V' ? 0 : 1)

function flywayOf(path: string): { kind: string; version: number[] } | undefined {
  const m = FLYWAY.exec(baseName(path))
  if (!m || (m[1].toUpperCase() !== 'R' && !m[2])) return undefined
  return { kind: m[1].toUpperCase(), version: (m[2] ?? '').split(/[._]/).filter(Boolean).map(Number) }
}

/** 1.2 = 1.2.0 < 1.10 */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Text order with runs of digits compared as numbers: `9_x` < `10_x`. */
export function natural(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? []
  const pb = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const d = comparePart(pa[i], pb[i])
    if (d) return d
  }
  return pa.length - pb.length || plain(a, b)
}

const comparePart = (x: string, y: string) => (/^\d/.test(x) && /^\d/.test(y) ? Number(x) - Number(y) : plain(x, y))
const plain = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

// ── applying the changes ──

interface Table {
  name: string
  kind: 'table' | 'view'
  columns: ColumnMeta[]
  pkName?: string
  references: ForeignKeyMeta[]
  indexes: IndexMeta[]
  /** The CREATE statements' symbols. */
  nodes: string[]
  /** The file of the CREATE statement: column lines are kept only in it. */
  file: string
}

/** The default schema of a qualified name says nothing: `public.users` is `users`. */
const DEFAULT_SCHEMA = /^(public|dbo)\./i
export const tableKey = (name: string) => name.replace(DEFAULT_SCHEMA, '').toLowerCase()
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** A database's tables as its migrations or scripts leave them. Facts are cached and shared between runs: nothing of them is changed in place. */
export class SqlSchema {
  private readonly tables = new Map<string, Table>()

  /** Applies a file's schema changes, in order. */
  applyFile(file: string, ops: readonly DdlOp[]) {
    for (const op of ops) APPLY[op.op](this, op as never, file)
  }

  get(name: string): Table | undefined {
    return this.tables.get(tableKey(name))
  }

  /** The tables, by name; a foreign key that names no columns references the primary key. */
  result(): (TableMeta & { file: string })[] {
    const out = [...this.tables.values()].sort((a, b) => (tableKey(a.name) < tableKey(b.name) ? -1 : 1))
    return out.map(t => ({
      name: t.name.replace(DEFAULT_SCHEMA, ''),
      kind: t.kind,
      nodes: t.nodes,
      columns: t.columns,
      references: t.references.map(fk => (fk.to.length ? fk : { ...fk, to: this.primaryKey(fk.table) })),
      indexes: t.indexes,
      file: t.file,
    }))
  }

  private primaryKey(table: string): string[] {
    return this.get(table)?.columns.filter(c => c.pk).map(c => c.name) ?? []
  }

  create(op: Extract<DdlOp, { op: 'create' }>, file: string) {
    const key = tableKey(op.table)
    if (op.ifNotExists && this.tables.has(key)) return
    const table: Table = { name: op.table, kind: op.kind, columns: [], references: op.references.map(copyFk), indexes: op.indexes.map(copyIndex), nodes: [symbolId(file, op.table)], file }
    if (op.pkName) table.pkName = op.pkName
    for (const c of op.columns) addColumn(table, c, file)
    setPrimaryKey(table, op.pk)
    this.tables.set(key, table)
  }

  drop(table: string) {
    this.tables.delete(tableKey(table))
  }

  rename(from: string, to: string) {
    const table = this.get(from)
    if (!table) return
    this.tables.delete(tableKey(from))
    table.name = to
    this.tables.set(tableKey(to), table)
    for (const t of this.tables.values()) for (const fk of t.references) if (tableKey(fk.table) === tableKey(from)) fk.table = to
  }

  addColumn(op: Extract<DdlOp, { op: 'add-column' }>, file: string) {
    const t = this.get(op.table)
    if (!t || (op.ifNotExists && t.columns.some(c => same(c.name, op.column.name)))) return
    const after = op.after ? t.columns.findIndex(c => same(c.name, op.after!)) + 1 : undefined
    addColumn(t, op.column, file, op.first ? 0 : after)
    if (op.column.pk) setPrimaryKey(t, t.columns.filter(c => c.pk).map(c => c.name))
  }

  dropColumn(op: Extract<DdlOp, { op: 'drop-column' }>) {
    const t = this.get(op.table)
    if (!t) return
    t.columns = t.columns.filter(c => !same(c.name, op.column))
    t.indexes = t.indexes.map(i => ({ ...i, columns: i.columns.filter(c => !same(c, op.column)) })).filter(i => i.columns.length)
    t.references = t.references.filter(fk => !fk.columns.some(c => same(c, op.column)))
  }

  /** MySQL MODIFY / CHANGE: the definition is replaced where the column stands; it stays in the primary key and keeps its line. */
  replaceColumn(op: Extract<DdlOp, { op: 'replace-column' }>, file: string) {
    const t = this.get(op.table)
    const at = t ? t.columns.findIndex(x => same(x.name, op.from)) : -1
    if (!t || at < 0) return
    const { pk, line } = t.columns[at]
    if (!same(op.from, op.column.name)) this.renameColumn(t, op.from, op.column.name)
    t.columns.splice(at, 1)
    addColumn(t, op.column, file, at)
    if (line !== undefined && t.columns[at].line === undefined) t.columns[at].line = line
    if (pk) setPrimaryKey(t, t.columns.filter(x => x.pk || x === t.columns[at]).map(x => x.name))
  }

  alterColumn(op: Extract<DdlOp, { op: 'alter-column' }>) {
    const col = this.get(op.table)?.columns.find(c => same(c.name, op.column))
    if (!col) return
    if (op.type) col.type = op.type
    if (op.nullable !== undefined) setFlag(col, 'nullable', op.nullable && !col.pk)
    if (op.generated !== undefined) setFlag(col, 'generated', op.generated)
  }

  /** A column renamed: in its table's keys and indexes, and in the keys referencing it. */
  renameColumn(table: Table | undefined, from: string, to: string) {
    if (!table) return
    const col = table.columns.find(c => same(c.name, from))
    if (col) col.name = to
    const swap = (cols: string[]) => cols.map(c => (same(c, from) ? to : c))
    for (const i of table.indexes) i.columns = swap(i.columns)
    for (const fk of table.references) fk.columns = swap(fk.columns)
    for (const t of this.tables.values()) for (const fk of t.references) if (tableKey(fk.table) === tableKey(table.name)) fk.to = swap(fk.to)
  }

  setPrimaryKey(table: string, columns: string[], name?: string) {
    const t = this.get(table)
    if (!t) return
    setPrimaryKey(t, columns)
    if (name) t.pkName = name
  }

  /** What a dropped index, key or constraint was: found by name in the table (or any table, for PostgreSQL's DROP INDEX). */
  dropNamed(op: Extract<DdlOp, { op: 'drop-named' }>) {
    const tables = op.table ? [this.get(op.table)].filter(t => t !== undefined) : [...this.tables.values()]
    for (const t of tables) {
      if (op.what !== 'fk') t.indexes = withoutIndex(t.indexes, op.name)
      if (op.what !== 'index') t.references = t.references.filter(fk => !fk.name || !same(fk.name, op.name))
      if (op.what === 'constraint' && t.pkName && same(t.pkName, op.name)) setPrimaryKey(t, [])
    }
  }

  renameIndex(op: Extract<DdlOp, { op: 'rename-index' }>) {
    const i = this.get(op.table)?.indexes.find(x => x.name && same(x.name, op.from))
    if (i) i.name = op.to
  }
}

type Apply<K extends DdlOp['op']> = (s: SqlSchema, op: Extract<DdlOp, { op: K }>, file: string) => void

const APPLY: { [K in DdlOp['op']]: Apply<K> } = {
  create: (s, op, file) => s.create(op, file),
  drop: (s, op) => s.drop(op.table),
  rename: (s, op) => s.rename(op.table, op.to),
  'add-column': (s, op, file) => s.addColumn(op, file),
  'drop-column': (s, op) => s.dropColumn(op),
  'replace-column': (s, op, file) => s.replaceColumn(op, file),
  'alter-column': (s, op) => s.alterColumn(op),
  'rename-column': (s, op) => s.renameColumn(s.get(op.table), op.from, op.to),
  'add-pk': (s, op) => s.setPrimaryKey(op.table, op.columns, op.name),
  'drop-pk': (s, op) => s.setPrimaryKey(op.table, []),
  'add-fk': (s, op) => void s.get(op.table)?.references.push(copyFk(op.fk)),
  'add-index': (s, op) => void s.get(op.table)?.indexes.push(copyIndex(op.index)),
  'drop-named': (s, op) => s.dropNamed(op),
  'rename-index': (s, op) => s.renameIndex(op),
}

const copyFk = (fk: ForeignKeyMeta): ForeignKeyMeta => ({ ...fk, columns: [...fk.columns], to: [...fk.to] })
const copyIndex = (i: IndexMeta): IndexMeta => ({ ...i, columns: [...i.columns] })

function setFlag(col: ColumnMeta, flag: 'nullable' | 'generated', on: boolean) {
  if (on) col[flag] = true
  else delete col[flag]
}

/** A column joins the table; its inline REFERENCES becomes a foreign key, its line is kept in the CREATE's file. */
function addColumn(t: Table, c: DdlColumn, file: string, at = t.columns.length) {
  const { references, line, ...column } = c
  const meta: ColumnMeta = { ...column, ...(line !== undefined && file === t.file ? { line } : {}) }
  t.columns.splice(at < 0 ? t.columns.length : at, 0, meta)
  if (references) t.references.push(copyFk(references))
}

function setPrimaryKey(t: Table, columns: string[]) {
  for (const c of t.columns) {
    if (columns.some(k => same(k, c.name))) {
      c.pk = true
      delete c.nullable
    } else delete c.pk
  }
}

/** Without the index of that name; MySQL names an unnamed index after its first column. */
function withoutIndex(indexes: IndexMeta[], name: string): IndexMeta[] {
  const named = indexes.filter(i => !i.name || !same(i.name, name))
  if (named.length < indexes.length) return named
  const implicit = indexes.findIndex(i => !i.name && same(i.columns[0], name))
  return implicit < 0 ? indexes : indexes.filter((_, k) => k !== implicit)
}
