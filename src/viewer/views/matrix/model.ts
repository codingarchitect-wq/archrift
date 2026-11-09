// The Matrix view's model, pure and deterministic: the rows (visible files, or
// folders when there are too many), their order (layer, then folder; the
// group first when one is chosen), the cells that light up and why, and where
// everything sits on the wall. Cell (row, col) is lit when the row depends on
// the column, so dependencies that follow the layering sit right of the
// diagonal and the ones pointing up (against it) left of it.
import { dirId } from '../../../core/ids.ts'
import type { GraphNode } from '../../../core/model.ts'
import type { Violation } from '../../../core/rules.ts'
import type { Box, Layout } from '../../layouts/types.ts'
import { emptyLayout } from '../../layouts/types.ts'

/** A cell's side in world units. */
export const CELL = 10
/** Above this many visible files, rows and columns are folders … */
export const AGGREGATE_ABOVE = 1500
/** … at the deepest level that keeps them at most this many. */
export const MAX_FOLDERS = 400
/** Header text, in characters. */
export const HEADER_CHARS = 26

/** Why a cell is lit, in drawing priority (the highest wins). */
export const KIND = { uses: 0, up: 1, cycle: 2, warning: 3, violation: 4 } as const
export type CellKind = (typeof KIND)[keyof typeof KIND]

export interface Unit {
  /** Its box: the file, the folder (aggregated) or the package. */
  id: string
  kind: 'file' | 'folder' | 'external'
  /** Header text (at most HEADER_CHARS). */
  name: string
  /** Repo-relative path; a package's name. */
  path: string
  /** Index in the layer order; undefined when in no layer. */
  layer?: number
  /** Index of its group when grouping. */
  group?: number
  /** The files it stands for (itself for a file or package). */
  files: string[]
  /** 0–1: how much it changed recently (or how much is used, without history), by rank. */
  activity: number
}

export interface Cell {
  row: number
  col: number
  /** Summed reference count. */
  weight: number
  /** What it shows (the highest reason). */
  kind: CellKind
  /** The target sits in a layer above the source's. */
  up: boolean
  /** Both ends in one import cycle. */
  cycle: boolean
  /** Names of the rules it breaks. */
  rules?: string[]
}

export interface Block {
  start: number
  /** Exclusive. */
  end: number
  label: string
}

export interface MatrixModel {
  units: Unit[]
  /** Unit id → row (= column). */
  index: Map<string, number>
  /** A visible file's or package's row (its folder's when aggregated). */
  rowOf(id: string): number | undefined
  /** Sorted by row, then column. */
  cells: Cell[]
  /** row * n + col → index in cells. */
  cellAt: Map<number, number>
  /** Per row: the columns it depends on, and the rows depending on it. */
  uses: number[][]
  usedBy: number[][]
  /** Aggregated: references between files of the same folder. */
  inside: number[]
  maxWeight: number
  /** Runs of rows in one layer (or group) along the diagonal. */
  blocks: Block[]
  /** Folder depth rows were aggregated to; null for files. */
  depth: number | null
  /** What the rain follows. */
  metric: 'churn' | 'commits' | 'fanIn'
  /** Cells by reason (independently: a cell pointing up in a cycle counts twice). */
  counts: { up: number; cycle: number; warning: number; violation: number }
}

export interface MatrixInput {
  /** The visible files and packages. */
  nodes: readonly GraphNode[]
  /** source → target → reference count (the filtered file graph). */
  weight: ReadonlyMap<string, ReadonlyMap<string, number>>
  layers: { order: readonly string[]; layerOf: (n: GraphNode) => string | undefined; labels?: ReadonlyMap<string, string> }
  grouping?: { groups: readonly { id: string; label: string }[]; groupOf: (fileId: string) => string | undefined } | null
  cycles?: readonly (readonly string[])[]
  violations?: readonly Pick<Violation, 'rule' | 'severity' | 'from' | 'to' | 'path' | 'targets'>[]
  /** The build target shown: violations elsewhere don't count. */
  target?: string
  aggregateAbove?: number
  maxFolders?: number
  /** The name written for a file or folder (`archrift describe`, described names on), shown in place of its own. */
  nameOf?: (id: string) => string | undefined
}

