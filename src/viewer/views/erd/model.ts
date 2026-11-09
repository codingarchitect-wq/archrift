// ERD view, part 1: the model. Each database the code declares a schema for
// (graph.meta.databases) becomes a board of table cards: one row per column
// with a key for the primary key, FK and UQ tags, the type at the right (a
// nullable one muted), relation fields only when asked for. Foreign keys are
// connectors from the referencing row to the referenced one, crow's-foot
// marks at both ends: many unless the key's columns are unique (one to one),
// optional when they may be null. A table nearly every other one references
// (the users table) would draw a fan over the whole board: its connectors are
// arcs shown while one of their ends is selected. Tables are laid out in
// layers, parents left of the tables referencing them, so connected ones sit
// together; boards go in a grid by module (service). Pure and deterministic.
import type { ColumnMeta, DatabaseMeta, ForeignKeyMeta, TableMeta } from '../../../core/model.ts'
import { arrange, shelves } from '../diagram-kit/arrange.ts'
import { rowMiddle, shapeCard } from '../diagram-kit/card.ts'
import type { CardContent, CardRow, CardShape } from '../diagram-kit/card.ts'
import { BOARD_HEAD } from '../diagram-kit/scene.ts'
import type { DiagramScene, EndMark, PlacedCard, SceneArc, SceneBoard, SceneLink } from '../diagram-kit/scene.ts'
import { DIAGRAM_INFO } from '../diagram-kit/sections.ts'

export interface ErdOptions {
  /** One database's id, or null for all. */
  database: string | null
  /** Show relation fields (Prisma's `Transaction[]`, JPA's @OneToMany): columns that aren't stored. */
  relations: boolean
  /** The boards' wanted shape: the window's width over height. */
  aspect: number
}

export interface ErdScene extends DiagramScene {
  /** Per card: its database and table. */
  tables: { db: DatabaseMeta; table: TableMeta }[]
  /** A table's node (any of them) → its card. */
  cardOf: Map<string, number>
  /** Databases left out by the database option. */
  hidden: number
}

const LIMITS = { rows: 12, minW: 13, maxW: 30 }
const LAYERS = { gap: 7, spacing: 3, track: 0.9, align: 'center' as const }
/** Room round a board's cards. */
const PAD = 4
/** A table is a hub when at least this many others reference it, and this share of its database. */
const HUB_MIN = 5
const HUB_SHARE = 0.3

export const ENGINE_NAMES: Record<string, string> = {
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  oracle: 'Oracle',
  h2: 'H2',
  mongodb: 'MongoDB',
  indexeddb: 'IndexedDB',
  sql: 'SQL',
}

export const SOURCE_NAMES: Record<string, string> = { prisma: 'Prisma', dexie: 'Dexie', sql: 'SQL', jpa: 'JPA', mongo: 'Mongo' }

/** The databases shown, by module (the root's first), then by name. */
export function databasesShown(databases: readonly DatabaseMeta[], only: string | null): DatabaseMeta[] {
  const list = databases.filter(d => !only || d.id === only)
  return list.sort((a, b) => cmp(a.module, b.module) || cmp(a.name, b.name) || cmp(a.id, b.id))
}

/** What a database's board says over its cards: "db · PostgreSQL · Prisma" (short: the labels' room is guessed from their length). */
export function headingOf(db: DatabaseMeta): string {
  const sources = db.sources.map(s => SOURCE_NAMES[s] ?? s).join(', ')
  return [db.name, ENGINE_NAMES[db.engine] ?? db.engine, sources].filter(Boolean).join(' · ')
}

/** The small line over the heading: the diagram, the module, how many tables. */
export function captionOf(db: DatabaseMeta): string {
  return [DIAGRAM_INFO.erd.title, db.module, `${db.tables.length} ${db.tables.length === 1 ? 'table' : 'tables'}`].filter(Boolean).join(' · ')
}

export function erdScene(databases: readonly DatabaseMeta[], o: ErdOptions): ErdScene {
  const shown = databasesShown(databases, o.database)
  const out: ErdScene = { boards: [], cards: [], links: [], arcs: [], tables: [], cardOf: new Map(), hidden: databases.length - shown.length }
  const built = shown.map((db, i) => databaseBoard(db, i, o))
  const placed = shelves(
    built.map(b => ({ w: b.w, h: b.h })),
    12,
    o.aspect,
  )
  built.forEach((b, i) => place(out, b, placed.at[i], shown[i]))
  return out
}

