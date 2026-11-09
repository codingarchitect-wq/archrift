// View options ⇄ URL query: every filter, grouping and focus
// setting lives in the address, so any view can be bookmarked or shared.
// Only options that differ from the defaults are written.

export type EdgeMode = 'auto' | 'all' | 'selection' | 'violations' | 'none'
export type ColorBy = 'area' | 'complexity' | 'fanIn' | 'group' | 'cycles' | 'tests' | 'violations' | 'churn' | 'hotspot' | 'age' | 'change' | 'changes'
/**
 * Every view's id: the three built in, then the view plug-ins (a folder of src/viewer/views with an
 * index; tests/viewer/view-ids.test.ts keeps the list in step). `export html --view` checks names against it.
 */
export const VIEW_IDS = ['city', 'layers', 'galaxy', 'blocks', 'classes', 'coherence', 'context', 'crosscutting', 'erd', 'matrix', 'risks', 'runtime', 'terrain', 'transit', 'tree', 'wheel'] as const

/** city, layers, galaxy, or a view plug-in's id (src/viewer/views); unknown ones show the city. */
export type View = string
export type Layering = 'config' | 'auto'
export type GroupBy = 'directory' | 'feature' | 'community' | 'layer' | 'custom'
export type FocusDir = 'both' | 'out' | 'in'
/** Labels: the code's own names, or the names written for it (`archrift describe`) where it has one. */
export type Names = 'code' | 'described'
/** The Changes panel's arcs: the dependencies among the changed files, or every one they have. */
export type ChangeEdges = 'between' | 'all'

export interface Options {
  view: View
  /** Layers view: the configured layers, or levels derived from dependencies. */
  layering: Layering
  /** What the city's districts (and the galaxy's clusters) stand for. */
  groupBy: GroupBy
  edges: EdgeMode
  /** Route background arcs along the directory tree, so parallel ones bundle. */
  bundle: boolean
  tests: boolean
  externals: boolean
  target: string
  colorBy: ColorBy
  /** Edge kinds that count as dependencies; empty = all. */
  kinds: string[]
  /** Globs of files to leave out of the view; an outside node is matched by its id (`x:kafka:*`). */
  hide: string[]
  /** Leave out files smaller than this. */
  minLoc: number
  /** Show only files that are part of an import cycle. */
  onlyCycles: boolean
  /** Around a selection: follow what it uses, what uses it, or both … */
  focusDir: FocusDir
  /** … this many steps deep (0 = all the way). */
  focusDepth: number
  /** Draw a selected file's co-change partners as arcs. */
  coChange: boolean
  /** The timeline is open … */
  timeline: boolean
  /** … at this snapshot's commit ('' = now). */
  at: string
  /** Labels: the code's names or the described ones. */
  names: Names
  /** With the Changes panel open: the arcs among the changed files only, or to every file they use or are used by. */
  changeEdges: ChangeEdges
}

export const DEFAULT_OPTIONS: Options = {
  view: 'city',
  layering: 'config',
  groupBy: 'directory',
  edges: 'auto',
  bundle: true,
  tests: false,
  externals: false,
  target: '',
  colorBy: 'area',
  kinds: [],
  hide: [],
  minLoc: 0,
  onlyCycles: false,
  focusDir: 'both',
  focusDepth: 1,
  coChange: false,
  timeline: false,
  at: '',
  names: 'code',
  changeEdges: 'between',
}

const ENUMS: Partial<Record<keyof Options, readonly string[]>> = {
  layering: ['config', 'auto'],
  groupBy: ['directory', 'feature', 'community', 'layer', 'custom'],
  edges: ['auto', 'all', 'selection', 'violations', 'none'],
  colorBy: ['area', 'complexity', 'fanIn', 'group', 'cycles', 'tests', 'violations', 'churn', 'hotspot', 'age', 'change', 'changes'],
  focusDir: ['both', 'out', 'in'],
  names: ['code', 'described'],
  changeEdges: ['between', 'all'],
}

/** Short URL keys. */
const KEYS: Record<keyof Options, string> = {
  view: 'view',
  layering: 'layering',
  groupBy: 'group',
  edges: 'edges',
  bundle: 'bundle',
  tests: 'tests',
  externals: 'packages',
  target: 'target',
  colorBy: 'color',
  kinds: 'kinds',
  hide: 'hide',
  minLoc: 'minLines',
  onlyCycles: 'cycles',
  focusDir: 'focus',
  focusDepth: 'depth',
  coChange: 'cochange',
  timeline: 'timeline',
  at: 'at',
  names: 'names',
  changeEdges: 'changeEdges',
}

export function optionsToQuery(o: Options, defaults: Options = DEFAULT_OPTIONS): string {
  const params = new URLSearchParams()
  for (const key of Object.keys(KEYS) as (keyof Options)[]) {
    const v = o[key]
    const d = defaults[key]
    if (JSON.stringify(v) === JSON.stringify(d)) continue
    params.set(KEYS[key], Array.isArray(v) ? v.join(',') : String(v))
  }
  const q = params.toString()
  return q ? `?${q}` : ''
}

export function optionsFromQuery(query: string, defaults: Options = DEFAULT_OPTIONS): Options {
  const params = new URLSearchParams(query)
  const out: Options = { ...defaults, kinds: [...defaults.kinds], hide: [...defaults.hide] }
  const set = <K extends keyof Options>(key: K, value: Options[K]) => (out[key] = value)
  for (const key of Object.keys(KEYS) as (keyof Options)[]) {
    const raw = params.get(KEYS[key])
    if (raw === null) continue
    const d = defaults[key]
    if (typeof d === 'boolean') set(key, (raw === 'true') as never)
    else if (typeof d === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n) && n >= 0) set(key, n as never)
    } else if (Array.isArray(d)) set(key, raw.split(',').map(x => x.trim()).filter(Boolean) as never)
    else if (!ENUMS[key] || ENUMS[key]!.includes(raw)) set(key, raw as never)
  }
  return out
}
