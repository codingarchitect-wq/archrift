// Risks view: the register the toolbar shows (arc42 §11's table), published
// by the plug-in whenever the model changes, read by its Controls and Legend.
import { createStore } from 'zustand/vanilla'
import type { ChangeMeasure, Debt, RiskModel } from './model.ts'

export interface RegisterRow {
  id: string
  name: string
  folder: string
  rank: number
  likelihood: number
  impact: number
  risk: number
  change: number
  dependents: number
  debts: Debt[]
  ruleError: boolean
}

export interface RegisterState {
  rows: RegisterRow[]
  measure: ChangeMeasure
  /** The history window, for "lines changed in the last N days". */
  windowDays: number
  high: number
  debtCounts: Partial<Record<Debt, number>>
  /** Identifies what was published, so the same model isn't published twice. */
  key: string
}

export const register = createStore<RegisterState>()(() => ({ rows: [], measure: 'churn', windowDays: 90, high: 0, debtCounts: {}, key: '' }))

export function publish(model: RiskModel, windowDays: number, nameOf: (id: string) => { name: string; folder: string }) {
  const key = `${model.measure}|${windowDays}|${model.files.map(f => `${f.id}:${f.rank}:${f.risk}:${f.debts.join('+')}`).join(',')}`
  if (register.getState().key === key) return
  register.setState({
    key,
    measure: model.measure,
    windowDays,
    high: model.high,
    debtCounts: model.debtCounts,
    rows: model.files.map(f => ({ ...nameOf(f.id), id: f.id, rank: f.rank, likelihood: f.likelihood, impact: f.impact, risk: f.risk, change: f.change, dependents: f.dependents, debts: f.debts, ruleError: f.ruleError })),
  })
}
