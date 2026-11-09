// Toolbar: search (⌘K), back/forward, home, and the view options.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from 'zustand'
import { api } from '../api.ts'
import type { SearchHit } from '../api.ts'
import { actions, store } from '../store.ts'
import type { ColorBy, EdgeMode, GroupBy, Layering } from '../store.ts'
import { TOOLBAR_ENTRIES, isKnownView, pluginFor } from '../views/registry.ts'
import type { ToolbarEntry } from '../views/registry.ts'
import { ChangesButton, FiltersButton, HistoryButton, ProjectMenu, RulesButton, ViewsMenu } from './Tools.tsx'
import { runtime } from './runtime.ts'
import { AskButton } from './Ask.tsx'

const NO_TARGETS: string[] = []

export function Toolbar({ children }: { children?: ReactNode }) {
  const back = useStore(store, s => s.back.length)
  const forward = useStore(store, s => s.forward.length)
  const options = useStore(store, s => s.options)
  const targets = useStore(store, s => s.info?.targets ?? NO_TARGETS)
  const configuredLayers = useStore(store, s => (s.world?.graph.meta.layers?.length ?? 0) > 0)
  const configuredGroups = useStore(store, s => (s.world?.graph.meta.groups?.length ?? 0) > 0)
  const features = useStore(store, s => (s.world?.graph.meta.features?.length ?? 0) > 0)
  const configuredRules = useStore(store, s => (s.world?.graph.meta.rules?.length ?? 0) > 0)
  const history = useStore(store, s => !!s.now?.graph.meta.history)
  const described = useStore(store, s => Object.keys(s.descriptions.entries).length > 0)
  const Controls = pluginFor(options.view)?.Controls
  return (
    <nav className="panel toolbar" aria-label="Toolbar">
      <ProjectMenu />
      <Search />
      <AskButton />
      <div className="group views" role="group" aria-label="View">
        {TOOLBAR_ENTRIES.map((entry, i) =>
          entry.kind === 'group' ? (
            <ViewGroup key={`group:${entry.name}`} entry={entry} current={options.view} index={i} />
          ) : (
            <button
              key={entry.id}
              aria-pressed={options.view === entry.id || (entry.id === 'city' && !isKnownView(options.view))}
              onClick={() => actions.setOption('view', entry.id)}
              title={`${entry.description}${i < 9 ? ` (${i + 1})` : ''}`}
            >
              {entry.label}
            </button>
          ),
        )}
      </div>
      {Controls && <Controls />}
      {options.view !== 'layers' && pluginFor(options.view)?.groupBy !== false && (
        <label className="group">
          group
          <select value={options.groupBy} onChange={e => actions.setOption('groupBy', e.target.value as GroupBy)}>
            <option value="directory">by folder</option>
            {features && <option value="feature">by feature</option>}
            <option value="community">by detected module</option>
            <option value="layer">by layer</option>
            {configuredGroups && <option value="custom">by configured group</option>}
          </select>
        </label>
      )}
      {options.view === 'layers' && (
        <label className="group">
          layers
          <select value={configuredLayers ? options.layering : 'auto'} disabled={!configuredLayers} onChange={e => actions.setOption('layering', e.target.value as Layering)}>
            {configuredLayers && <option value="config">configured</option>}
            <option value="auto">by dependencies</option>
          </select>
        </label>
      )}
      <div className="group">
        <button onClick={() => actions.goBack()} disabled={!back} title="Back (Alt+←)" aria-label="Back">
          ←
        </button>
        <button onClick={() => actions.goForward()} disabled={!forward} title="Forward (Alt+→)" aria-label="Forward">
          →
        </button>
        <button
          onClick={() => {
            actions.select(null)
            runtime.engine?.home()
          }}
          title="Whole city"
          aria-label="Home"
        >
          ⌂
        </button>
      </div>
      <div className="group options">
        {pluginFor(options.view)?.edges !== false && (
          <label>
            edges
            <select value={options.edges} onChange={e => actions.setOption('edges', e.target.value as EdgeMode)}>
              <option value="auto" title="Everyone's dependencies until you select something, then only its own">auto</option>
              <option value="all" title="Everyone's dependencies, also with a selection">all</option>
              <option value="selection">selection</option>
              {configuredRules && (
                <option value="violations" title="Only the dependencies that break an architecture rule">
                  violations
                </option>
              )}
              <option value="none">none</option>
            </select>
          </label>
        )}
        <label>
          color
          <select value={options.colorBy} onChange={e => actions.setOption('colorBy', e.target.value as ColorBy)}>
            <option value="area">area</option>
            <option value="group">group</option>
            <option value="complexity">complexity</option>
            <option value="fanIn">fan-in</option>
            <option value="cycles">import cycles</option>
            <option value="tests">tests reach</option>
            {configuredRules && <option value="violations">rule violations</option>}
            {history && <option value="churn">churn</option>}
            {history && <option value="hotspot">hotspots</option>}
            {history && <option value="age">last change</option>}
            {options.timeline && <option value="change">change on the timeline</option>}
            {api.capabilities.changes && <option value="changes">the change in progress</option>}
          </select>
        </label>
        {targets.length > 1 && (
          <label>
            target
            <select value={options.target} onChange={e => actions.setOption('target', e.target.value)}>
              {targets.map(t => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <input type="checkbox" checked={options.tests} onChange={e => actions.setOption('tests', e.target.checked)} /> tests
        </label>
        <label>
          <input type="checkbox" checked={options.externals} onChange={e => actions.setOption('externals', e.target.checked)} /> packages
        </label>
        {described && (
          <label title="Label folders, files and blocks with the names written for them (archrift describe) instead of the code's own">
            <input type="checkbox" checked={options.names === 'described'} onChange={e => actions.setOption('names', e.target.checked ? 'described' : 'code')} /> described names
          </label>
        )}
        <RulesButton />
        <ChangesButton />
        <HistoryButton />
        <LiveBadge />
        <button className="help-button" aria-label="Keyboard shortcuts and help" title="Help (?)" onClick={() => actions.setHelp(true)}>
          ?
        </button>
        <FiltersButton />
        <ViewsMenu />
      </div>
      {children}
    </nav>
  )
}

/** A group of views (the arc42 views) as one button: a menu of them, the one shown named on the button. */
function ViewGroup({ entry, current, index }: { entry: Extract<ToolbarEntry, { kind: 'group' }>; current: string; index: number }) {
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
  const shown = entry.views.find(v => v.id === current)
  return (
    <div className="popover-anchor view-group" ref={ref}>
      <button
        aria-pressed={!!shown}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={`The ${entry.name} views${index < 9 ? ` (${index + 1}; again for the next)` : ''}`}
      >
        {entry.name}
        {shown ? <span className="view-group-shown"> · {shown.label}</span> : null} ▾
      </button>
      {open && (
        <div className="panel popover view-group-menu" role="menu" aria-label={`${entry.name} views`}>
          {entry.views.map(v => (
            <button
              key={v.id}
              role="menuitemradio"
              aria-checked={v.id === current}
              onClick={() => {
                actions.setOption('view', v.id)
                setOpen(false)
              }}
            >
              <b>{v.label}</b>
              <span className="dim">{v.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Watch mode: on, and what the last change was. */
function LiveBadge() {
  const on = useStore(store, s => !!s.info?.live) && api.capabilities.live
  const last = useStore(store, s => s.live)
  if (!on) return null
  const text = last ? `updated ${last.files.length} file${last.files.length === 1 ? '' : 's'}${last.ms ? ` in ${last.ms} ms` : ''}` : 'watching'
  return (
    <span className="live" role="status" aria-label="Live updates" title={last ? `Last change ${new Date(last.at).toLocaleTimeString()}: ${last.files.join(', ')}` : 'Saving a file updates the city'}>
      <i key={last?.at ?? 0} className={last ? 'pulse' : ''} /> {text}
    </span>
  )
}

const KIND_LETTER: Record<string, string> = { directory: 'D', file: 'F', symbol: 'S', member: 'M', external: 'X' }

function Search() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // closing on blur waits a moment (so a click on a result lands); focusing again cancels it
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!query.trim()) return
    const ctl = new AbortController()
    const t = setTimeout(() => {
      api
        .search(query, ctl.signal)
        .then(h => {
          setHits(h)
          setActive(0)
        })
        .catch(() => {})
    }, 120)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const shown = query.trim() ? hits : []
  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return
    actions.select(hit.id)
    setQuery('')
    setOpen(false)
    input.current?.blur()
  }

  return (
    <div className="search" role="combobox" aria-expanded={open && shown.length > 0} aria-haspopup="listbox">
      <input
        ref={input}
        type="search"
        placeholder="Search files and symbols  ⌘K"
        aria-label="Search"
        value={query}
        onChange={e => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          clearTimeout(closing.current)
          setOpen(true)
        }}
        onBlur={() => (closing.current = setTimeout(() => setOpen(false), 150))}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') setActive(a => Math.min(a + 1, shown.length - 1))
          else if (e.key === 'ArrowUp') setActive(a => Math.max(a - 1, 0))
          else if (e.key === 'Enter') choose(shown[active])
          else if (e.key === 'Escape') {
            setQuery('')
            input.current?.blur()
          } else return
          e.preventDefault()
        }}
      />
      {open && shown.length > 0 && (
        <ul className="results" role="listbox">
          {shown.map((h, i) => (
            <li
              key={h.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={e => {
                e.preventDefault()
                choose(h)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`kind-letter kind-${h.kind}`}>{KIND_LETTER[h.kind]}</span>
              <span className="name">{h.id.startsWith('s:') ? h.id.slice(h.id.indexOf('#') + 1) : h.name}</span>
              <span className="dim">
                {h.described ? `“${h.described.length > 60 ? `${h.described.slice(0, 59)}…` : h.described}” · ` : ''}
                {h.subkind ? `${h.subkind} · ` : ''}
                {h.path ?? ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
