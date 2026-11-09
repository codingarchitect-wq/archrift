// Risks view, part 1: the risk register (arc42 §11). Every file gets a
// likelihood of change and an impact, each on a scale of 1 to 5, and its
// risk is their product, the classic 5 × 5 matrix:
// - likelihood: how much it changed in the history window (churn, else
//   commits). Without git history, complexity × fan-out stands in (complex code
//   that uses much changes when what it uses does), and the legend says so.
// - impact: how many files depend on it, directly or not.
// Both scales: 1 for none at all; of the rest, the lower half is 2, the next
// quarter 3, the next 15 % 4 and the top 10 % 5, so the hot corner holds what
// stands out in this codebase, whatever its size. Debt is what each file carries besides:
// an import cycle, a broken rule, hidden coupling (it changes together with a
// file it doesn't depend on), no test reaching it, or complexity among the
// highest. Pure and deterministic: no scene, no store.
import type { GraphNode } from '../../../core/model.ts'
import type { Violation } from '../../../core/rules.ts'
import { dependentCounts } from './dependents.ts'

export type Debt = 'cycle' | 'rule' | 'coupling' | 'untested' | 'complex'

export const DEBTS: readonly Debt[] = ['cycle', 'rule', 'coupling', 'untested', 'complex']

export type ChangeMeasure = 'churn' | 'commits' | 'proxy'

export interface RiskFile {
  id: string
  /** 1–5. */
  likelihood: number
  impact: number
  /** likelihood × impact, 1–25. */
  risk: number
  /** What likelihood was measured by (lines changed, commits, or the stand-in), and impact (dependents). */
  change: number
  dependents: number
  complexity: number
  debts: Debt[]
  /** A broken rule is an error (not just a warning). */
  ruleError: boolean
  /** Priority, 1 first. */
  rank: number
}

export interface RiskModel {
  /** Highest priority first. */
  files: RiskFile[]
  byId: Map<string, RiskFile>
  measure: ChangeMeasure
  /** The upper bounds of scale steps 2, 3 and 4 (5 is everything above). */
  likelihoodSteps: number[]
  impactSteps: number[]
  /** How many files carry each debt. */
  debtCounts: Record<Debt, number>
  /** Files with a high risk (HIGH and up). */
  high: number
}

export interface RiskInput {
  /** The files to rate (no tests, no assets). */
  files: readonly GraphNode[]
  /** file → the files that depend on it (only these files count). */
  dependents: ReadonlyMap<string, readonly string[]>
  /** The graph has git history (churn and commits mean something). */
  history: boolean
  cycles: readonly (readonly string[])[]
  violations: readonly Violation[]
  /** Files that change in the same commits (git); left out without history. */
  coChanges?: (id: string) => readonly { other: string; commits: number; confidence: number; depends: boolean }[]
}

/** Risk from here up is high (the hot corner: 3 × 5, 4 × 4 and above). */
export const HIGH = 15
/** From here up, medium. */
export const MEDIUM = 8
/** Hidden coupling: changed together at least this often, in at least this share of the rarer file's commits. */
const COUPLING_COMMITS = 5
const COUPLING_CONFIDENCE = 0.5
/** Very complex: among the top 5 %, and at least this complex. */
const COMPLEX_SHARE = 0.05
const COMPLEX_MIN = 20

