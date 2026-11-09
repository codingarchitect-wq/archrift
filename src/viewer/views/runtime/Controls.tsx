// Runtime view: the toolbar's scenario picker (every page and API route, with
// how far it reaches or, once traced, its messages) and the replay switch.
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { currentEntry, pickScenario, runtime, setReplay } from './choice.ts'

export function Controls() {
  const state = useStore(runtime)
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
  const current = currentEntry(state.entries, state.picked)
  const pages = state.entries.filter(e => !e.api)
  const routes = state.entries.filter(e => e.api)
  const row = (e: (typeof state.entries)[number]) => (
    <li key={e.id}>
      <button
        role="menuitemradio"
        aria-checked={e.id === current?.id}
        onClick={() => {
          pickScenario(e.id)
          setOpen(false)
        }}
      >
        <span className="rt-entry">{e.name}</span>
        <span className="dim">{e.messages !== undefined ? `${e.messages} messages` : `${e.reach} files${e.data ? ', reaches data' : ''}`}</span>
      </button>
    </li>
  )
  return (
    <div className="group">
      <div className="popover-anchor" ref={ref}>
        <button aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} title="Which scenario the diagram shows: a page or an API route">
          Scenario: {current?.name ?? 'none'} ▾
        </button>
        {open && (
          <div className="panel popover rt-scenarios" role="menu" aria-label="Scenarios" style={{ left: 0, right: 'auto', width: 340 }}>
            {pages.length > 0 && <div className="dim rt-group">Pages</div>}
            <ul>{pages.map(row)}</ul>
            {routes.length > 0 && <div className="dim rt-group">API routes</div>}
            <ul>{routes.map(row)}</ul>
            {!state.entries.length && <p className="dim">No pages, API routes or entry points.</p>}
          </div>
        )}
      </div>
      <button aria-pressed={state.replay} onClick={() => setReplay(!state.replay)} title="A pulse replays the messages in order">
        replay
      </button>
    </div>
  )
}
