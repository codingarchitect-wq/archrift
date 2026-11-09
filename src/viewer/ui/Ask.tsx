// The Ask bar (core/ask.ts): a question in plain words for the coding agent on
// the server's machine. The toolbar's Ask opens the input (key `/`), about the
// selection when there is one; the answer shows in the inspector, its nodes lit
// on the map and its walkthrough drawn between them.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from 'zustand'
import { fileIdOf } from '../../core/ids.ts'
import { api } from '../api.ts'
import type { Answer } from '../api.ts'
import { ANSWER_ID, actions, findNode, store } from '../store.ts'
import { displayName } from './Inspector.tsx'

/** Questions to start from, before there is an answer to follow up on. */
const STARTERS = ['What are the main parts of this app, and how do they talk to each other?', 'What happens when a user signs in?', 'Where is data saved, and who writes it?']

const nodeName = (id: string) => {
  const n = findNode(store.getState(), id)
  return n?.kind === 'file' || n?.kind === 'directory' ? (n.path ?? n.name) : displayName(id, n)
}

/** The toolbar's Ask: the button, and the input it opens. */
export function AskButton() {
  const open = useStore(store, s => s.ask.open)
  const state = useStore(store, s => s.ask.state)
  const status = useStore(store, s => s.info?.ask)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) actions.closeAsk()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  if (!api.capabilities.ask || !status) return null
  return (
    <div className="popover-anchor" ref={ref}>
      <button aria-expanded={open} onClick={() => (open ? actions.closeAsk() : actions.openAsk())} title={status.available ? `Ask ${status.engine} about the code (/)` : status.why}>
        Ask{state === 'asking' ? ' …' : ''} ▾
      </button>
      {open && <AskPanel />}
    </div>
  )
}

