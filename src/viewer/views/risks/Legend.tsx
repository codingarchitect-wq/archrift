// The Risks view's key: the risk heat, the debt rings, and what likelihood,
// impact and height were measured by.
import { useStore } from 'zustand'
import { Arc42Legend, Swatch } from '../arc42-kit/Legend.tsx'
import { DEBT_NAMES, debtColor } from './colors.ts'
import { DEBTS } from './model.ts'
import { register } from './register.ts'

const MEASURE = {
  churn: (days: number) => `lines changed in the last ${days} days`,
  commits: () => 'commits',
  proxy: () => 'complexity × what it uses (no git history)',
}

export function Legend() {
  const state = useStore(register)
  const light = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
  return (
    <Arc42Legend
      section="risks"
      note={
        <span className="dim">
          likelihood: {MEASURE[state.measure](state.windowDays)} · impact: files that depend on it, directly or not · height: complexity
        </span>
      }
    >
      <Swatch color="var(--ok)">low</Swatch>
      <Swatch color="var(--warn)">medium</Swatch>
      <Swatch color="var(--danger)">high risk</Swatch>
      {DEBTS.map(d => (
        <Swatch key={d} color={debtColor(d, light)}>
          {DEBT_NAMES[d]}
          {state.debtCounts[d] ? ` (${state.debtCounts[d]})` : ''}
        </Swatch>
      ))}
    </Arc42Legend>
  )
}
