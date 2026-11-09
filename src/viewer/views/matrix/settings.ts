// The Matrix view's own small state, shared by its toolbar controls and its
// decoration: whether the digital rain falls (remembered per browser; off by
// default with prefers-reduced-motion), and what the matrix found, for the legend.
const KEY = 'archrift.matrix.rain'

export interface MatrixSummary {
  rows: number
  cells: number
  up: number
  cycle: number
  violation: number
  warning: number
  /** Folder depth rows were aggregated to; null for files. */
  depth: number | null
  metric: 'churn' | 'commits' | 'fanIn'
}

function observable<T>(initial: () => T) {
  let value: T | undefined
  let loaded = false
  const listeners = new Set<() => void>()
  return {
    get(): T {
      if (!loaded) {
        value = initial()
        loaded = true
      }
      return value as T
    },
    set(next: T) {
      value = next
      loaded = true
      listeners.forEach(l => l())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export const rain = observable<boolean>(() => {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'on' || saved === 'off') return saved === 'on'
  } catch {
    // no storage (private mode, tests)
  }
  return !reducedMotion()
})

export function setRain(on: boolean) {
  rain.set(on)
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // not remembered, still switched
  }
}

export const summary = observable<MatrixSummary | null>(() => null)
