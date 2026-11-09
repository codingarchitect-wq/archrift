// A new project's first look (`archrift init`): the layers its folders already
// keep, the starter rules (all errors), and the report of what the first
// analysis found. Plain data in and out: the CLI reads the files and renders
// the report.
import { autoLayers } from './auto-layers.ts'
import { folderBlocks } from './coherence.ts'
import type { CoherenceModel } from './coherence.ts'
import { GraphIndex } from './graph-index.ts'
import { isRuntimeImport } from './model.ts'
import type { Graph, GraphNode } from './model.ts'
import { bridgesOf, codeGraph, questionsOf } from './questions.ts'
import type { Bridge, Question } from './questions.ts'
import { isFunction } from './rules.ts'
import type { Rule } from './rules.ts'

/** Function complexity limits for the starter rules: cyclomatic complexity 10 in logic, 20 in UI code (rendering carries more branches). */
export const LIMITS = { logic: 10, ui: 20 } as const

/** Files the analysis reads as code (configuration and assets are files too). */
export const CODE = /\.(?:[cm]?[jt]sx?|kts?|go)$/

export interface Block {
  /** Its folder (`src/pages`); `src` alone holds the files beside the folders below it. */
  path: string
  /** The glob that selects its files. */
  match: string
  files: number
  loc: number
  /** Most of its files declare components. */
  ui: boolean
}

export interface Layer {
  name: string
  blocks: string[]
  match: string[]
}

export interface FirstLookShape {
  blocks: Block[]
  /** The block a production file belongs to. */
  blockOf: (path: string) => string | undefined
  /** Top to bottom; empty when the blocks import each other in a circle, or not at all (one level). */
  layers: Layer[]
}

const isCode = (n: GraphNode) => n.kind === 'file' && CODE.test(n.path ?? '') && !n.tags?.includes('test')

/**
 * The project's blocks (the folders its production code splits into) and the
 * layers they already keep: each block on the level of its longest runtime
 * dependency chain, blocks importing each other in a circle on one level.
 */
export function shapeOf(graph: Graph): FirstLookShape {
  const files = graph.nodes.filter(isCode)
  const blockOf = siblingBlocks(files.map(f => f.path!))
  const fileBlock = new Map(files.map(f => [f.id, blockOf(f.path!)!]))
  const names = [...new Set(fileBlock.values())].filter(b => b !== '(root)').sort()
  const components = new Set(graph.nodes.filter(n => n.kind === 'symbol' && n.subkind === 'component' && n.parent).map(n => n.parent!))
  const blocks = names.map(path => {
    const own = files.filter(f => fileBlock.get(f.id) === path)
    const beside = names.some(other => other.startsWith(`${path}/`))
    return {
      path,
      match: beside ? `${path}/*.*` : `${path}/**`,
      files: own.length,
      loc: own.reduce((s, f) => s + (f.metrics?.loc ?? 0), 0),
      ui: own.filter(f => components.has(f.id)).length * 2 >= own.length,
    }
  })

  const edges: { source: string; target: string }[] = []
  for (const e of graph.edges) {
    if (!isRuntimeImport(e)) continue
    const a = fileBlock.get(e.source)
    const b = fileBlock.get(e.target)
    if (a && b && a !== b && a !== '(root)' && b !== '(root)') edges.push({ source: a, target: b })
  }
  const auto = autoLayers(names, edges, id => id)
  if (auto.order.length < 2) return { blocks, blockOf, layers: [] }
  const byPath = new Map(blocks.map(b => [b.path, b]))
  const taken = new Set<string>()
  const layers = auto.order.map(level => {
    const members = names.filter(n => auto.layerOfArea.get(n) === level)
    const short = members.map(m => (byPath.get(m)!.match.endsWith('/*.*') ? `${m.split('/').pop()} (top files)` : m.split('/').pop()!))
    let name = short.length <= 3 ? short.join(' + ') : `${short.slice(0, 3).join(' + ')} + ${short.length - 3} more`
    for (let i = 2; taken.has(name); i++) name = `${short[0]} ${i}`
    taken.add(name)
    return { name, blocks: members, match: members.map(m => byPath.get(m)!.match) }
  })
  return { blocks, blockOf, layers }
}

/**
 * Blocks by folder (coherence's `folderBlocks`), with the folders beside the way down
 * to the blocks as blocks of their own: in a monorepo whose code is mostly in
 * `apps/api/src/`, `apps/web` and `apps/sdk` rather than one `apps`. A block keeps
 * only the files right in its folder when deeper blocks lie below it.
 */
function siblingBlocks(paths: readonly string[]): (path: string) => string | undefined {
  const folder = folderBlocks(paths)
  const known = [...new Set(paths.map(p => folder(p)!))]
  const deeper = (b: string) => known.some(o => o.startsWith(`${b}/`))
  return p => {
    let b = folder(p)!
    while (b !== '(root)' && deeper(b)) {
      const rest = p.slice(b.length + 1)
      if (!rest.includes('/')) break // a file right in the block's folder
      b = `${b}/${rest.slice(0, rest.indexOf('/'))}`
      if (!known.some(o => o === b || o.startsWith(`${b}/`))) break // a folder beside the way down
    }
    return b
  }
}

