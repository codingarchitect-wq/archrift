// ERD view, part 2: who reads and who writes a table. The `queries` edges
// into any of the table's nodes (the Prisma model, the Dexie table, the
// entity class), read from the file details of the files declaring them,
// grouped by the file they come from. Pure.
import { fileIdOf } from '../../../core/ids.ts'
import type { FileDetails } from '../../api.ts'

export interface FileUse {
  /** The file (or outside node) the queries come from. */
  file: string
  name: string
  folder: string
  /** How many references. */
  count: number
}

export interface TableUses {
  reads: FileUse[]
  writes: FileUse[]
  /** Queries that don't say whether they read or write. */
  other: FileUse[]
}

/** The files querying any of `nodes`, by what they do, most references first. */
export function usesOf(details: readonly FileDetails[], nodes: ReadonlySet<string>): TableUses {
  const by: Record<keyof TableUses, Map<string, FileUse>> = { reads: new Map(), writes: new Map(), other: new Map() }
  const seen = new Set<string>()
  for (const d of details)
    for (const e of d.edges) {
      if (e.kind !== 'queries' || !nodes.has(e.target)) continue
      // the same edge comes with the details of each file it touches
      const key = `${e.source}\u0000${e.target}\u0000${e.subkind ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const file = fileIdOf(e.source) ?? e.source
      const list = by[e.subkind === 'read' ? 'reads' : e.subkind === 'write' ? 'writes' : 'other']
      const use = list.get(file) ?? { file, ...nameOf(file), count: 0 }
      use.count += e.count
      list.set(file, use)
    }
  const sorted = (m: Map<string, FileUse>) => [...m.values()].sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return { reads: sorted(by.reads), writes: sorted(by.writes), other: sorted(by.other) }
}

function nameOf(file: string): { name: string; folder: string } {
  const path = file.replace(/^[a-z]:/, '')
  const slash = path.lastIndexOf('/')
  return { name: path.slice(slash + 1), folder: slash < 0 ? '' : path.slice(0, slash) }
}
