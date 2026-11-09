// ERD view, part 3: its options (which database, relation fields), what the
// legend says about what's shown, and who reads and writes the selected table
// (loaded with the file details of the files declaring it).
import { createStore } from 'zustand/vanilla'
import { fileIdOf } from '../../../core/ids.ts'
import type { DatabaseMeta, TableMeta } from '../../../core/model.ts'
import type { FileDetails } from '../../api.ts'
import { actions, store } from '../../store.ts'
import { usesOf } from './uses.ts'
import type { TableUses } from './uses.ts'

export interface DatabaseChoice {
  id: string
  name: string
  engine: string
  module: string
  tables: number
}

export interface ErdState {
  /** One database's id, or null for all. */
  database: string | null
  relations: boolean
  databases: DatabaseChoice[]
  shown: { boards: number; tables: number; links: number; arcs: number; hubs: string[] } | null
  /** The selected table's readers and writers (null while none is selected). */
  uses: { table: string; uses: TableUses | null } | null
}

export const erd = createStore<ErdState>()(() => ({ database: null, relations: false, databases: [], shown: null, uses: null }))

/** Run the viewer again (the plug-in hands over its ctx.refresh). */
let refresh = () => {}
export const setRefresh = (f: () => void) => (refresh = f)

export function pickDatabase(id: string | null) {
  erd.setState({ database: id })
  refresh()
}

export function setRelations(on: boolean) {
  erd.setState({ relations: on })
  refresh()
}

/** Publish the databases there are (only when they changed, so the picker doesn't re-render for nothing). */
export function publishDatabases(databases: readonly DatabaseMeta[]) {
  const list = databases.map(d => ({ id: d.id, name: d.name, engine: d.engine, module: d.module, tables: d.tables.length }))
  if (JSON.stringify(list) !== JSON.stringify(erd.getState().databases)) erd.setState({ databases: list })
}

export function publishShown(shown: ErdState['shown']) {
  if (JSON.stringify(shown) !== JSON.stringify(erd.getState().shown)) erd.setState({ shown })
}

/** The table whose readers and writers are wanted: they load once its files' details are there. */
let asked: TableMeta | null = null

export function showUses(table: TableMeta | null) {
  if (table === asked) return
  asked = table
  if (!table) return erd.setState({ uses: null })
  erd.setState({ uses: { table: table.name, uses: null } })
  const files = [...new Set(table.nodes.map(n => fileIdOf(n) ?? n))]
  void Promise.all(files.map(f => actions.ensureDetails(f))).then(found => {
    if (asked !== table) return // another table was selected meanwhile
    const details = found.filter((d): d is FileDetails => !!d)
    erd.setState({ uses: { table: table.name, uses: usesOf(details, new Set(table.nodes)) } })
  })
}

/** A row's own node when the viewer knows it (its file's details are loaded), else the table's. */
export function knownOr(id: string, fallback: string): string {
  const file = fileIdOf(id)
  const d = file ? store.getState().details[file] : undefined
  return d?.symbols.some(s => s.id === id) ? id : fallback
}