/**
 * The starter rules: no import cycles, imports down the layers found, and
 * function complexity under the limits (UI blocks get the higher one). Copied-in
 * kits and tests are held to neither limit. All are errors (the default
 * severity): `check` fails until the code keeps them, and `diff` on a change
 * that breaks one again or further.
 */
export function starterRules(shape: FirstLookShape, vendored: readonly string[]): Rule[] {
  const ui = shape.blocks.filter(b => b.ui).map(b => b.match)
  // a kit copied into a UI folder is left out of the logic limit already
  const outsideUi = vendored.filter(v => !ui.some(u => u.endsWith('/**') && v.startsWith(u.slice(0, -2))))
  const rules: Rule[] = [{ name: 'no-cycles', description: 'no files import each other in a circle', cycles: 'forbid' }]
  if (shape.layers.length)
    rules.push({ name: 'layers-point-down', description: 'runtime imports point down the layers, in the order init found', layers: 'down', runtimeOnly: true })
  rules.push({
    name: 'functions-small-logic',
    description: `functions outside the UI stay under complexity ${LIMITS.logic}`,
    limit: { functions: '**', except: [...ui, ...outsideUi, 'tag:test'], max: { complexity: LIMITS.logic - 1 } },
  })
  if (ui.length)
    rules.push({
      name: 'functions-small-ui',
      description: `components and the functions beside them stay under complexity ${LIMITS.ui}`,
      limit: { functions: ui, except: [...vendored, 'tag:test'], max: { complexity: LIMITS.ui - 1 } },
    })
  return rules
}

export interface FirstLook {
  project: string
  root: string
  generatedAt: string
  stack: string[]
  notes: string[]
  size: { files: number; loc: number; tests: number; functions: number; languages: { name: string; files: number }[] }
  history?: { commits: number; authors: number; since: string; until: string }
  config: { path: string; status: 'written' | 'kept' | 'dry-run' }
  excluded: { glob: string; why: string }[]
  vendored: { glob: string; what: string }[]
  layers: { name: string; blocks: { path: string; files: number; loc: number; ui: boolean }[] }[]
  /** Blocks in no layer: all of them when no layering was found (or the config has none). */
  blocks: { path: string; files: number; loc: number; ui: boolean }[]
  cycles: { count: number; largest: string[][] }
  /** Production files by churn × complexity; `score` is that product. */
  hotspots: { path: string; score: number; commits: number; churn: number; complexity: number; loc: number }[]
  /** The production files the most shortest dependency paths pass through, that connect blocks (questions.ts). */
  bridges: Bridge[]
  /** What the data points at but can't answer, the types taking turns (questions.ts). */
  questions: Question[]
  coherence: {
    mixed: { label: string; ways: { label: string; files: number }[]; blocks: string[] }[]
    one: { label: string; way: string; files: number }[]
  }
  functions: { bands: { label: string; count: number }[]; largest: { name: string; path: string; line: number; complexity: number; ui: boolean }[] }
  deadExports: { count: number; folders: { folder: string; count: number; vendored: boolean }[] }
  rules: { name: string; severity: 'error' | 'warn'; broken: number; description?: string }[]
}

export interface FirstLookInput {
  graph: Graph
  coherence: CoherenceModel
  root: string
  stack: string[]
  notes: string[]
  config: FirstLook['config']
  excluded: FirstLook['excluded']
  vendored: FirstLook['vendored']
  /** Globs of the UI blocks (the config's functions-small-ui), to tell a function's limit. */
  ui: readonly string[]
  isVendored: (path: string) => boolean
  isUi: (path: string) => boolean
  now?: Date
}

const LANGUAGES: [RegExp, string][] = [
  [/\.(?:[cm]?ts|tsx)$/, 'TypeScript'],
  [/\.(?:[cm]?js|jsx)$/, 'JavaScript'],
  [/\.kts?$/, 'Kotlin'],
  [/\.go$/, 'Go'],
]

export const BANDS: { label: string; from: number; to: number }[] = [
  { label: '1–4', from: 1, to: 4 },
  { label: '5–9', from: 5, to: 9 },
  { label: '10–19', from: 10, to: 19 },
  { label: '20–49', from: 20, to: 49 },
  { label: '50+', from: 50, to: Infinity },
]

const TOP = 10

