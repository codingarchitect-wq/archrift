// Coherence view, part 2: which concern is shown (none: all of them, as how
// often each file strays from its block's way), and the report the plug-in
// publishes for its Controls and Legend.
import { createStore } from 'zustand/vanilla'
import type { ConcernKind, ConcernStats, Trend } from '../../../core/coherence.ts'
import type { Coherence } from './model.ts'
import { titleOf, wayColors } from './model.ts'

/** Files off their block's way the report lists by name. */
export const LISTED = 40

export interface WayRow {
  id: string
  label: string
  legacy: boolean
  files: number
  /** Of them written recently. */
  recent: number
  color: string
}

export interface ConcernRow {
  id: string
  title: string
  about: string
  kind: ConcernKind
  accepted?: string
  tests: boolean
  users: number
  ways: WayRow[]
  coherence: number
  local: number
  strays: number
  mixed: number
  transitions: number
  links: number
  trend: Trend
  recent: number
  recentStrays: number
  migration?: { from: string; to: string; done: number; left: number }
  newest?: string
  /** Blocks doing it several ways: name and ways. */
  mixing: { block: string; ways: string[] }[]
  blocks: number
  /** Files off their block's way, the first LISTED. */
  strayFiles: { id: string; path: string; ways: string[] }[]
}

export interface Report {
  key: string
  /** False for a graph analyzed before coherence was measured (an older server's, an older snapshot). */
  measured: boolean
  concerns: ConcernRow[]
  totals: Coherence['model']['totals']
  /** Recent work: files first committed after this (unix seconds). */
  since?: number
  blockKind: 'group' | 'folder'
  /** Blocks by load (extra ways to learn), the ones with any. */
  loads: { block: string; load: number }[]
}

/** The city painted by the ways, or the essay's clouds of dots. */
export type Mode = 'city' | 'clouds'
/** The clouds' dots in the colors of the job's ways (the culprits stand out), or of their group (the lobes do, culprits ringed). */
export type Paint = 'ways' | 'groups'

export interface ChoiceState {
  /** The concern shown, or null for all of them. */
  picked: string | null
  mode: Mode
  paint: Paint
  report: Report | null
  /** The clouds' groups (folders or groups) and their colors, largest first. */
  groups: { name: string; color: string }[]
}

// mode and paint are habits of whoever looks: kept in this browser when it can be, never needed
const MODE_KEY = 'archrift.coherence.mode'
const PAINT_KEY = 'archrift.coherence.paint'
const saved = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // no storage (a private window): the choice lasts until the page reloads
  }
}

export const choice = createStore<ChoiceState>()(() => ({
  picked: null,
  mode: saved(MODE_KEY) === 'clouds' ? 'clouds' : 'city',
  paint: saved(PAINT_KEY) === 'groups' ? 'groups' : 'ways',
  report: null,
  groups: [],
}))

/** Run the viewer again (the plug-in hands over its ctx.refresh). */
let refresh = () => {}
export const setRefresh = (f: () => void) => (refresh = f)

export function pickConcern(id: string | null) {
  if (choice.getState().picked === id) return
  choice.setState({ picked: id })
  refresh()
}

export function setMode(mode: Mode) {
  if (choice.getState().mode === mode) return
  choice.setState({ mode })
  save(MODE_KEY, mode)
  refresh()
}

export function setPaint(paint: Paint) {
  if (choice.getState().paint === paint) return
  choice.setState({ paint })
  save(PAINT_KEY, paint)
  refresh()
}

/** The concern shown: the one picked, if the graph has it. */
export function shownConcern(c: Coherence): ConcernStats | undefined {
  const id = choice.getState().picked
  return id ? c.model.byId.get(id) : undefined
}

export function publish(c: Coherence) {
  const m = c.model
  const measured = c.measured
  const key = `${measured}|${m.totals.users}|${m.totals.strays}|${m.concerns.map(x => `${x.concern.id}:${x.users}:${x.strays.length}:${x.ways}`).join(',')}|${c.blocks.kind}|${m.blocks.map(b => `${b.block}:${b.load}`).join(',')}`
  if (choice.getState().report?.key === key) return
  const path = (id: string) => (id.startsWith('f:') ? id.slice(2) : id)
  const rows = m.concerns.map((x): ConcernRow => {
    const colors = wayColors(x)
    const label = (id: string) => x.paradigms.find(p => p.id === id)?.label ?? id
    return {
      id: x.concern.id,
      title: titleOf(x),
      about: x.concern.about,
      kind: x.kind,
      ...(x.concern.accepted ? { accepted: x.concern.accepted } : {}),
      tests: !!x.concern.tests,
      users: x.users,
      ways: x.paradigms.map(p => ({ id: p.id, label: p.label, legacy: p.legacy, files: p.files.length, recent: p.added.length, color: colors.get(p.id)! })),
      coherence: x.coherence,
      local: x.local,
      strays: x.strays.length,
      mixed: x.mixed.length,
      transitions: x.transitions.length,
      links: x.links,
      trend: x.trend,
      recent: x.fresh.length,
      recentStrays: x.freshStrays.length,
      ...(x.migration ? { migration: { from: x.migration.from.map(label).join(', '), to: label(x.migration.to), done: x.migration.done, left: x.migration.left.length } } : {}),
      ...(x.newest ? { newest: label(x.newest) } : {}),
      mixing: x.blocks.filter(b => b.paradigms.length > 1).map(b => ({ block: c.blocks.name(b.block), ways: b.paradigms.map(label) })),
      blocks: x.blocks.length,
      strayFiles: x.strays.slice(0, LISTED).map(id => ({ id, path: path(id), ways: (m.ways.get(id)?.get(x.concern.id) ?? []).map(label) })),
    }
  })
  choice.setState({
    report: {
      key,
      measured,
      concerns: rows,
      totals: m.totals,
      ...(m.since !== undefined ? { since: m.since } : {}),
      blockKind: c.blocks.kind,
      loads: m.blocks.filter(b => b.load > 0).map(b => ({ block: c.blocks.name(b.block), load: b.load })),
    },
  })
}
