// Transit view: the toolbar's line picker. A button with how many lines are
// shown opens a checklist of every line (its color, stations, where it ends)
// with presets for the top few by stations.
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { choice, shownIds, showTop, toggleLine } from './choice.ts'
import { MAX_LINES } from './network.ts'

const PRESETS: [string, number][] = [
  ['6', 6],
  ['12', 12],
  ['20', 20],
  ['all', MAX_LINES],
]

export function Controls() {
  const state = useStore(choice)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // the Escape closes this, and doesn't also clear the selection
      setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])
  const shown = shownIds(state, state.lines)
  return (
    <div className="popover-anchor" ref={ref}>
      <button aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title="Which lines the map shows">
        Lines {shown.size}/{state.lines.length} ▾
      </button>
      {open && (
        <div className="panel popover" role="dialog" aria-label="Lines" style={{ left: 0, right: 'auto', width: 320 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="dim">Top by stations</span>
            <div className="seg" role="group" aria-label="Top lines">
              {PRESETS.map(([label, n]) => (
                <button key={label} aria-pressed={!state.picked && state.top === n} onClick={() => showTop(n)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {state.lines.length ? (
            <ul aria-label="Lines" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '55vh', overflowY: 'auto' }}>
              {state.lines.map(l => (
                <li key={l.id}>
                  <label style={{ padding: '2px 0' }}>
                    <input type="checkbox" aria-label={l.name} checked={shown.has(l.id)} onChange={() => toggleLine(l.id)} />
                    <i aria-hidden style={{ background: l.color, width: 16, height: 5, borderRadius: 3, flex: 'none' }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                    <span className="dim" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', fontSize: 11 }}>
                      {l.stations} stations{l.end === 'none' ? '' : ` · ${l.end}`}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dim" style={{ margin: 0 }}>
              No lines: no pages, API routes or entry points with dependencies.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
