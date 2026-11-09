// Viewer state: a vanilla zustand store the scene controller and
// the React panels both read. Selection history works like a browser's; the
// options live in the URL query and the selection in its hash.
import { createStore } from 'zustand/vanilla'
import { NO_DESCRIPTIONS } from '../core/descriptions.ts'
import type { Description, ResolvedDescriptions } from '../core/descriptions.ts'
import { fileIdOf } from '../core/ids.ts'
import type { GraphNode } from '../core/model.ts'
import { applyPatch } from '../core/patch.ts'
import type { GraphPatch } from '../core/patch.ts'
import type { Violation } from '../core/rules.ts'
import { api } from './api.ts'
import type { Answer, AskContext, ChangesReport, FileDetails, Info, SavedView, SnapshotInfo } from './api.ts'
import type { ChangesRange } from '../core/changes.ts'
import { DEFAULT_OPTIONS, optionsFromQuery, optionsToQuery } from './url-state.ts'
import type { Options } from './url-state.ts'
import { World } from './world.ts'

export type { ColorBy, EdgeMode, FocusDir, GroupBy, Layering, Names, Options, View } from './url-state.ts'

export interface SourceView {
  path: string
  /** Lines to show and, within them, the ones to emphasize. */
  start: number
  end: number
  focus?: [number, number]
  title: string
}

export interface State {
  status: 'loading' | 'ready' | 'error'
  error?: string
  info?: Info
  /** What the viewer shows: now, or a snapshot on the timeline. */
  world?: World
  /** The codebase as analyzed now. */
  now?: World
  /** From `archrift snapshot`, oldest first. */
  snapshots: SnapshotInfo[]
  /** Loaded snapshots, by sha. */
  pastWorlds: Record<string, World>
  /** Every directory, file and package of now and the snapshots, sized by the largest each was: the timeline's layout. */
  union: GraphNode[] | null
  /** Watch mode: the graph version shown, and what the latest change was. */
  version: number
  live: { at: number; ms: number; files: string[] } | null
  /** Watch mode: every node seen since the page loaded, sized by the largest each was, so a save doesn't shuffle the city. */
  liveBase: GraphNode[] | null
  /** Areas in color order as first loaded: colors stay put through time and live changes. */
  areaIds: string[]
  /** Per file of the shown world (cleared when the timeline moves). */
  details: Record<string, FileDetails>
  selected: string | null
  hovered: { id: string; x: number; y: number } | null
  back: string[]
  forward: string[]
  options: Options
  source: SourceView | null
  /** A camera trip the scene should make; seq changes per request. */
  travel: { to: string; from?: string; seq: number } | null
  /** Long-running work to show (the galaxy simulation, module detection). */
  task: { label: string; progress: number } | null
  /** What the current view found worth saying (Layers: dependencies pointing up; closedFiles: it never opens a file into floors). */
  viewStats: { upward?: number; layers?: number; closedFiles?: boolean } | null
  /** Path finder: from one node to another (`to` null while picking it). */
  path: { from: string; to: string | null } | null
  views: SavedView[]
  /** The keyboard and mouse cheat sheet is open. */
  help: boolean
  /** The project switcher: a project opening, or one that didn't. */
  projectStatus: { name: string; state: 'opening' | 'failed'; message: string } | null
  /** The names and descriptions written for the code (`archrift describe`), for the world shown. */
  descriptions: ResolvedDescriptions
  /** The change in progress (or a range of commits, `range`) against its base (the Changes panel), once asked for. */
  changes: { state: 'idle' | 'loading' | 'ready' | 'error'; report?: ChangesReport; error?: string; range: ChangesRange }
  /** The Ask bar: the question being answered (its steps so far), the last answer, the conversation, what it is about. */
  ask: {
    state: 'idle' | 'asking' | 'answered' | 'error'
    /** The popover with the input is open. */
    open: boolean
    /** The node the next question is about (the selection when it opened), if any. */
    about: string | null
    question?: string
    progress: string[]
    answer?: Answer
    error?: string
    history: NonNullable<AskContext['history']>
  }
}

/** The page's query when there is a page: importing the store stays safe outside a browser (tests, view plug-ins). */
const PAGE_SEARCH = typeof location === 'undefined' ? '' : location.search

