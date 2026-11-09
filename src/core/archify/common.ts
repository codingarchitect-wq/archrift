// archify (github.com/tt-a1i/archify, Apache-2.0) renders typed JSON into
// standalone interactive diagrams. The files in this folder write that JSON
// from what archrift computed, for its schema_version 1
// (archify/schemas/{architecture,erd,class}.schema.json). archify lays out
// nothing by itself: every component sits in a grid cell, so the cells come
// from here. archrift never runs archify; `archrift export archify` prints the
// command that renders the file.

/** archify's ids: a letter, then letters, digits, `_` or `-`. */
const ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/** The largest row or column index archify's grids take. */
export const GRID_MAX = 12

export interface Card {
  dot: 'cyan' | 'emerald' | 'violet' | 'amber' | 'rose' | 'orange' | 'slate'
  title: string
  items: string[]
}

/**
 * Makes archify ids from names, unique within one diagram: `src/lib` →
 * `src-lib`, `2fa` → `t-2fa`. The same name always gets the same id.
 */
export class Ids {
  private readonly byName = new Map<string, string>()
  private readonly taken = new Set<string>()

  of(name: string): string {
    const known = this.byName.get(name)
    if (known) return known
    let base = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
    if (!ID.test(base)) base = `t-${base}`
    let id = base
    for (let i = 2; this.taken.has(id); i++) id = `${base}-${i}`
    this.byName.set(name, id)
    this.taken.add(id)
    return id
  }
}

/** A portable output file name for meta.output: letters, digits, `.`, `_` and `-`, ending in .html. */
export function outputName(...parts: string[]): string {
  const stem = parts
    .map(p => p.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, ''))
    .filter(Boolean)
    .join('.')
  return `${stem || 'diagram'}.html`
}

/** How archify names engines in a title. */
export const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
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

export const engineLabel = (engine: string) => ENGINE_LABEL[engine] ?? engine

/**
 * Cells for items in rows: each row's items side by side, a row wider than the
 * grid wrapped onto the next, every row centered on the widest. Returns
 * [row, col] per item (in the order given) and the number of columns.
 */
export function gridCells(rows: readonly (readonly string[])[], max = GRID_MAX + 1): { cells: Map<string, [number, number]>; cols: number } {
  const wrapped = rows.flatMap(r => chunks(r, max)).filter(r => r.length)
  const cols = Math.max(1, ...wrapped.map(r => r.length))
  const cells = new Map<string, [number, number]>()
  wrapped.forEach((r, row) => {
    const start = Math.floor((cols - r.length) / 2)
    r.forEach((item, i) => cells.set(item, [row, start + i]))
  })
  return { cells, cols }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Orders each row by where its neighbors sit in the rows already placed (the
 * barycenter heuristic, one sweep down), so connections cross less. Rows keep
 * their items; only the order within a row changes. Ties keep the given order.
 */
export function orderRows(rows: readonly (readonly string[])[], neighbors: (id: string) => readonly string[]): string[][] {
  const placed = new Map<string, number>()
  return rows.map(row => {
    const ranked = row.map((id, i) => {
      const at = neighbors(id).map(n => placed.get(n)).filter((x): x is number => x !== undefined)
      return { id, key: at.length ? at.reduce((s, x) => s + x, 0) / at.length : Number.POSITIVE_INFINITY, i }
    })
    ranked.sort((a, b) => (a.key === b.key ? a.i - b.i : a.key - b.key))
    const ordered = ranked.map(r => r.id)
    ordered.forEach((id, i) => placed.set(id, i - (ordered.length - 1) / 2))
    return ordered
  })
}