function AskPanel() {
  const about = useStore(store, s => s.ask.about)
  const status = useStore(store, s => s.info?.ask)
  const followUps = useStore(store, s => s.ask.answer?.followUps)
  const [question, setQuestion] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => input.current?.focus(), [])
  const submit = (q: string) => {
    if (q.trim() && status?.available) void actions.ask(q.trim())
  }
  const suggestions = followUps?.length ? followUps : STARTERS
  return (
    <div className="panel popover ask-panel" role="dialog" aria-label="Ask about the code">
      {about && (
        <p className="ask-about">
          About <b>{nodeName(about)}</b>{' '}
          <button className="link" onClick={() => actions.openAsk(null)} aria-label="Ask about the whole project instead">
            ✕
          </button>
        </p>
      )}
      <textarea
        ref={input}
        rows={3}
        value={question}
        disabled={!status?.available}
        placeholder={status?.available ? (about ? 'What does it do? Who uses it? What breaks if it changes?' : 'How does a request travel from the page to the database?') : status?.why}
        aria-label="Question"
        onChange={e => setQuestion(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit(question)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            actions.closeAsk()
          }
        }}
      />
      <div className="ask-row">
        <span className="dim">{status?.available ? `${status.engine} reads the code, read-only, on your sign-in` : status?.why}</span>
        <button disabled={!question.trim() || !status?.available} onClick={() => submit(question)}>
          Ask
        </button>
      </div>
      {status?.available && (
        <ul className="ask-suggestions" aria-label="Suggested questions">
          {suggestions.map(q => (
            <li key={q}>
              <button className="link" onClick={() => submit(q)}>
                {q}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The inspector on an answer: the question, the agent's steps while it works, then the answer and what it is about. */
export function AnswerView() {
  const ask = useStore(store, s => s.ask)
  const a = ask.answer
  return (
    <>
      <header>
        <div className="kind-line">
          <span className="badge">answer</span>
          {ask.state === 'asking' && <span className="badge">thinking…</span>}
        </div>
        <h2>{ask.state === 'answered' && a ? a.title : (ask.question ?? 'Ask about the code')}</h2>
        {ask.state === 'answered' && a && <p className="path">{a.question}</p>}
      </header>
      {ask.state === 'asking' && <Working steps={ask.progress} />}
      {ask.state === 'error' && (
        <section>
          <p className="ask-error">{ask.error}</p>
          <div className="actions">
            <button onClick={() => ask.question && void actions.ask(ask.question)}>Ask again</button>
          </div>
        </section>
      )}
      {ask.state === 'answered' && a && <AnswerBody a={a} />}
    </>
  )
}

function Working({ steps }: { steps: string[] }) {
  return (
    <section aria-live="polite">
      <ul className="ask-progress">
        {steps.slice(-12).map((t, i) => (
          <li key={`${i}${t}`} className={i === Math.min(steps.length, 12) - 1 ? 'current' : 'dim'}>
            {t}
          </li>
        ))}
        {!steps.length && <li className="current">Starting the agent…</li>}
      </ul>
      <div className="actions">
        <button onClick={() => actions.stopAsking()}>Stop</button>
      </div>
    </section>
  )
}

function AnswerBody({ a }: { a: Answer }) {
  const go = (id: string) => void actions.select(id, { from: ANSWER_ID })
  return (
    <>
      <section className="ask-answer">{rich(a.answer, a.refs, go)}</section>
      {a.steps.length > 0 && (
        <section>
          <h3>Step by step</h3>
          <ol className="rows ask-steps">
            {a.steps.map((s, i) => (
              <li key={`${i}${s.id}`}>
                <button className="row stacked" onClick={() => go(s.id)} title={s.id}>
                  <span className="name">
                    <span className="ask-step">{i + 1}</span> {nodeName(s.id)}
                  </span>
                  {s.note && <span className="dim">{s.note}</span>}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section>
        <h3>On the map ({a.nodes.length})</h3>
        <ul className="rows">
          {a.nodes.map(n => (
            <li key={n.id}>
              <button className="row stacked" onClick={() => go(n.id)} title={n.id}>
                <span className="name">{nodeName(n.id)}</span>
                <span className="dim">{n.note || (fileIdOf(n.id) ? fileIdOf(n.id)!.slice(2) : n.id)}</span>
              </button>
            </li>
          ))}
        </ul>
        {a.unknown.length > 0 && <p className="dim">Not on the map: {a.unknown.join(', ')}</p>}
      </section>
      {a.followUps.length > 0 && (
        <section>
          <h3>Ask next</h3>
          <ul className="ask-suggestions">
            {a.followUps.map(q => (
              <li key={q}>
                <button className="link" onClick={() => void actions.ask(q)}>
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="actions">
        <button onClick={() => actions.openAsk(null)}>Ask a follow-up</button>
        <button onClick={() => void actions.select(null)}>Back to the map</button>
      </div>
    </>
  )
}

/**
 * The answer's light markdown as elements (never as HTML): paragraphs, `-` and
 * `1.` lists, `code`, **bold**, and `[[ref]]` citations as links to their node.
 */
export function rich(text: string, refs: Record<string, string>, go: (id: string) => void): ReactNode[] {
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((t, i) => <li key={i}>{inline(t, refs, go)}</li>)
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>)
    list = null
  }
  let para: string[] = []
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '), refs, go)}</p>)
    para = []
  }
  for (const line of text.split('\n')) {
    const item = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (item) {
      flushPara()
      const ordered = !!item[2]
      if (!list || list.ordered !== ordered) {
        flush()
        list = { ordered, items: [] }
      }
      list.items.push(item[3])
    } else if (!line.trim()) {
      flushPara()
      flush()
    } else {
      flush()
      para.push(line.trim())
    }
  }
  flushPara()
  flush()
  return blocks
}

function inline(text: string, refs: Record<string, string>, go: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\[\[([^\]]+)\]\]|`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${m.index}`
    if (m[1] !== undefined) {
      const id = refs[m[1]]
      out.push(
        id ? (
          <button key={key} className="link ask-ref" onClick={() => go(id)} title={id}>
            {m[1].replace(/^[fsdx]:/, '').replace(/^.*#/, '')}
          </button>
        ) : (
          <code key={key}>{m[1]}</code>
        ),
      )
    } else if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>)
    else out.push(<strong key={key}>{m[3]}</strong>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** "Ask about this" in a node's inspector. */
export function AskAbout({ id }: { id: string }) {
  const available = useStore(store, s => !!s.info?.ask?.available)
  if (!api.capabilities.ask || !available) return null
  return (
    <button className="link ask-about-button" onClick={() => actions.openAsk(id)}>
      Ask about this ›
    </button>
  )
}