export const store = createStore<State>()(() => ({
  status: 'loading',
  snapshots: [],
  pastWorlds: {},
  union: null,
  version: 0,
  live: null,
  liveBase: null,
  areaIds: [],
  details: {},
  selected: null,
  hovered: null,
  back: [],
  forward: [],
  options: optionsFromQuery(PAGE_SEARCH, DEFAULT_OPTIONS),
  source: null,
  travel: null,
  task: null,
  viewStats: null,
  path: null,
  views: [],
  help: false,
  projectStatus: null,
  descriptions: NO_DESCRIPTIONS,
  changes: { state: 'idle', range: {} },
  ask: { state: 'idle', open: false, about: null, progress: [], history: [] },
}))

const pending = new Map<string, Promise<FileDetails | undefined>>()
/** The project the page's link asks for, read before the URL is rewritten with the open one. */
const LINKED_PROJECT = new URLSearchParams(PAGE_SEARCH).get('project')
let travelSeq = 0

/** Any node the viewer knows: from the overview, or from a loaded file's details. */
export function findNode(s: State, id: string): GraphNode | undefined {
  const n = s.world?.node(id)
  if (n) return n
  for (const d of Object.values(s.details)) {
    const hit = d.symbols.find(x => x.id === id) ?? d.endpoints.find(x => x.id === id)
    if (hit) return hit
  }
  return undefined
}

/** What was written about a node or group (`archrift describe`), if anything. */
export const describedOf = (s: State, id: string | null | undefined): Description | undefined => (id ? s.descriptions.entries[id] : undefined)

/**
 * A label: the described name when the toolbar asks for those and one was written, else the code's.
 * Words written for a folder's own files (`src` above `src/lib`) name only a unit of those files
 * (`ownFiles`), never the folder: it holds the blocks below too, and in the layers view stands on every plane.
 */
export function labelOf(s: State, id: string, fallback: string, ownFiles = false): string {
  const d = s.options.names === 'described' ? s.descriptions.entries[id] : undefined
  return d?.name && (ownFiles || !d.ownFiles) ? d.name : fallback
}

const namesVersions = new WeakMap<ResolvedDescriptions, number>()
let namesVersion = 0
/**
 * For a view's `layoutKey` when its layout depends on its labels' text (their widths, a wall of
 * names): changes with the toolbar's names option, and with the descriptions loaded while it asks for those.
 */
export function namesKey(s: State): string {
  if (s.options.names !== 'described') return 'code'
  let v = namesVersions.get(s.descriptions)
  if (v === undefined) namesVersions.set(s.descriptions, (v = ++namesVersion))
  return `described:${v}`
}

/** Fetch the descriptions again (the file changed, or the code shown did). */
async function refreshDescriptions() {
  const asked = store.getState().world
  const descriptions = await api.descriptions().catch(() => NO_DESCRIPTIONS)
  if (store.getState().world === asked) store.setState({ descriptions })
}

/** An answer's selection: the nodes it is about, lit on the map, its walkthrough drawn between them. */
export const ANSWER_ID = 'answer:current'

/** Where an answer's node stands on the map: a function on its file's building. */
export const answerSceneId = (id: string) => fileIdOf(id) ?? id

/** What a question can be about: a node (not a violation, a cycle, a group, the changes or an answer). */
const askable = (id: string | null) => (id && /^[fdsx]:/.test(id) ? id : null)

let asking: AbortController | undefined

/** The Changes panel's selection: the changed files, lit on the map. */
export const CHANGES_ID = 'changes:all'

/** The changed files the world shown has (a removed one has no building). */
export function changedFileIds(s: State): string[] {
  const files = s.changes.report?.files ?? []
  return files.filter(f => f.status !== 'removed' && s.world?.node(`f:${f.path}`)).map(f => `f:${f.path}`)
}

let changesSeq = 0
/** Compare the change in progress with its base again (after a live change, or when asked). */
async function loadChanges(fresh = '') {
  const seq = ++changesSeq
  const { report: had, range } = store.getState().changes
  store.setState({ changes: { state: 'loading', report: had, range } })
  try {
    const report = await api.changes(fresh, range)
    if (seq === changesSeq) store.setState({ changes: { state: 'ready', report, range } })
  } catch (err) {
    if (seq === changesSeq) store.setState({ changes: { state: 'error', report: had, range, error: err instanceof Error ? err.message : String(err) } })
  }
}

/** A `violation:<i>` selection's rule violation. */
export function violationOf(s: State, id: string | null | undefined): Violation | undefined {
  return id?.startsWith('violation:') ? s.world?.graph.meta.violations?.[Number(id.slice(10))] : undefined
}

/** Every file or package a violation is about: its path, or its two ends. */
export const violationNodes = (v: Violation) => v.path ?? [v.from, v.to]

