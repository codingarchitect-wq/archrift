// Runtime view, part 3: which scenario is shown, and getting it. The
// scenarios are the pages and API routes; by default the one that reaches
// the data through the most files (a cheap estimate over the file-level
// graph). A scenario is walked once per graph shown, its files read through
// the API (cached), off the render: the layout waits for it and the view
// refreshes when it's there.
import { createStore } from 'zustand/vanilla'
import { fileIdOf } from '../../../core/ids.ts'
import type { GraphNode } from '../../../core/model.ts'
import { api } from '../../api.ts'
import type { FileDetails } from '../../api.ts'
import { store } from '../../store.ts'
import type { World } from '../../world.ts'
import { entriesOf, scenarioName, walkScenario } from './scenario.ts'
import type { Scenario } from './scenario.ts'

export interface EntryChoice {
  id: string
  name: string
  api: boolean
  /** Files it reaches within a few steps (the estimate), and in how many steps it gets to data (Infinity: not). */
  reach: number
  data: boolean
  steps: number
  /** Messages, once walked. */
  messages?: number
}

/** What the legend says about the scenario shown. */
export interface Shown {
  name: string
  participants: number
  messages: number
  fragments: number
  /** Calls found but left out. */
  left: number
  /** The databases it reaches. */
  data: string[]
  /** It crosses the network. */
  network: boolean
}

export interface RuntimeState {
  entries: EntryChoice[]
  shown: Shown | null
  /** The scenario picked by hand (an entry file), or null for the default. */
  picked: string | null
  /** The replay pulse runs. */
  replay: boolean
}

export const runtime = createStore<RuntimeState>()(() => ({ entries: [], shown: null, picked: null, replay: true }))

/** Run the viewer again (the plug-in hands over its ctx.refresh). */
let refresh = () => {}
export const setRefresh = (f: () => void) => (refresh = f)

export function pickScenario(id: string | null) {
  runtime.setState({ picked: id })
  refresh()
}

export function setReplay(on: boolean) {
  runtime.setState({ replay: on })
}

/** Publish what the legend says about the scenario shown (when it changed). */
export function publishShown(s: Scenario) {
  const shown: Shown = {
    name: s.name,
    participants: s.participants.length,
    messages: s.messages.length,
    fragments: s.fragments.length,
    left: s.left,
    data: s.participants.filter(p => p.kind === 'database' || p.kind === 'topic').map(p => p.name),
    network: s.participants.some(p => p.side === 'server') && s.participants.some(p => p.side === 'client' && p.kind !== 'actor'),
  }
  if (JSON.stringify(shown) !== JSON.stringify(runtime.getState().shown)) runtime.setState({ shown })
}

/** How far the estimate looks from an entry. */
const REACH_STEPS = 4
const REACH_KINDS = new Set(['calls', 'renders', 'instantiates', 'rpc-call', 'http-call', 'queries'])

const entryLists = new WeakMap<World, EntryChoice[]>()

/** The scenarios of a graph, with their estimates (cached per graph). */
export function entriesFor(world: World): EntryChoice[] {
  const hit = entryLists.get(world)
  if (hit) return hit
  const files = world.graph.nodes.filter(n => n.kind === 'file')
  const out = new Map<string, Set<string>>()
  const implementers = new Map<string, Set<string>>()
  const data = new Set<string>()
  for (const e of world.graph.edges) {
    if (!e.source.startsWith('f:') || !e.target.startsWith('f:') || e.source === e.target) continue
    if (e.kind === 'implements') add(implementers, e.target, e.source)
    if (!REACH_KINDS.has(e.kind)) continue
    add(out, e.source, e.target)
    if (e.kind === 'queries' || e.kind === 'rpc-call' || e.kind === 'http-call') data.add(e.target)
  }
  const list = entriesOf(files).map(entry => {
    // a breadth-first look: what it calls, and the classes behind the interfaces it calls
    const seen = new Set([entry.id])
    let frontier = [entry.id]
    let steps = Infinity
    for (let step = 0; step < REACH_STEPS && frontier.length; step++) {
      const next: string[] = []
      for (const f of frontier)
        for (const t of [...(out.get(f) ?? []), ...(implementers.get(f) ?? [])]) {
          if (seen.has(t)) continue
          seen.add(t)
          if (data.has(t)) steps = Math.min(steps, step + 1)
          next.push(t)
        }
      frontier = next
    }
    return { id: entry.id, name: scenarioName(entry), api: !!entry.tags?.some(t => t.startsWith('api:')), reach: seen.size, data: steps < Infinity, steps }
  })
  entryLists.set(world, list)
  return list
}

/** The scenario shown: the one picked, else one reaching the data through the most files (sooner, on a tie). */
export function currentEntry(entries: readonly EntryChoice[], picked: string | null): EntryChoice | undefined {
  const chosen = picked ? entries.find(e => e.id === picked) : undefined
  if (chosen) return chosen
  return [...entries].sort((a, b) => Number(b.data) - Number(a.data) || b.reach - a.reach || a.steps - b.steps || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0]
}

/** Publish the scenarios there are (only when they changed, so the picker doesn't re-render for nothing). */
export function publishEntries(entries: EntryChoice[]) {
  const had = runtime.getState().entries
  const same = had.length === entries.length && had.every((e, i) => e.id === entries[i].id && e.messages === entries[i].messages)
  if (!same) runtime.setState({ entries: entries.map(e => ({ ...e })) })
}

interface Walk {
  scenario?: Scenario
  failed?: string
}

const walks = new WeakMap<World, Map<string, Walk>>()
const files = new WeakMap<World, Map<string, Promise<FileDetails | undefined>>>()

/**
 * The scenario of an entry in a graph: there when walked, undefined while it's
 * being walked (the view refreshes when it's done), and started on first ask.
 */
export function scenarioFor(world: World, entry: GraphNode): Walk | undefined {
  let byEntry = walks.get(world)
  if (!byEntry) walks.set(world, (byEntry = new Map()))
  const had = byEntry.get(entry.id)
  if (had) return had.scenario || had.failed ? had : undefined
  const walk: Walk = {}
  byEntry.set(entry.id, walk)
  let cache = files.get(world)
  if (!cache) files.set(world, (cache = new Map()))
  const details = (id: string) => {
    let p = cache!.get(id)
    if (!p) cache!.set(id, (p = api.file(id).catch(() => undefined)))
    return p
  }
  const label = `Tracing ${scenarioName(entry)}`
  // say so when it takes a moment
  const slow = setTimeout(() => store.setState({ task: { label, progress: -1 } }), 200)
  const done = () => {
    clearTimeout(slow)
    if (store.getState().task?.label === label) store.setState({ task: null })
    refresh()
  }
  walkScenario({
    entry,
    details,
    line: (path, line) => api.source(path, line, line).then(r => r.lines[0]),
    file: id => world.node(id) ?? world.node(fileIdOf(id) ?? id),
  })
    .then(scenario => {
      walk.scenario = scenario
      const entries = entriesFor(world)
      const e = entries.find(x => x.id === entry.id)
      if (e) e.messages = scenario.messages.length
      done()
    })
    .catch((err: unknown) => {
      walk.failed = err instanceof Error ? err.message : String(err)
      done()
    })
  return undefined
}

function add<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
  const set = m.get(k)
  if (set) set.add(v)
  else m.set(k, new Set([v]))
}