export function matrixModel(input: MatrixInput): MatrixModel {
  const files = input.nodes.filter(n => n.kind === 'file')
  const externals = input.nodes.filter(n => n.kind === 'external')
  const layerIndex = new Map(input.layers.order.map((l, i) => [l, i]))
  const groupIndex = new Map((input.grouping?.groups ?? []).map((g, i) => [g.id, i]))
  const metric = pickMetric(files)
  const dirs = new Map(files.map(f => [f.id, parentPath(f.path ?? f.name)]))
  const depth = files.length > (input.aggregateAbove ?? AGGREGATE_ABOVE) ? folderDepth([...dirs.values()], input.maxFolders ?? MAX_FOLDERS) : null

  // units: files (or their folders), then packages
  const units: Unit[] = []
  const unitOf = new Map<string, Unit>()
  const members = new Map<string, GraphNode[]>()
  for (const f of files) {
    const folder = depth === null ? undefined : truncatePath(dirs.get(f.id)!, depth)
    const id = folder === undefined ? f.id : dirId(folder)
    let unit = unitOf.get(id)
    if (!unit) {
      unit = {
        id,
        kind: folder === undefined ? 'file' : 'folder',
        name: folder === undefined ? fileText(f.name) : folderText(folder),
        path: folder ?? f.path ?? f.name,
        files: [],
        activity: 0,
      }
      unitOf.set(id, unit)
      members.set(id, [])
      units.push(unit)
    }
    unit.files.push(f.id)
    members.get(id)!.push(f)
    if (id !== f.id) unitOf.set(f.id, unit)
  }
  for (const u of units) {
    const list = members.get(u.id)!
    u.layer = majority(list.map(f => layerIndex.get(input.layers.layerOf(f) ?? '')))
    if (input.grouping) u.group = majority(list.map(f => groupIndex.get(input.grouping!.groupOf(f.id) ?? '')))
  }
  for (const x of externals) {
    const unit: Unit = { id: x.id, kind: 'external', name: fileText(x.name), path: x.name, files: [x.id], activity: 0 }
    unitOf.set(x.id, unit)
    units.push(unit)
  }

  // how much each changed (or is used): summed over a folder's files, then ranked
  const raw = units.map(u => (u.kind === 'external' ? 0 : members.get(u.id)!.reduce((a, f) => a + (f.metrics?.[metric] ?? 0), 0)))
  const ranked = rank(raw)
  units.forEach((u, i) => (u.activity = ranked[i]))

  units.sort(compareUnits)
  disambiguate(units)
  for (const u of units) {
    const name = u.kind === 'external' ? undefined : input.nameOf?.(u.id)
    if (name) u.name = clip(name, HEADER_CHARS)
  }
  const index = new Map(units.map((u, i) => [u.id, i]))
  const rowOf = (id: string) => {
    const u = unitOf.get(id)
    return u ? index.get(u.id) : undefined
  }

  // cells, with why they matter
  const n = units.length
  const cycleOf = new Map<string, number>()
  input.cycles?.forEach((c, i) => c.forEach(id => cycleOf.set(id, i)))
  const broken = new Map<string, { error: boolean; rules: Set<string> }>()
  for (const v of input.violations ?? []) {
    if (input.target !== undefined && !v.targets.includes(input.target)) continue
    const on = v.path ?? [v.from, v.to]
    for (let i = 1; i < on.length; i++) {
      const key = `${on[i - 1]}\u0000${on[i]}`
      const b = broken.get(key) ?? { error: false, rules: new Set<string>() }
      b.error ||= v.severity === 'error'
      b.rules.add(v.rule)
      broken.set(key, b)
    }
  }
  const inside = new Array<number>(n).fill(0)
  const byKey = new Map<number, Cell & { error?: boolean; ruleSet?: Set<string> }>()
  for (const [source, targets] of input.weight) {
    const row = rowOf(source)
    if (row === undefined) continue
    for (const [target, weight] of targets) {
      const col = rowOf(target)
      if (col === undefined) continue
      if (row === col) {
        inside[row] += weight
        continue
      }
      const key = row * n + col
      let cell = byKey.get(key)
      if (!cell) {
        const a = units[row].layer
        const b = units[col].layer
        cell = { row, col, weight: 0, kind: KIND.uses, up: a !== undefined && b !== undefined && b < a, cycle: false }
        byKey.set(key, cell)
      }
      cell.weight += weight
      const cycle = cycleOf.get(source)
      if (cycle !== undefined && cycleOf.get(target) === cycle) cell.cycle = true
      const b = broken.get(`${source}\u0000${target}`)
      if (b) {
        cell.error ||= b.error
        cell.ruleSet ??= new Set()
        b.rules.forEach(r => cell!.ruleSet!.add(r))
      }
    }
  }
  const counts = { up: 0, cycle: 0, warning: 0, violation: 0 }
  const cells: Cell[] = [...byKey.values()]
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map(c => {
      const kind: CellKind = c.ruleSet ? (c.error ? KIND.violation : KIND.warning) : c.cycle ? KIND.cycle : c.up ? KIND.up : KIND.uses
      if (c.up) counts.up++
      if (c.cycle) counts.cycle++
      if (c.ruleSet) counts[c.error ? 'violation' : 'warning']++
      const cell: Cell = { row: c.row, col: c.col, weight: c.weight, kind, up: c.up, cycle: c.cycle }
      if (c.ruleSet) cell.rules = [...c.ruleSet].sort()
      return cell
    })
  const cellAt = new Map(cells.map((c, i) => [c.row * n + c.col, i]))
  const uses: number[][] = units.map(() => [])
  const usedBy: number[][] = units.map(() => [])
  for (const c of cells) {
    uses[c.row].push(c.col)
    usedBy[c.col].push(c.row)
  }

  return {
    units,
    index,
    rowOf,
    cells,
    cellAt,
    uses,
    usedBy,
    inside,
    maxWeight: cells.reduce((m, c) => Math.max(m, c.weight), 0),
    blocks: blocksOf(units, input),
    depth,
    metric,
    counts,
  }
}