/** Where a violation gets fixed: the file that imports what it shouldn't (for a cycle, any of them). */
export function fixAt(v: Violation) {
  const p = v.path
  return p && p.length > 1 && p[0] !== p[p.length - 1] ? p[p.length - 2] : v.from
}

/** Timeline points, oldest first: the snapshots, then now (sha ''). */
export function timelinePoints(s: State): { sha: string; label: string; time?: number; subject?: string }[] {
  return [
    ...s.snapshots.map(x => ({ sha: x.sha, label: new Date(x.time * 1000).toISOString().slice(0, 10), time: x.time, subject: x.subject })),
    { sha: '', label: 'now' },
  ]
}

/** The world shown just before this point on the timeline (for what changed). */
export function previousWorld(s: State): World | undefined {
  const points = timelinePoints(s)
  const i = points.findIndex(p => p.sha === (s.options.timeline ? s.options.at : ''))
  const prev = i > 0 ? points[i - 1].sha : undefined
  return prev === undefined ? undefined : (s.pastWorlds[prev] ?? (prev === '' ? s.now : undefined))
}

/** Areas in color order: on the timeline or after live changes, the order first loaded, so an area keeps its color. */
export function areaOrder(s: State): GraphNode[] {
  const world = s.world!
  if (!s.liveBase && (!s.options.timeline || s.now === world)) return world.areas
  const first = new Set(s.areaIds)
  return [...s.areaIds.flatMap(id => world.node(id) ?? []), ...world.areas.filter(a => !first.has(a.id))]
}

/** Directories, files and packages over several versions; a file is as large as it ever was, so the layout doesn't move in time. */
function unionOf(versions: readonly (readonly GraphNode[])[]): GraphNode[] {
  const nodes = new Map<string, GraphNode>()
  for (const list of versions)
    for (const n of list) {
      const had = nodes.get(n.id)
      if (!had) nodes.set(n.id, { ...n, metrics: n.metrics && { ...n.metrics } })
      else if ((n.metrics?.loc ?? 0) > (had.metrics?.loc ?? 0)) had.metrics = { ...had.metrics, loc: n.metrics!.loc }
    }
  return [...nodes.values()]
}

let loadingTimeline: Promise<void> | null = null

/** Load every snapshot once, the first time the timeline opens. */
function loadTimeline(): Promise<void> {
  loadingTimeline ??= (async () => {
    const list = store.getState().snapshots
    const worlds: Record<string, World> = {}
    let done = 0
    store.setState({ task: { label: 'Loading the timeline', progress: 0 } })
    try {
      await Promise.all(
        list.map(async snap => {
          worlds[snap.sha] = new World(await api.overview(snap.sha))
          store.setState({ task: { label: 'Loading the timeline', progress: ++done / list.length } })
        }),
      )
      const now = store.getState().now!
      store.setState({ pastWorlds: worlds, union: unionOf([now, ...list.map(x => worlds[x.sha]).reverse()].map(w => w.graph.nodes)) })
    } finally {
      store.setState({ task: null })
    }
  })()
  return loadingTimeline
}

/** Show the world the timeline options point at (now when it's closed or points nowhere known). */
async function syncTime() {
  const s = store.getState()
  if (!s.now) return
  if (s.options.timeline && s.snapshots.length) await loadTimeline()
  const st = store.getState()
  const at = st.options.timeline ? st.options.at : ''
  const world = (at && st.pastWorlds[at]) || st.now!
  if (world === st.world) return
  api.setSnapshot(world === st.now ? '' : at)
  pending.clear()
  store.setState({ world, details: {} })
  void refreshDescriptions()
  // the selection's file, as it was then
  const file = st.selected ? fileIdOf(st.selected) : undefined
  if (file) void actions.ensureDetails(file)
}

/** Watch mode: apply each change the server pushes; reload the overview when a patch doesn't fit. */
function listen() {
  const events = new EventSource('/api/events')
  events.addEventListener('patch', e => applyLive(JSON.parse((e as MessageEvent<string>).data) as GraphPatch & { ms: number }))
  events.addEventListener('reload', () => void reloadNow())
  events.addEventListener('descriptions', () => void refreshDescriptions())
  events.addEventListener('project', e => {
    const p = JSON.parse((e as MessageEvent<string>).data) as { state: 'opening' | 'open' | 'failed'; name: string; message?: string; error?: string }
    if (p.state === 'open') return openProjectPage(p.name)
    if (p.state === 'failed') return store.setState({ projectStatus: { name: p.name, state: 'failed', message: p.error ?? '' }, task: null })
    store.setState({ projectStatus: { name: p.name, state: 'opening', message: p.message ?? '' }, task: { label: `Opening ${p.name}: ${p.message ?? ''}`, progress: -1 } })
  })
  // after a lost connection the server may have moved on
  events.addEventListener('hello', e => {
    const { version } = JSON.parse((e as MessageEvent<string>).data) as { version: number }
    if (version !== store.getState().version) void reloadNow()
  })
}

