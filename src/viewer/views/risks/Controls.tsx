// Risks view: the toolbar's risk register, arc42 §11's table. A button with
// how many risks are high opens the files by priority: rank, file, likelihood,
// impact, risk and the debt each carries. A row selects its file.
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { actions, store } from '../../store.ts'
import { DEBT_NAMES, debtColor } from './colors.ts'
import { DEBTS, levelOf } from './model.ts'
import { register } from './register.ts'
import type { RegisterRow } from './register.ts'

const FIRST = 40
const light = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches

export function Controls() {
  const state = useStore(register)
  const selected = useStore(store, s => s.selected)
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
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
  const rows = all ? state.rows : state.rows.slice(0, FIRST)
  return (
    <div className="popover-anchor" ref={ref}>
      <button aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title="The risk register: every file by priority (arc42 §11)">
        Register <span className={`risks-count${state.high ? '' : ' none'}`}>{state.high}</span> ▾
      </button>
      {open && (
        <div className="panel popover risks-register" role="dialog" aria-label="Risk register">
          <div className="risks-register-head">
            <b>Risks by priority</b>
            <span className="dim">
              {state.high} high of {state.rows.length} files
            </span>
          </div>
          <table>
            <colgroup>
              <col className="rank" />
              <col />
              <col className="scale" />
              <col className="scale" />
              <col className="risk" />
              <col className="debt" />
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>file</th>
                <th title="Likelihood of change, 1–5">L</th>
                <th title="Impact: what depends on it, 1–5">I</th>
                <th title="Likelihood × impact">risk</th>
                <th>debt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <Row key={r.id} row={r} selected={r.id === selected} />
              ))}
            </tbody>
          </table>
          {state.rows.length > FIRST && (
            <button className="risks-more" onClick={() => setAll(!all)}>
              {all ? `First ${FIRST} only` : `All ${state.rows.length} files`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ row, selected }: { row: RegisterRow; selected: boolean }) {
  const isLight = light()
  return (
    <tr className={selected ? 'selected' : undefined} onClick={() => void actions.select(row.id)} aria-selected={selected}>
      <td className="dim">{row.rank}</td>
      <td className="risks-file" title={row.folder ? `${row.folder}/${row.name}` : row.name}>
        <button className="risks-link" onClick={e => (e.stopPropagation(), void actions.select(row.id))}>
          {row.name}
        </button>
        <span className="dim"> {row.folder}</span>
      </td>
      <td>{row.likelihood}</td>
      <td>{row.impact}</td>
      <td>
        <span className={`risks-level ${levelOf(row.risk)}`}>{row.risk}</span>
      </td>
      <td className="risks-debts">
        {DEBTS.filter(d => row.debts.includes(d)).map(d => (
          <i key={d} title={DEBT_NAMES[d]} style={{ background: debtColor(d === 'rule' && row.ruleError ? 'ruleError' : d, isLight) }} />
        ))}
      </td>
    </tr>
  )
}