/** Packages last; then group, layer (none last), folder (segment by segment), name. */
function compareUnits(a: Unit, b: Unit) {
  return (
    Number(a.kind === 'external') - Number(b.kind === 'external') ||
    order(a.group) - order(b.group) ||
    order(a.layer) - order(b.layer) ||
    comparePaths(folderOf(a), folderOf(b)) ||
    cmp(a.path, b.path) ||
    cmp(a.id, b.id)
  )
}

const order = (i: number | undefined) => (i === undefined ? Infinity : i)
const folderOf = (u: Unit) => (u.kind === 'folder' ? u.path : u.kind === 'file' ? parentPath(u.path) : '')

/** Tree order: `src` before `src/lib` before `src-x`. */
export function comparePaths(a: string, b: string) {
  if (a === b) return 0
  const x = a ? a.split('/') : []
  const y = b ? b.split('/') : []
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return cmp(x[i], y[i])
  return x.length - y.length
}

/** Runs of rows in one group (when grouping) or layer; packages are a block of their own. */
function blocksOf(units: Unit[], input: MatrixInput): Block[] {
  const keyOf = (u: Unit) => (u.kind === 'external' ? 'x' : input.grouping ? `g${u.group ?? '-'}` : `l${u.layer ?? '-'}`)
  const labelOf = (u: Unit) => {
    if (u.kind === 'external') return 'packages'
    if (input.grouping) return u.group === undefined ? 'ungrouped' : input.grouping.groups[u.group].label
    if (u.layer === undefined) return 'no layer'
    const name = input.layers.order[u.layer]
    return input.layers.labels?.get(name) ?? name
  }
  const blocks: Block[] = []
  units.forEach((u, i) => {
    const last = blocks.at(-1)
    if (last && keyOf(units[last.start]) === keyOf(u)) last.end = i + 1
    else blocks.push({ start: i, end: i + 1, label: clip(labelOf(u), 34) })
  })
  return blocks
}

/** What the rain follows: recent churn, else commits, else fan-in (no history). */
function pickMetric(files: readonly GraphNode[]): MatrixModel['metric'] {
  if (files.some(f => (f.metrics?.churn ?? 0) > 0)) return 'churn'
  if (files.some(f => (f.metrics?.commits ?? 0) > 0)) return 'commits'
  return 'fanIn'
}