function applyLive(patch: GraphPatch & { ms: number }) {
  const s = store.getState()
  if (!s.now || patch.from !== s.version) return void reloadNow()
  showNew(new World(applyPatch(s.now.graph, patch)), patch.to, { at: Date.now(), ms: patch.ms, files: patch.files }, new Set(patch.files))
}

/** Another project is open now: start over on it, keeping only the view. */
function openProjectPage(name: string) {
  const view = store.getState().options.view
  location.assign(`${location.pathname}?project=${encodeURIComponent(name)}${view !== DEFAULT_OPTIONS.view ? `&view=${view}` : ''}`)
}

async function reloadNow() {
  const [info, graph] = await Promise.all([api.info(), api.overview()])
  if (info.project !== store.getState().info?.project) return openProjectPage(info.project ?? '')
  store.setState({ info })
  showNew(new World(graph), info.version, { at: Date.now(), ms: 0, files: [] }, null)
}

/** A new version of now: shown unless the timeline points elsewhere; the layout keeps every file seen so far. */
function showNew(now: World, version: number, live: State['live'], changedFiles: Set<string> | null) {
  const s = store.getState()
  const showing = s.world === s.now
  const details = showing
    ? changedFiles
      ? Object.fromEntries(Object.entries(s.details).filter(([f]) => !changedFiles.has(f)))
      : {}
    : s.details
  pending.clear()
  store.setState({
    now,
    world: showing ? now : s.world,
    version,
    live,
    details,
    liveBase: unionOf([now.graph.nodes, s.liveBase ?? s.now!.graph.nodes]),
    union: s.union && unionOf([now.graph.nodes, s.union]),
  })
  const file = s.selected ? fileIdOf(s.selected) : undefined
  if (showing && file && !details[file]) void actions.ensureDetails(file)
  // a change to the code can leave a description stale, and changes the change in progress
  if (showing) void refreshDescriptions()
  if (showing && store.getState().changes.state !== 'idle') void loadChanges()
}

