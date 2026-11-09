// Terrain view: which metric raises the ground (the toolbar's "height"
// select). Kept here rather than in the viewer's options, remembered in this
// browser; a change re-runs the controller through the last ViewContext.
import type { GraphMeta } from '../../../core/model.ts'

export type Metric = 'complexity' | 'churn' | 'hotspot' | 'lines'

export const METRICS: readonly { id: Metric; label: string; key: string; history: boolean }[] = [
  { id: 'complexity', label: 'complexity', key: 'complexity', history: false },
  { id: 'churn', label: 'churn', key: 'churn', history: true },
  { id: 'hotspot', label: 'hotspots', key: 'hotspot', history: true },
  { id: 'lines', label: 'lines', key: 'loc', history: false },
]

const STORAGE_KEY = 'archrift.terrain.height'
const listeners = new Set<() => void>()
let chosen: Metric | undefined
let refresh: (() => void) | undefined

export function chosenMetric(): Metric {
  if (!chosen) {
    let saved: string | null = null
    try {
      saved = typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY)
    } catch {
      // storage blocked: the default
    }
    chosen = METRICS.find(m => m.id === saved)?.id ?? 'complexity'
  }
  return chosen
}

export function chooseMetric(metric: Metric) {
  chosen = metric
  try {
    window.localStorage.setItem(STORAGE_KEY, metric)
  } catch {
    // not remembered, still shown
  }
  listeners.forEach(l => l())
  refresh?.()
}

export function onMetricChange(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** How to re-run the controller when the metric changes (the latest ViewContext's refresh). */
export function setRefresh(fn: () => void) {
  refresh = fn
}

let history = false

/** Whether the graph has a git history (churn and hotspots need one): the select offers them then. */
export const historyAvailable = () => history

export function setHistoryAvailable(available: boolean) {
  if (available === history) return
  history = available
  listeners.forEach(l => l())
}

/** The metric shown: the chosen one, or complexity when it needs a git history the graph lacks. */
export function effectiveMetric(meta: Pick<GraphMeta, 'history'> | undefined): (typeof METRICS)[number] {
  const m = METRICS.find(x => x.id === chosenMetric())!
  return m.history && !meta?.history ? METRICS[0] : m
}