/** One database's board, laid out at the origin. */
interface BoardDraft {
  w: number
  h: number
  cards: PlacedCard[]
  links: SceneLink[]
  arcs: SceneArc[]
  tables: TableMeta[]
}

function databaseBoard(db: DatabaseMeta, index: number, o: ErdOptions): BoardDraft {
  const tables = orderTables(db.tables)
  const at = new Map(tables.map((t, i) => [t.name, i]))
  const contents = tables.map(t => tableCard(t, o.relations))
  const shapes = contents.map(c => shapeCard(c, LIMITS))
  const fks = foreignKeys(tables, at)
  const hubs = hubsOf(fks, tables.length)
  const drawn = fks.filter(f => !hubs.has(f.to) || f.from === f.to)
  const layout = arrange({
    cards: shapes.map(s => ({ w: s.w, h: s.h })),
    edges: drawn.map(f => ({ from: f.from, to: f.to, fromAt: attach(shapes[f.from], contents[f.from], f.fk.columns[0]), toAt: attach(shapes[f.to], contents[f.to], f.fk.to[0]) })),
    before: drawn.filter(f => f.from !== f.to).map(f => [f.to, f.from] as [number, number]),
    axis: 'u',
    layers: LAYERS,
    aspect: o.aspect,
    gap: 9,
  })
  const cards = tables.map((_, i): PlacedCard => {
    const full = shapes[i].sections.some(s => s.rows.some(r => r.more !== undefined)) ? shapeCard(contents[i], LIMITS, true) : undefined
    return { content: contents[i], shape: shapes[i], ...(full ? { full } : {}), u: PAD + layout.cards[i].u, v: BOARD_HEAD + layout.cards[i].v, band: `cat:${index}`, board: 0 }
  })
  const links = drawn.map((f, k): SceneLink => ({ from: f.from, to: f.to, points: layout.edges[k].map(([u, v]) => [u + PAD, v + BOARD_HEAD]), start: childEnd(f), end: parentEnd(f) }))
  const arcs = fks
    .filter(f => hubs.has(f.to) && f.from !== f.to)
    .map((f): SceneArc => ({ from: f.from, to: f.to, fromAt: attach(shapes[f.from], contents[f.from], f.fk.columns[0]), toAt: attach(shapes[f.to], contents[f.to], f.fk.to[0]), start: childEnd(f), end: parentEnd(f) }))
  return { w: Math.max(layout.w, 40) + 2 * PAD, h: layout.h + BOARD_HEAD + PAD, cards, links, arcs, tables }
}

function place(out: ErdScene, b: BoardDraft, at: { u: number; v: number }, db: DatabaseMeta) {
  const first = out.cards.length
  const board = out.boards.length
  out.boards.push({ u: at.u, v: at.v, w: b.w, h: b.h, caption: captionOf(db), heading: headingOf(db) } satisfies SceneBoard)
  b.cards.forEach((c, i) => {
    out.cards.push({ ...c, u: c.u + at.u, v: c.v + at.v, board })
    out.tables.push({ db, table: b.tables[i] })
    for (const n of b.tables[i].nodes) if (!out.cardOf.has(n)) out.cardOf.set(n, first + i)
  })
  for (const l of b.links) out.links.push({ ...l, from: l.from + first, to: l.to + first, points: l.points.map(([u, v]) => [u + at.u, v + at.v]) })
  for (const a of b.arcs) out.arcs.push({ ...a, from: a.from + first, to: a.to + first })
}

// ── tables ──────────────────────────────────────────────────────────────────

/** The most referenced first (they anchor the layers), then by name. */
function orderTables(tables: readonly TableMeta[]): TableMeta[] {
  const refs = new Map<string, number>()
  for (const t of tables) for (const fk of t.references) if (fk.table !== t.name) refs.set(fk.table, (refs.get(fk.table) ?? 0) + 1)
  return [...tables].sort((a, b) => (refs.get(b.name) ?? 0) - (refs.get(a.name) ?? 0) || cmp(a.name, b.name))
}

