// Transit view: which lines the map shows. By default the top few by number
// of stations; the toolbar's checklist picks others. Shared by the plug-in
// (which publishes the lines there are) and its Controls (which choose).
import { createStore } from 'zustand/vanilla'
import type { TransitLine } from './network.ts'

export const DEFAULT_TOP = 12

export interface LineChoice {
  id: string
  name: string
  stations: number
  end: TransitLine['end']
  color: string
}

export interface ChoiceState {
  /** The lines there are, best first. */
  lines: LineChoice[]
  /** Lines chosen by hand (ids), or null for the top `top`. */
  picked: string[] | null
  top: number
}

export const choice = createStore<ChoiceState>()(() => ({ lines: [], picked: null, top: DEFAULT_TOP }))

/** Run the viewer again (the plug-in hands over its ctx.refresh). */
let refresh = () => {}
export const setRefresh = (f: () => void) => (refresh = f)

/** The ids shown: the ones picked that exist, or the top N. */
export function shownIds(s: ChoiceState, available: readonly { id: string }[]): Set<string> {
  if (!s.picked) return new Set(available.slice(0, s.top).map(l => l.id))
  const picked = new Set(s.picked)
  return new Set(available.filter(l => picked.has(l.id)).map(l => l.id))
}

/** What the layout depends on. */
export const choiceKey = (s: ChoiceState) => (s.picked ? `picked:${s.picked.join(',')}` : `top:${s.top}`)

export function showTop(top: number) {
  choice.setState({ picked: null, top })
  refresh()
}

export function toggleLine(id: string) {
  const s = choice.getState()
  const shown = shownIds(s, s.lines)
  if (shown.has(id)) shown.delete(id)
  else shown.add(id)
  choice.setState({ picked: s.lines.filter(l => shown.has(l.id)).map(l => l.id) })
  refresh()
}

/** Publish the lines there are (only when they changed, so the checklist doesn't re-render for nothing). */
export function publishLines(lines: LineChoice[]) {
  const had = choice.getState().lines
  const same = had.length === lines.length && had.every((l, i) => l.id === lines[i].id && l.name === lines[i].name && l.stations === lines[i].stations && l.color === lines[i].color)
  if (!same) choice.setState({ lines })
}
