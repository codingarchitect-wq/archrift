// ERD view: the toolbar's database picker (all, or one: grouped by module,
// with their tables) and the relation-field switch.
import { useStore } from 'zustand'
import { Picker } from '../diagram-kit/Picker.tsx'
import { ENGINE_NAMES } from './model.ts'
import { erd, pickDatabase, setRelations } from './state.ts'

export function Controls() {
  const state = useStore(erd)
  const current = state.databases.find(d => d.id === state.database)
  const modules = [...new Set(state.databases.map(d => d.module))].sort()
  return (
    <div className="group">
      {state.databases.length > 1 && (
        <Picker label={`Database: ${current ? current.name : 'all'}`} title="Which databases the diagram shows" ariaLabel="Databases" width={320}>
          {close => (
            <>
              <ul>
                <li>
                  <button role="menuitemradio" aria-checked={!current} onClick={() => (pickDatabase(null), close())}>
                    <span className="dg-entry">All databases</span>
                    <span className="dim">{state.databases.reduce((n, d) => n + d.tables, 0)} tables</span>
                  </button>
                </li>
              </ul>
              {modules.map(m => (
                <div key={m}>
                  {modules.length > 1 && <div className="dim dg-group">{m || 'root'}</div>}
                  <ul>
                    {state.databases
                      .filter(d => d.module === m)
                      .map(d => (
                        <li key={d.id}>
                          <button role="menuitemradio" aria-checked={d.id === current?.id} onClick={() => (pickDatabase(d.id), close())}>
                            <span className="dg-entry">{d.name}</span>
                            <span className="dim">
                              {ENGINE_NAMES[d.engine] ?? d.engine} · {d.tables} tables
                            </span>
                          </button>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </Picker>
      )}
      {state.databases.length > 0 && (
        <button aria-pressed={state.relations} onClick={() => setRelations(!state.relations)} title="Show relation fields: what the code navigates (Prisma’s Transaction[], JPA’s @OneToMany) but the table doesn’t store">
          relation fields
        </button>
      )}
    </div>
  )
}