/** A table's card: its name (the entity's small when it differs), a row per column. */
export function tableCard(t: TableMeta, relations: boolean): CardContent {
  const fkColumns = new Set(t.references.flatMap(r => r.columns))
  const unique = new Set(t.indexes.filter(i => i.unique && i.columns.length === 1).map(i => i.columns[0]))
  const rows = t.columns.filter(c => relations || !c.virtual).map(c => columnRow(t, c, fkColumns, unique))
  const aside = [t.entity && t.entity !== t.name ? t.entity : '', t.kind === 'table' ? '' : t.kind].filter(Boolean).join(' · ')
  return { id: t.nodes[0] ?? '', title: t.name, ...(aside ? { aside } : {}), sections: [rows], align: 'left', detail: 'right' }
}

function columnRow(t: TableMeta, c: ColumnMeta, fk: Set<string>, unique: Set<string>): CardRow {
  const type = c.virtual ? `→ ${c.target ?? c.type ?? ''}` : (c.type ?? '').replace(/\?$/, '')
  const tag = fk.has(c.name) ? 'FK' : (c.unique || unique.has(c.name)) && !c.pk ? 'UQ' : undefined
  return {
    // a column with a node of its own (a Prisma field) selects it; the view checks it exists
    ...(t.nodes[0] ? { id: `${t.nodes[0]}.${c.name}` } : {}),
    ...(c.pk ? { key: true } : {}),
    ...(tag ? { tag } : {}),
    name: c.name,
    ...(type ? { detail: c.nullable && !c.virtual ? `${type}?` : type } : {}),
    ...(c.nullable || c.virtual ? { quiet: true } : {}),
  }
}

/** Where a connector meets a card: the column's row, or the title band when that row isn't shown. */
function attach(shape: CardShape, content: CardContent, column: string | undefined): number {
  const row = content.sections[0].findIndex(r => r.name === column)
  return (row >= 0 ? rowMiddle(shape, 0, row) : undefined) ?? shape.band / 2
}

// ── foreign keys ────────────────────────────────────────────────────────────

interface Fk {
  from: number
  to: number
  fk: ForeignKeyMeta
  /** Its columns are unique (or the primary key): one to one. */
  one: boolean
  /** One of its columns may be null. */
  optional: boolean
}

function foreignKeys(tables: readonly TableMeta[], at: Map<string, number>): Fk[] {
  const out: Fk[] = []
  tables.forEach((t, from) => {
    for (const fk of t.references) {
      const to = at.get(fk.table)
      if (to === undefined) continue
      const columns = fk.columns.map(name => t.columns.find(c => c.name === name))
      out.push({ from, to, fk, one: isUnique(t, fk.columns), optional: columns.some(c => c?.nullable) })
    }
  })
  return out
}

/** Columns that are unique together: one unique column, a unique index on exactly them, or the primary key. */
function isUnique(t: TableMeta, columns: readonly string[]): boolean {
  const same = (list: readonly string[]) => list.length === columns.length && list.every(c => columns.includes(c))
  if (columns.length === 1 && t.columns.find(c => c.name === columns[0])?.unique) return true
  if (t.indexes.some(i => i.unique && same(i.columns))) return true
  const pk = t.columns.filter(c => c.pk).map(c => c.name)
  return pk.length > 0 && same(pk)
}

/** Tables referenced by so many others that their connectors would cover the board. */
function hubsOf(fks: readonly Fk[], tables: number): Set<number> {
  const by = new Map<number, Set<number>>()
  for (const f of fks) if (f.from !== f.to) (by.get(f.to) ?? by.set(f.to, new Set()).get(f.to)!).add(f.from)
  const min = Math.max(HUB_MIN, Math.ceil(tables * HUB_SHARE))
  return new Set([...by].filter(([, from]) => from.size >= min).map(([to]) => to))
}

/** The referencing end: zero or many, or zero or one when its columns are unique. */
const childEnd = (f: Fk): EndMark => (f.one ? 'bar-ring' : 'crow-ring')
/** The referenced end: exactly one, or zero or one when the key may be null. */
const parentEnd = (f: Fk): EndMark => (f.optional ? 'bar-ring' : 'bar')

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
