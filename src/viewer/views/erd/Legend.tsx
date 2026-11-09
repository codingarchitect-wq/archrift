// ERD view: its key, what's shown, and the selected table's readers and
// writers (each file a button that selects it).
import { useStore } from 'zustand'
import { actions, store } from '../../store.ts'
import { DiagramLegend, Mark } from '../diagram-kit/Legend.tsx'
import { erd } from './state.ts'
import type { FileUse, TableUses } from './uses.ts'

const FIRST = 8

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

export function Legend() {
  const shown = useStore(erd, s => s.shown)
  const uses = useStore(erd, s => s.uses)
  const none = useStore(erd, s => !s.databases.length)
  return (
    <DiagramLegend
      kind="erd"
      note={
        none ? (
          <span className="dim">No database schema in this graph.</span>
        ) : (
          shown && (
            <span className="dim">
              {count(shown.boards, 'database')}, {count(shown.tables, 'table')}, {count(shown.links + shown.arcs, 'foreign key')}
              {shown.arcs ? ` (${shown.arcs} to ${shown.hubs.join(', ')}: arcs, shown for the selected table)` : ''}
              {uses ? '' : ' · select a table to see who reads and writes it'}
            </span>
          )
        )
      }
      extra={uses && <Uses table={uses.table} uses={uses.uses} />}
    >
      <Mark shape="key">primary key</Mark>
      <span>
        <b className="dg-tag">FK</b> foreign key, <b className="dg-tag">UQ</b> unique
      </span>
      <Mark shape="bar">exactly one</Mark>
      <Mark shape="bar-ring">zero or one (nullable)</Mark>
      <Mark shape="crow">zero or many</Mark>
    </DiagramLegend>
  )
}

function Uses({ table, uses }: { table: string; uses: TableUses | null }) {
  // test files count only while the toolbar shows tests
  const tests = useStore(store, s => s.options.tests)
  const world = useStore(store, s => s.world)
  if (!uses) return <div className="dim">{table}: finding who reads and writes it…</div>
  const shown = (list: FileUse[]) => (tests ? list : list.filter(u => !world?.node(u.file)?.tags?.includes('test')))
  const rows: [string, FileUse[]][] = [
    ['reads', shown(uses.reads)],
    ['writes', shown(uses.writes)],
    ['queries', shown(uses.other)],
  ]
  if (!rows.some(([, list]) => list.length)) return <div className="dim">{table}: no code queries it.</div>
  return (
    <div className="dg-files" aria-label={`Who reads and writes ${table}`}>
      {rows
        .filter(([, list]) => list.length)
        .map(([what, list]) => (
          <FileList key={what} what={what} list={list} />
        ))}
    </div>
  )
}

function FileList({ what, list }: { what: string; list: FileUse[] }) {
  return (
    <>
      <b>
        {what} ({list.length})
      </b>
      <ul>
        {list.slice(0, FIRST).map(u => (
          <li key={u.file}>
            <button title={`${u.folder}/${u.name}: ${u.count} ${u.count === 1 ? 'reference' : 'references'}`} onClick={() => void actions.select(u.file, { travel: false })}>
              {u.name}
            </button>
          </li>
        ))}
        {list.length > FIRST && <li className="dim">+{list.length - FIRST} more</li>}
      </ul>
    </>
  )
}