export function riskModel(input: RiskInput): RiskModel {
  const files = [...input.files].sort((a, b) => cmp(a.id, b.id))
  const ids = files.map(f => f.id)
  const known = new Set(ids)
  const m = (f: GraphNode, k: string) => f.metrics?.[k] ?? 0

  const measure: ChangeMeasure = !input.history ? 'proxy' : files.some(f => m(f, 'churn') > 0) ? 'churn' : 'commits'
  const changeOf = (f: GraphNode) => (measure === 'churn' ? m(f, 'churn') : measure === 'commits' ? m(f, 'commits') : m(f, 'complexity') * m(f, 'fanOut'))
  const change = new Map(files.map(f => [f.id, changeOf(f)]))
  const dependents = dependentCounts(ids, input.dependents)
  const likelihoodSteps = steps([...change.values()])
  const impactSteps = steps([...dependents.values()])

  // debts
  const inCycle = new Set(input.cycles.flat())
  const ruleSeverity = new Map<string, 'error' | 'warn'>()
  for (const v of input.violations)
    for (const id of v.path ?? [v.from, v.to]) if (ruleSeverity.get(id) !== 'error') ruleSeverity.set(id, v.severity)
  const complexities = files.map(f => m(f, 'complexity')).sort((a, b) => a - b)
  const complexFrom = Math.max(COMPLEX_MIN, complexities[Math.min(complexities.length - 1, Math.floor(complexities.length * (1 - COMPLEX_SHARE)))] ?? Infinity)
  const tested = files.some(f => f.metrics?.testReach !== undefined)

  const rated = files.map((f): Omit<RiskFile, 'rank'> => {
    const likelihood = scale(change.get(f.id)!, likelihoodSteps)
    const impact = scale(dependents.get(f.id)!, impactSteps)
    const debts: Debt[] = []
    if (inCycle.has(f.id) || f.tags?.includes('in-cycle')) debts.push('cycle')
    if (ruleSeverity.has(f.id)) debts.push('rule')
    if (input.coChanges?.(f.id).some(p => !p.depends && known.has(p.other) && p.commits >= COUPLING_COMMITS && p.confidence >= COUPLING_CONFIDENCE)) debts.push('coupling')
    if (tested && f.metrics?.testReach === 0) debts.push('untested')
    if (m(f, 'complexity') >= complexFrom) debts.push('complex')
    return {
      id: f.id,
      likelihood,
      impact,
      risk: likelihood * impact,
      change: change.get(f.id)!,
      dependents: dependents.get(f.id)!,
      complexity: m(f, 'complexity'),
      debts,
      ruleError: ruleSeverity.get(f.id) === 'error',
    }
  })

  // priority: the risk, then how far into its cell it is (change and dependents together), then the debt it carries
  const finer = (r: Omit<RiskFile, 'rank'>) => Math.log1p(r.change) * Math.log1p(r.dependents)
  rated.sort((a, b) => b.risk - a.risk || finer(b) - finer(a) || b.debts.length - a.debts.length || b.complexity - a.complexity || cmp(a.id, b.id))
  const ranked = rated.map((r, i) => ({ ...r, rank: i + 1 }))

  const debtCounts = Object.fromEntries(DEBTS.map(d => [d, ranked.filter(r => r.debts.includes(d)).length])) as Record<Debt, number>
  return {
    files: ranked,
    byId: new Map(ranked.map(r => [r.id, r])),
    measure,
    likelihoodSteps,
    impactSteps,
    debtCounts,
    high: ranked.filter(r => r.risk >= HIGH).length,
  }
}

/** Where a scale's steps 3, 4 and 5 begin, as shares of the values above zero. */
export const STEP_SHARES = [0.5, 0.75, 0.9]

/**
 * A scale's steps: the upper bounds of steps 2, 3 and 4, at STEP_SHARES of
 * the values above zero (rounded down, so in a small codebase the largest
 * value still reaches step 5). Zero is step 1; above the last bound, step 5.
 */
export function steps(values: readonly number[]): number[] {
  const positive = values.filter(v => v > 0).sort((a, b) => a - b)
  if (!positive.length) return [0, 0, 0]
  const at = (q: number) => positive[Math.max(0, Math.floor(q * positive.length) - 1)]
  return STEP_SHARES.map(at)
}

/** A value's step on a scale (1–5). */
export function scale(value: number, s: readonly number[]): number {
  if (value <= 0) return 1
  return 2 + (value > s[0] ? 1 : 0) + (value > s[1] ? 1 : 0) + (value > s[2] ? 1 : 0)
}

/** What a step of a scale spans, for a column or row label ("47–101", "> 237"). */
export function stepRange(step: number, s: readonly number[]): string {
  if (step === 1) return '0'
  const lo = step === 2 ? 1 : Math.floor(s[step - 3]) + 1
  if (step === 5) return `> ${fmt(s[2])}`
  const hi = s[step - 2]
  return lo >= hi ? fmt(hi) : `${fmt(lo)}–${fmt(hi)}`
}

/** The risk level of a cell or file. */
export const levelOf = (risk: number): 'high' | 'medium' | 'low' => (risk >= HIGH ? 'high' : risk >= MEDIUM ? 'medium' : 'low')

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : Math.round(n).toLocaleString('en-US'))
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