/** The deepest folder level at which the files' folders number at most `max` (0 = the root). */
export function folderDepth(dirs: readonly string[], max: number) {
  const deepest = dirs.reduce((d, p) => Math.max(d, p ? p.split('/').length : 0), 0)
  for (let depth = deepest; depth >= 1; depth--) {
    const seen = new Set<string>()
    for (const p of dirs) {
      seen.add(truncatePath(p, depth))
      if (seen.size > max) break
    }
    if (seen.size <= max) return depth
  }
  return 0
}

/** The first `depth` segments of a folder path. */
export function truncatePath(path: string, depth: number) {
  if (!path || depth <= 0) return ''
  const parts = path.split('/')
  return parts.length <= depth ? path : parts.slice(0, depth).join('/')
}

export const parentPath = (path: string) => {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** 0–1 by rank (ties share the lowest); zero stays zero. */
export function rank(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const n = values.length
  return values.map(v => {
    if (v <= 0 || n < 2) return v > 0 ? 1 : 0
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] < v) lo = mid + 1
      else hi = mid
    }
    return (lo + 1) / n
  })
}

/** The most common value (ties: the smallest); undefined only when all are. */
function majority(values: (number | undefined)[]): number | undefined {
  const counts = new Map<number, number>()
  for (const v of values) if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: number | undefined
  for (const [v, c] of counts) if (best === undefined || c > counts.get(best)! || (c === counts.get(best)! && v < best)) best = v
  return best
}

/** Files of the same name (page.tsx, index.ts) get as much of their path as tells them apart. */
function disambiguate(units: Unit[]) {
  const byName = new Map<string, Unit[]>()
  for (const u of units) if (u.kind === 'file') byName.set(u.name, [...(byName.get(u.name) ?? []), u])
  for (const same of byName.values()) {
    if (same.length < 2) continue
    const parts = same.map(u => u.path.split('/'))
    const longest = Math.max(...parts.map(p => p.length))
    for (let k = 2; k <= longest; k++) {
      const tails = parts.map(p => p.slice(-k).join('/'))
      if (new Set(tails).size === tails.length || k === longest) {
        same.forEach((u, i) => (u.name = tails[i].length <= HEADER_CHARS ? tails[i] : `…${tails[i].slice(-(HEADER_CHARS - 1))}`))
        break
      }
    }
  }
}

/** A file name that fits: its start and its extension. */
export function fileText(name: string) {
  if (name.length <= HEADER_CHARS) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : ''
  return `${name.slice(0, HEADER_CHARS - 1 - ext.length)}…${ext}`
}