export const actions = {
  async load() {
    try {
      const [info, graph, views, snapshots, descriptions] = await Promise.all([
        api.info(),
        api.overview(),
        api.views().catch(() => []),
        api.capabilities.snapshots ? api.snapshots().catch(() => [] as SnapshotInfo[]) : ([] as SnapshotInfo[]),
        api.descriptions().catch(() => NO_DESCRIPTIONS),
      ])
      const world = new World(graph)
      store.setState(s => ({
        info,
        world,
        now: world,
        areaIds: world.areas.map(a => a.id),
        version: info.version,
        snapshots,
        views,
        descriptions,
        status: 'ready',
        options: { ...s.options, target: info.targets.includes(s.options.target) ? s.options.target : info.targets[0] },
      }))
      await syncTime()
      writeUrl()
      if (api.capabilities.live && (info.live || info.project !== undefined)) listen()
      // a link to another project of this server's list: open that one
      const wanted = LINKED_PROJECT
      if (info.project !== undefined && wanted && wanted !== info.project)
        api.openProject(wanted).catch((err: unknown) =>
          store.setState({ projectStatus: { name: wanted, state: 'failed', message: err instanceof Error ? err.message : String(err) } }),
        )
      const fromHash = decodeURIComponent(location.hash.replace(/^#n=/, ''))
      if (fromHash && location.hash.startsWith('#n=')) await actions.select(fromHash, { travel: true, history: false })
    } catch (err) {
      store.setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  async ensureDetails(fileId: string): Promise<FileDetails | undefined> {
    const have = store.getState().details[fileId]
    if (have) return have
    if (store.getState().world?.node(fileId)?.kind !== 'file') return undefined
    let p = pending.get(fileId)
    if (!p) {
      const asked = store.getState().world
      p = api.file(fileId).then(
        d => {
          // the timeline moved on while this loaded: it's about another world
          if (store.getState().world !== asked) return undefined
          store.setState(s => ({ details: { ...s.details, [fileId]: d } }))
          return d
        },
        () => undefined,
      )
      pending.set(fileId, p)
      p.finally(() => pending.delete(fileId))
    }
    return p
  },

  /**
   * Select a node. `from` makes the camera ride the arc from that node;
   * history is recorded unless told otherwise. While the path finder waits
   * for its target, the selection is that target.
   */
  async select(id: string | null, opts: { from?: string; history?: boolean; travel?: boolean } = {}) {
    const s = store.getState()
    if (s.path && s.path.to === null && id && id !== s.path.from) store.setState({ path: { from: s.path.from, to: id } })
    if (id === s.selected) {
      if (id && opts.travel) store.setState({ travel: { to: id, from: opts.from, seq: ++travelSeq } })
      return
    }
    const file = id ? fileIdOf(id) : undefined
    if (file) await actions.ensureDetails(file)
    // selecting something hidden shows its kind (a test file, an npm package)
    const shown = id ? s.world?.node(file ?? id) : undefined
    if (shown?.tags?.includes('test') && !s.options.tests) actions.setOption('tests', true)
    if (shown?.kind === 'external' && !s.options.externals) actions.setOption('externals', true)
    // a violation shows where it happens: its build target, and test files or packages on it
    const v = violationOf(s, id)
    if (v) {
      const ends = violationNodes(v).map(n => s.world?.node(n))
      if (!v.targets.includes(s.options.target)) actions.setOption('target', v.targets[0])
      if (ends.some(n => n?.tags?.includes('test')) && !s.options.tests) actions.setOption('tests', true)
      if (ends.some(n => n?.kind === 'external') && !s.options.externals) actions.setOption('externals', true)
    }
    const history = opts.history ?? true
    store.setState(st => ({
      selected: id,
      back: history && st.selected ? [...st.back, st.selected].slice(-200) : st.back,
      forward: history ? [] : st.forward,
      travel: id && opts.travel !== false ? { to: id, from: opts.from, seq: ++travelSeq } : st.travel,
    }))
    replaceHash(id)
  },

  async goBack() {
    const s = store.getState()
    const prev = s.back.at(-1)
    if (prev === undefined) return
    if (fileIdOf(prev)) await actions.ensureDetails(fileIdOf(prev)!)
    store.setState(st => ({
      back: st.back.slice(0, -1),
      forward: st.selected ? [...st.forward, st.selected] : st.forward,
      selected: prev,
      travel: { to: prev, from: st.selected ?? undefined, seq: ++travelSeq },
    }))
    replaceHash(prev)
  },

  async goForward() {
    const s = store.getState()
    const next = s.forward.at(-1)
    if (next === undefined) return
    if (fileIdOf(next)) await actions.ensureDetails(fileIdOf(next)!)
    store.setState(st => ({
      forward: st.forward.slice(0, -1),
      back: st.selected ? [...st.back, st.selected] : st.back,
      selected: next,
      travel: { to: next, from: st.selected ?? undefined, seq: ++travelSeq },
    }))
    replaceHash(next)
  },

  setOption<K extends keyof Options>(key: K, value: Options[K]) {
    store.setState(s => ({ options: { ...s.options, [key]: value } }))
  },

  setOptions(patch: Partial<Options>) {
    store.setState(s => ({ options: { ...s.options, ...patch } }))
  },

  /** Open the Changes panel: the changed files lit on the map, compared with the base the first time (or again, `fresh`). */
  async showChanges(opts: { fresh?: boolean } = {}) {
    const s = store.getState()
    if (s.options.colorBy !== 'changes') actions.setOption('colorBy', 'changes')
    if (s.changes.state === 'idle' || opts.fresh) await loadChanges(opts.fresh ? String(Date.now()) : '')
    await actions.select(CHANGES_ID, { travel: true })
  },

  /** Compare another range in the Changes panel: the change in progress (`{}`), the last commit, one commit, or everything since one. */
  async compareChanges(range: ChangesRange) {
    const s = store.getState()
    store.setState({ changes: { ...s.changes, range } })
    await loadChanges()
  },

  /** Open the Ask bar's input, about a node (the selection by default). */
  openAsk(about?: string | null) {
    const s = store.getState()
    store.setState({ ask: { ...s.ask, open: true, about: about === undefined ? askable(s.selected) : about } })
  },

  closeAsk() {
    store.setState(s => ({ ask: { ...s.ask, open: false } }))
  },

  /** Ask the agent: the answer's selection shows its steps as it works, then the answer, lit on the map. */
  async ask(question: string) {
    const s = store.getState()
    asking?.abort()
    const controller = new AbortController()
    asking = controller
    const about = s.ask.about
    const n = about ? findNode(s, about) : undefined
    const context: AskContext = { ...(about ? { selected: { id: about, ...(n?.name ? { name: n.name } : {}), ...(n?.path ? { path: n.path } : {}) } } : {}), view: s.options.view, history: s.ask.history.slice(-3) }
    store.setState({ ask: { ...s.ask, open: false, state: 'asking', question, progress: [], answer: undefined, error: undefined } })
    await actions.select(ANSWER_ID, { travel: false })
    try {
      const answer = await api.ask({ question, context }, text => store.setState(st => ({ ask: { ...st.ask, progress: [...st.ask.progress, text].slice(-60) } })), controller.signal)
      if (asking !== controller) return
      store.setState(st => ({ ask: { ...st.ask, state: 'answered', answer, history: [...st.ask.history, { question, answer: answer.answer, nodes: answer.nodes.map(x => x.id) }].slice(-6) } }))
      // frame what the answer is about
      if (store.getState().selected === ANSWER_ID) store.setState({ travel: { to: ANSWER_ID, seq: ++travelSeq } })
    } catch (err) {
      if (asking !== controller) return
      store.setState(st => ({ ask: { ...st.ask, state: 'error', error: controller.signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err) } }))
    }
  },

  /** Stop the agent working on the question. */
  stopAsking() {
    asking?.abort()
  },

  setHelp(open: boolean) {
    store.setState({ help: open })
  },

  hover(h: State['hovered']) {
    store.setState({ hovered: h })
  },

  openSource(view: SourceView) {
    store.setState({ source: view })
  },

  closeSource() {
    store.setState({ source: null })
  },

  /** Start the path finder from a node; the next selection is its target. */
  startPath(from: string) {
    store.setState({ path: { from, to: null } })
  },

  swapPath() {
    const p = store.getState().path
    if (p?.to) store.setState({ path: { from: p.to, to: p.from } })
  },

  clearPath() {
    store.setState({ path: null })
  },

  async saveView(name: string, camera?: SavedView['state']['camera']) {
    const s = store.getState()
    const view: SavedView = { name, state: { options: s.options, selected: s.selected, camera } }
    await api.saveView(view)
    store.setState(st => ({ views: [...st.views.filter(v => v.name !== name), view].sort((a, b) => a.name.localeCompare(b.name)) }))
  },

  async deleteView(name: string) {
    await api.deleteView(name)
    store.setState(st => ({ views: st.views.filter(v => v.name !== name) }))
  },

  /** Restore a saved view's options and selection (the caller restores its camera). */
  async applyView(view: SavedView) {
    store.setState(s => ({ options: { ...DEFAULT_OPTIONS, ...view.state.options, target: view.state.options.target || s.options.target } }))
    await actions.select(view.state.selected, { travel: !view.state.camera })
  },
}

/** Keep the selection in the URL hash so a reload (or a shared link) returns to it. */
function replaceHash(id: string | null) {
  window.history.replaceState(null, '', location.pathname + location.search + (id ? `#n=${encodeURIComponent(id)}` : ''))
}

/** Coloring by the change in progress needs it: compared the first time it's asked for. */
store.subscribe((s, prev) => {
  if (s.options.colorBy === 'changes' && prev.options.colorBy !== 'changes' && s.changes.state === 'idle' && s.status === 'ready' && api.capabilities.changes) void loadChanges()
  if (s.status === 'ready' && prev.status !== 'ready' && s.options.colorBy === 'changes' && s.changes.state === 'idle' && api.capabilities.changes) void loadChanges()
})

/** Moving on the timeline (or closing it) swaps the world. */
store.subscribe((s, prev) => {
  if (s.options.timeline !== prev.options.timeline || s.options.at !== prev.options.at) void syncTime()
})

/** The options in the URL query, and which project of the server's list this is. */
function writeUrl() {
  const s = store.getState()
  const query = optionsToQuery(s.options, { ...DEFAULT_OPTIONS, target: s.info?.targets[0] ?? '' })
  const project = s.info?.project === undefined ? '' : `project=${encodeURIComponent(s.info.project)}`
  const search = project ? (query ? `${query}&${project}` : `?${project}`) : query
  window.history.replaceState(null, '', location.pathname + search + location.hash)
}

store.subscribe((s, prev) => {
  if (s.options !== prev.options) writeUrl()
})
