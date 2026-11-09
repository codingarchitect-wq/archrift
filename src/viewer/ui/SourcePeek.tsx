// Source preview: the lines of a symbol or a reference site,
// highlighted, with the focus lines marked.
import { useEffect, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { useStore } from 'zustand'
import { NO_SOURCE } from '../../server/embed.ts'
import { api } from '../api.ts'
import type { SourceLines } from '../api.ts'
import { actions, store } from '../store.ts'
import type { SourceView } from '../store.ts'
import { tokenize } from './highlight.ts'
import { editorUrl } from './runtime.ts'

type Loaded = { view: SourceView; source: SourceLines; tokens?: ThemedToken[][] } | { view: SourceView; error: string }

export function SourcePeek() {
  const view = useStore(store, s => s.source)
  const loaded = useSource(view)
  if (!view) return null
  return (
    <section className="panel source" aria-label="Source">
      <SourceHeader view={view} />
      <SourceBody view={view} current={loaded?.view === view ? loaded : null} />
    </section>
  )
}

/** The lines of the view, then their tokens (none where the other end has no source). */
function useSource(view: SourceView | null) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  useEffect(() => {
    if (!view || !api.capabilities.source) return
    let cancelled = false
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    api
      .source(view.path, view.start, view.end)
      .then(async source => {
        if (cancelled) return
        setLoaded({ view, source })
        const tokens = await tokenize(view.path, source.lines.join('\n'), dark).catch(() => undefined)
        if (!cancelled && tokens) setLoaded({ view, source, tokens })
      })
      .catch(err => !cancelled && setLoaded({ view, error: String(err) }))
    return () => {
      cancelled = true
    }
  }, [view])
  return loaded
}

function SourceHeader({ view }: { view: SourceView }) {
  const root = useStore(store, s => s.info?.root ?? '')
  const mounts = useStore(store, s => s.info?.mounts)
  return (
    <header>
      <strong>{view.title}</strong>
      {root && (
        <a className="button" href={editorUrl(root, view.path, view.focus?.[0] ?? view.start, 1, mounts)}>
          Open in VS Code
        </a>
      )}
      <button onClick={() => actions.closeSource()} aria-label="Close source">
        ✕
      </button>
    </header>
  )
}

function SourceBody({ view, current }: { view: SourceView; current: Loaded | null }) {
  if (!api.capabilities.source) return <p className="dim">{NO_SOURCE}</p>
  if (!current) return <p className="dim">Loading…</p>
  if ('error' in current) return <p className="error">{current.error}</p>
  return (
    <pre className="code">
      {current.source.lines.map((line, i) => {
        const n = current.source.start + i
        const focus = view.focus && n >= view.focus[0] && n <= view.focus[1]
        return (
          <div key={n} className={focus ? 'line focus' : 'line'}>
            <span className="ln">{n}</span>
            <span className="text">
              {current.tokens?.[i]
                ? current.tokens[i].map((t, k) => (
                    <span key={k} style={{ color: t.color }}>
                      {t.content}
                    </span>
                  ))
                : line}
            </span>
          </div>
        )
      })}
    </pre>
  )
}