/** What the first analysis found, for the report. */
export function firstLook(input: FirstLookInput): FirstLook {
  const { graph } = input
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
  const files = graph.nodes.filter(n => n.kind === 'file')
  const production = files.filter(isCode)
  const tests = files.filter(f => f.tags?.includes('test'))
  const productionIds = new Set(production.map(f => f.id))
  const functions = graph.nodes.filter(n => isFunction(n) && productionIds.has(`f:${n.path}`) && n.metrics?.complexity !== undefined)
  const shape = shapeOf(graph)
  const layerNames = graph.meta.layers ?? []
  const blockInfo = (b: Block) => ({ path: b.path, files: b.files, loc: b.loc, ui: b.ui })
  const layerOfBlock = (b: Block) =>
    production
      .find(f => shape.blockOf(f.path!) === b.path)
      ?.tags?.find(t => t.startsWith('layer:'))
      ?.slice(6)
  const h = graph.meta.history
  const dead = graph.nodes.filter(n => n.tags?.includes('dead-export'))
  const deadBy = new Map<string, number>()
  for (const n of dead) {
    const folder = (n.path ?? '').split('/').slice(0, -1).join('/') || '.'
    deadBy.set(folder, (deadBy.get(folder) ?? 0) + 1)
  }
  const violations = graph.meta.violations ?? []
  const index = new GraphIndex(graph)
  const code = codeGraph(graph, production, shape.blockOf, index)
  const bridges = bridgesOf(code, input.isVendored)
  const mixed = input.coherence.concerns.filter(c => c.kind === 'mixed' && !c.concern.accepted)
  const one = input.coherence.concerns.filter(c => c.kind === 'one')

  return {
    project: graph.meta.name,
    root: input.root,
    generatedAt: (input.now ?? new Date()).toISOString(),
    stack: input.stack,
    notes: input.notes,
    size: {
      files: production.length,
      loc: production.reduce((s, f) => s + (f.metrics?.loc ?? 0), 0),
      tests: tests.length,
      functions: functions.length,
      languages: LANGUAGES.map(([re, name]) => ({ name, files: production.filter(f => re.test(f.path!)).length })).filter(l => l.files > 0),
    },
    ...(h ? { history: { commits: h.commits, authors: h.authors, since: day(h.since), until: day(h.until) } } : {}),
    config: input.config,
    excluded: input.excluded,
    vendored: input.vendored,
    layers: layerNames.map(name => ({ name, blocks: shape.blocks.filter(b => layerOfBlock(b) === name).map(blockInfo) })),
    blocks: shape.blocks.filter(b => !layerOfBlock(b)).map(blockInfo),
    cycles: { count: graph.meta.cycles.length, largest: graph.meta.cycles.slice(0, 3).map(c => c.map(id => id.replace(/^f:/, ''))) },
    hotspots: production
      .filter(f => (f.metrics?.hotspot ?? 0) > 0)
      .sort((a, b) => b.metrics!.hotspot! - a.metrics!.hotspot! || cmp(a.path!, b.path!))
      .slice(0, TOP)
      .map(f => ({ path: f.path!, score: f.metrics!.hotspot!, commits: f.metrics?.commits ?? 0, churn: f.metrics?.churn ?? 0, complexity: f.metrics?.complexity ?? 0, loc: f.metrics?.loc ?? 0 })),
    bridges,
    questions: questionsOf({ graph, code, bridges, isVendored: input.isVendored, index }),
    coherence: {
      mixed: mixed.map(c => ({ label: `${c.concern.stack} · ${c.concern.label}`, ways: c.paradigms.map(p => ({ label: p.label, files: p.files.length })), blocks: c.blocks.filter(b => b.paradigms.length > 1).map(b => b.block) })),
      one: one.map(c => ({ label: `${c.concern.stack} · ${c.concern.label}`, way: c.main.label, files: c.users })),
    },
    functions: {
      bands: BANDS.map(b => ({ label: b.label, count: functions.filter(f => f.metrics!.complexity! >= b.from && f.metrics!.complexity! <= b.to).length })),
      largest: functions
        .filter(f => !input.isVendored(f.path!))
        .sort((a, b) => b.metrics!.complexity! - a.metrics!.complexity! || cmp(a.id, b.id))
        .slice(0, TOP)
        .map(f => ({ name: memberName(f, graph), path: f.path!, line: f.range?.[0] ?? 0, complexity: f.metrics!.complexity!, ui: input.isUi(f.path!) })),
    },
    deadExports: {
      count: dead.length,
      folders: [...deadBy]
        .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
        .slice(0, 6)
        .map(([folder, count]) => ({ folder, count, vendored: input.isVendored(`${folder}/x`) })),
    },
    rules: (graph.meta.rules ?? []).map(r => ({ name: r.name, severity: r.severity, broken: violations.filter(v => v.rule === r.name).length, description: r.description })),
  }
}

/** `Class.method` for a member, the name for a symbol. */
function memberName(n: GraphNode, graph: Graph): string {
  if (n.kind !== 'member' || !n.parent) return n.name
  const owner = graph.nodes.find(p => p.id === n.parent)
  return owner ? `${owner.name}.${n.name}` : n.name
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