/** A folder path that fits: its end. */
export function folderText(path: string) {
  const text = path || '(root)'
  return text.length <= HEADER_CHARS ? text : `…${text.slice(-(HEADER_CHARS - 1))}`
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// ── the wall ──────────────────────────────────────────────────────────────

/**
 * Where things sit, in world units. The matrix spans x 0…side (columns) and
 * y 0…side (row 0 at the top) in the plane z = 0, facing +z; row headers are
 * left of it, column headers above.
 */
export interface Wall {
  n: number
  side: number
  pad: number
  /** Row strips (the file boxes) and column ticks. */
  strip: number
  glyphW: number
  glyphH: number
  /** Right edge of the row names; bottom of the column names; the longest name. */
  rowTextRight: number
  colTextBottom: number
  textLength: number
  /** Where the block (layer) labels stand, and the column labels' first tier. */
  blockLabelX: number
  colLabelY: number
  tierGap: number
  /** The wall, headers included (not the block labels left of it, which are screen-sized). */
  left: number
  right: number
  bottom: number
  top: number
}

/** The wall for n rows whose longest name has `chars` characters. */
export function wallOf(n: number, chars = HEADER_CHARS): Wall {
  const side = Math.max(n, 1) * CELL
  const pad = Math.max(CELL * 0.6, side * 0.006)
  const strip = Math.max(CELL * 2, side * 0.022)
  const glyphH = CELL * 0.8
  const glyphW = glyphH * 0.62
  const textLength = Math.max(chars, 4) * glyphW
  const rowTextRight = -2 * pad - strip
  const colTextBottom = side + 2 * pad + strip
  const blockLabelX = rowTextRight - textLength - pad
  // column labels stand over the column names: those can't be read while the labels show (see matrix.css)
  const colLabelY = colTextBottom + pad
  // about 25px apart at the home view, which shows the wall's height about 1.5 times over 880px
  const tierGap = (colTextBottom + textLength) * 0.04
  return {
    n,
    side,
    pad,
    strip,
    glyphW,
    glyphH,
    rowTextRight,
    colTextBottom,
    textLength,
    blockLabelX,
    colLabelY,
    tierGap,
    left: blockLabelX,
    right: side + pad,
    bottom: -pad,
    top: Math.max(colTextBottom + textLength, colLabelY + tierGap * COLUMN_TIERS),
  }
}

export const wallFor = (m: MatrixModel) => wallOf(m.units.length, m.units.reduce((a, u) => Math.max(a, u.name.length), 0))

/** Center of a row (y) or column (x). */
export const rowY = (w: Wall, row: number) => w.side - (row + 0.5) * CELL
export const colX = (col: number) => (col + 0.5) * CELL

export const COLUMN_TIERS = 3
/** Where a column's label stands (a cluster box: not drawn, only labelled). */
export const columnAnchorId = (unit: string) => `matrix-col:${unit}`
export const blockAnchorId = (i: number) => `matrix-block:${i}`
/** A row's cell on the diagonal, where its row and column cross. */
export const crossingAnchorId = (unit: string) => `matrix-crossing:${unit}`

/**
 * Boxes: per row a sliver at the left edge of its strip (the node itself, which
 * the decoration's strip covers: its labels then stand left of the strip), and
 * label anchors for columns and blocks.
 */
export function matrixLayout(model: MatrixModel, view: string): Layout {
  const w = wallFor(model)
  const height = w.top - w.bottom
  // the home view sees the wall between the toolbar (top 18% of the window: it wraps) and the
  // legends (bottom 13%); the camera's vertical field of view is 50°
  const seen = height / 0.69
  const distance = seen / (2 * Math.tan((25 * Math.PI) / 180))
  // flying to a row goes 0.24 sizes close: that should still show 40 rows around it, or most of a small matrix
  const size = Math.max(distance / 1.22, Math.min(height * 0.75, CELL * 40) / 0.224)
  const out: Layout = {
    ...emptyLayout(),
    view,
    size,
    shape: 'box',
    arcAnchor: 'center',
    ground: false,
    arcs: 'none',
    openFile: 'none',
    // the right edge at 70% of a 16:10 window's width: the inspector covers little of it
    center: [w.right - seen * 0.32, w.top - seen * 0.32, 0],
    home: [0, 0, distance / size],
    names: new Map(),
  }
  const sliver = w.strip * 0.15
  model.units.forEach((u, row) => {
    const box: Box = { x: -w.pad - w.strip + sliver / 2, y: rowY(w, row) - CELL * 0.4, z: 0, w: sliver, h: CELL * 0.8, d: CELL * 0.6 }
    out.boxes.set(u.id, box)
    out.placement.set(u.id, u.kind === 'external' ? 'external' : 'building')
    const anchor = columnAnchorId(u.id)
    out.boxes.set(anchor, { x: colX(row), y: w.colLabelY + (row % COLUMN_TIERS) * w.tierGap, z: 0, w: CELL, h: 0.01, d: 0.01 })
    out.placement.set(anchor, 'cluster')
    const crossing = crossingAnchorId(u.id)
    out.boxes.set(crossing, { x: colX(row), y: rowY(w, row), z: 0, w: CELL, h: 0.01, d: 0.01 })
    out.placement.set(crossing, 'cluster')
  })
  model.blocks.forEach((b, i) => {
    const id = blockAnchorId(i)
    const y = w.side - ((b.start + b.end) / 2) * CELL
    out.boxes.set(id, { x: w.blockLabelX, y, z: 0, w: CELL, h: 0.01, d: 0.01 })
    out.placement.set(id, 'cluster')
    out.names!.set(id, b.label)
  })
  return out
}
