// Help: the keyboard and mouse cheat sheet (`?`), and a hint
// for first-time visitors that goes away once they've clicked something.
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { actions, store } from '../store.ts'

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = mac ? '⌘' : 'Ctrl'

const KEYS: [string, string][] = [
  [`${MOD} K`, 'search files and symbols'],
  ['/', 'ask about the code: the selection, or the whole project (archrift serve with Claude Code)'],
  ['1 … 9', 'the views, in toolbar order: City, Layers, Galaxy …; a menu’s key again for its next view (arc42)'],
  ['Alt ← · Alt →', 'back · forward through what you selected'],
  ['Esc', 'close the source or path finder, then clear the selection'],
  ['?', 'this help'],
]

const MOUSE: [string, string][] = [
  ['drag', 'orbit'],
  ['right-drag', 'pan'],
  ['scroll', 'zoom'],
  ['click', 'select a building (file), a floor (symbol) or a district (folder)'],
  ['minimap', 'click to move the camera there'],
]

export function HelpDialog() {
  const open = useStore(store, s => s.help)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) close.current?.focus()
  }, [open])
  if (!open) return null
  return (
    <div className="modal" onMouseDown={e => e.target === e.currentTarget && actions.setHelp(false)}>
      <div className="panel help" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header>
          <h2 id="help-title">Getting around</h2>
          <button ref={close} className="icon" aria-label="Close help" onClick={() => actions.setHelp(false)}>
            ✕
          </button>
        </header>
        <div className="help-columns">
          <section>
            <h3>Keys</h3>
            <dl>
              {KEYS.map(([k, what]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h3>Mouse</h3>
            <dl>
              {MOUSE.map(([k, what]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <section>
          <h3>Where to start</h3>
          <ul>
            <li>
              <strong>A file's inspector</strong> lists what it uses and what uses it; click a row to fly there.
            </li>
            <li>
              <strong>Focus, Impact, Find path</strong> follow dependencies from the selection.
            </li>
            <li>
              <strong>Rules</strong> and <strong>History</strong> (toolbar) show broken architecture rules, hotspots, and the timeline.
            </li>
            <li>
              <strong>Filters</strong> and <strong>group</strong> tame a tangled city; the URL keeps every option.
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}

const HINT_KEY = 'archrift.hint.seen'

function seen() {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return true // no storage (a private window): don't nag
  }
}

function remember() {
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {
    // nothing to keep it in
  }
}

/** First visit: how to move around, until dismissed or the first selection. */
export function Onboarding() {
  const [show, setShow] = useState(() => !seen())
  const selected = useStore(store, s => s.selected)
  const ready = useStore(store, s => s.status === 'ready')
  useEffect(() => {
    if (show && selected) {
      remember()
      setShow(false)
    }
  }, [show, selected])
  if (!show || !ready) return null
  return (
    <div className="panel onboarding" role="note" aria-label="Getting started">
      <p>
        <strong>Drag</strong> to orbit, <strong>right-drag</strong> to pan, <strong>scroll</strong> to zoom. <strong>Click</strong> a building to open its file,{' '}
        <kbd>{MOD} K</kbd> to search, <kbd>?</kbd> for everything else.
      </p>
      <button
        onClick={() => {
          remember()
          setShow(false)
        }}
      >
        Got it
      </button>
    </div>
  )
}
