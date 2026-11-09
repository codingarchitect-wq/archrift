// §5 Building Block View: its own small state, shared by the plug-in and its
// legend: what the diagram shows.
import { createStore } from 'zustand/vanilla'

export interface BlocksSummary {
  /** The deepest board's title, and how many levels are open. */
  title: string
  levels: number
  blocks: number
  /** Dependencies between its blocks: all, drawn, pointing up. */
  links: number
  shown: number
  up: number
  /** What pointing up means: against the layers, or shared code using a feature. */
  upMeans: string
  /** Which dependencies are drawn (the toolbar's edges option), and whether a block is in focus for `selection`. */
  mode: string
  focused: boolean
}

export interface BlocksSettings {
  summary: BlocksSummary | null
}

export const settings = createStore<BlocksSettings>()(() => ({ summary: null }))

/** Publish what the diagram shows (only when it changed, so the legend doesn't re-render for nothing). */
export function publish(summary: BlocksSummary) {
  const had = settings.getState().summary
  if (had && (Object.keys(summary) as (keyof BlocksSummary)[]).every(k => had[k] === summary[k])) return
  settings.setState({ summary })
}
