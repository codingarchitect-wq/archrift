// Classes view: the toolbar's mode (a family, or a folder) and its picker:
// the families biggest first (classes first), or the folders with types,
// most first, with a filter.
import { useState } from 'react'
import { useStore } from 'zustand'
import { store } from '../../store.ts'
import { Picker } from '../diagram-kit/Picker.tsx'
import { classes, currentFamily, currentFolder, pickFamily, pickFolder, setMode } from './state.ts'

const SHOWN = 200

export function Controls() {
  const state = useStore(classes)
  const selected = useStore(store, s => s.selected)
  if (!state.choices) return null
  return (
    <div className="group">
      <div className="dg-modes" role="group" aria-label="Class diagram of">
        <button aria-pressed={state.mode === 'family'} onClick={() => setMode('family')} title="A family of types joined by extends and implements">
          family
        </button>
        <button aria-pressed={state.mode === 'folder'} onClick={() => setMode('folder')} title="The types declared in one folder, with the associations between them">
          folder
        </button>
      </div>
      {state.mode === 'family' ? <Families /> : <Folders current={currentFolder(state, selected)} />}
    </div>
  )
}

function Families() {
  const state = useStore(classes)
  const families = state.choices?.families ?? []
  const current = families.find(f => f.id === currentFamily(state))
  if (!families.length) return <span className="dim">no families</span>
  return (
    <Picker label={`Family: ${current?.name ?? 'none'}`} title="Which family of types the diagram shows" ariaLabel="Families">
      {close => (
        <ul>
          {families.map(f => (
            <li key={f.id}>
              <button role="menuitemradio" aria-checked={f.id === current?.id} onClick={() => (pickFamily(f.id), close())}>
                <span className="dg-entry">{f.name}</span>
                <span className="dim">
                  {f.types.length} types{f.classes ? `, ${f.classes} ${f.classes === 1 ? 'class' : 'classes'}` : ''}
                  {f.id.includes(':') ? '' : ' · outside base'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Picker>
  )
}

function Folders({ current }: { current: string | undefined }) {
  const state = useStore(classes)
  const [filter, setFilter] = useState('')
  const folders = state.choices?.folders ?? []
  const shown = folders.filter(f => f.path.toLowerCase().includes(filter.toLowerCase())).slice(0, SHOWN)
  return (
    <Picker label={`Folder: ${current === undefined ? 'none' : current || '.'}`} title="Which folder's types the diagram shows (it follows the folder or file you select)" ariaLabel="Folders" width={380}>
      {close => (
        <>
          <input type="search" placeholder="Filter folders" value={filter} onChange={e => setFilter(e.target.value)} autoFocus aria-label="Filter folders" />
          <ul>
            <li>
              <button role="menuitemradio" aria-checked={state.folder === null} onClick={() => (pickFolder(null), close())}>
                <span className="dg-entry">The selected folder</span>
                <span className="dim">follows the selection</span>
              </button>
            </li>
            {shown.map(f => (
              <li key={f.path}>
                <button role="menuitemradio" aria-checked={state.folder === f.path} onClick={() => (pickFolder(f.path), close())}>
                  <span className="dg-entry">{f.path || '.'}</span>
                  <span className="dim">{f.types} types</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Picker>
  )
}
