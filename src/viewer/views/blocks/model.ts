// §5 Building Block View, part 1: the building blocks. Level 1 is the
// system's white box: the top-level blocks (arc42-kit/blocks.ts: folders, or
// the toolbar's groups) as black boxes, with the file dependencies between
// them lifted to block pairs and each block's provided interface (its files
// that code outside uses). The selection opens white boxes down its folder
// chain, at most two: a block's subfolders (a group's: the folders its files
// are in, below the one they share), and its own files (each one while there
// are few, else grouped into the modules their dependencies form), with the
// neighbors it talks to as stubs at the edge. Pure and deterministic: no
// scene, no store.
import { louvain } from '../../../core/algorithms.ts'
import { fileIdOf } from '../../../core/ids.ts'
import type { GraphNode } from '../../../core/model.ts'
import type { World } from '../../world.ts'
import { layerOfBlock, levelOneBlocks } from '../arc42-kit/blocks.ts'
import type { BlockGrouping, TopBlocks } from '../arc42-kit/blocks.ts'

export type UnitKind = 'folder' | 'files' | 'file' | 'group'

/** A building block on one level's board. */
export interface Unit {
  /** Its box id: the node it stands for (a folder, a file), or `blocks:group:…` for a group of files. */
  id: string
  /** What clicking it selects: the folder or file; a group's most used file. */
  select: string
  /** The folder whose files it holds (folders, a folder's own files), for picking it out of a selection. */
  dir?: string
  /** A group's: the folder its files share, where its white box opens (a folder's is its own). */
  home?: string
  name: string
  /** Under the name: what it is when the name doesn't say ("own files", "+12 files"). */
  note?: string
  kind: UnitKind
  files: string[]
  loc: number
  /** Index of its architecture layer (layer order), undefined without one. */
  layer?: number
  /** Level 1 by groups that cut across the layers (features): its tier instead of its layer (features 0, shared code 1; the rest none, in a last row); a dependency up the tiers points up. */
  tier?: number
  /** Its files that code outside it uses: its provided interface. */
  provided: number
  /** It opens into a white box one level down when selected. */
  opens: boolean
}

/** A dependency between two units of a board (or a unit and a stub). */
export interface Link {
  from: number
  to: number
  /** Summed references. */
  weight: number
  /** File pairs it stands for. */
  pairs: number
  /** Against the layer order: a lower layer uses a higher one. */
  up: boolean
  /** One of the file dependencies it stands for breaks an architecture rule. */
  violates?: boolean
}

/** A neighbor a white box talks to, at the board's edge: users above, what it uses below. */
export interface Stub {
  /** Its box id (the neighbor's node id, marked as a stub of this level). */
  id: string
  select: string
  name: string
  layer?: number
  side: 'top' | 'bottom'
}

export interface Level {
  /** 1 for the system's white box, 2 and 3 for the blocks opened. */
  depth: number
  /** The folder (or block) this level is the white box of. */
  container: string
  title: string
  units: Unit[]
  links: Link[]
  /** White boxes only: neighbors at the edge; their links index them after the units (units.length + i). */
  stubs: Stub[]
  /** Neighbors left out (beyond the most strongly linked ones). */
  moreStubs: number
  /** Index (in the previous level's units) of the block this level opens; undefined on level 1. */
  opened?: number
  /** A shown file → the unit holding it. */
  unitOf: ReadonlyMap<string, number>
}

export interface BlocksModel {
  levels: Level[]
  /** The system: its name and folder. */
  system: { name: string; dir: string }
  /** Layer names in order (colors by index). */
  layers: readonly string[]
  /** Files whose dependencies were counted. */
  files: number
}

export interface BlocksInput {
  world: World
  /** Files (and packages) the filters let through. */
  visible: ReadonlySet<string>
  /** File-level dependencies with summed references (the viewer's DepGraph). */
  weight: ReadonlyMap<string, ReadonlyMap<string, number>>
  /** Who uses each file: a group of files is named after its most used one. */
  incoming: ReadonlyMap<string, readonly string[]>
  layers: { order: readonly string[]; layerOf: (n: GraphNode) => string | undefined }
  /** The toolbar's grouping: level 1 holds its groups instead of folders. */
  grouping?: BlockGrouping | null
  /** The level-1 block open before: a folder selected in its white box keeps it open (a folder may hold files of several groups). */
  previous?: string
  /** What the groups are (`detected module`), for level 1's title; none by folder. */
  by?: string
  /** Groups that cut across the layers (features): a level-1 block's row, in place of its layer's. */
  tierOf?: (blockId: string) => number | undefined
  /** A file dependency breaks an architecture rule (in the target shown). */
  violating?: (from: string, to: string) => boolean
  selected: string | null
}

/** Loose files of a folder shown one by one up to this many; beyond, grouped. */
export const MAX_LOOSE = 12
/** When grouping finds no structure, files are still shown one by one up to this many. */
export const MAX_SINGLES = 30
/** At most this many groups of loose files (the rest go into one). */
const MAX_GROUPS = 8
/** Stubs per side of a white box. */
const MAX_STUBS = 6
/** Levels shown: the system and two white boxes. */
export const MAX_DEPTH = 3

export function buildModel(input: BlocksInput): BlocksModel {
  const { world } = input
  const shown = (n: GraphNode) => input.visible.has(n.id)
  const top = levelOneBlocks(world, shown, input.grouping ?? null)
  const layerIndex = new Map(input.layers.order.map((l, i) => [l, i]))
  const layerOf = (files: string[]) => {
    const l = layerOfBlock({ files }, world, input.layers.layerOf, input.layers.order)
    return l === undefined ? undefined : layerIndex.get(l)
  }
  const system = world.node(top.system)
  const systemName = top.system === world.rootId ? (world.graph.meta.name || system?.name || 'system') : system?.path || system?.name || top.system

  // level 1: the top-level blocks
  const level1Units: Unit[] = top.blocks.map(b => {
    if (b.group)
      return { id: b.id, select: b.id, home: b.home, name: b.name, kind: 'group', files: b.files, loc: b.loc, layer: layerOf(b.files), tier: input.tierOf?.(b.id), provided: 0, opens: b.files.length > 0 }
    const node = world.node(b.id)
    const dirName = node?.name ?? b.name
    return {
      id: b.id,
      select: b.id,
      dir: b.id,
      name: b.loose ? `${b.id === world.rootId ? world.graph.meta.name || dirName : dirName}/` : b.name,
      note: b.loose ? 'own files' : undefined,
      kind: b.loose ? 'files' : 'folder',
      files: b.files,
      loc: b.loc,
      layer: layerOf(b.files),
      provided: 0,
      opens: b.files.length > 0,
    }
  })
  const level1Of = new Map<string, number>()
  level1Units.forEach((u, i) => u.files.forEach(f => level1Of.set(f, i)))
  const levels: Level[] = [
    { depth: 1, container: top.system, title: `Level 1 · ${world.graph.meta.name || systemName}${input.by ? ` · by ${input.by}` : ''}`, units: level1Units, links: [], stubs: [], moreStubs: 0, unitOf: level1Of },
  ]
  const unitOfs: Map<string, number>[] = [level1Of]
  levels[0].links = linksOf(input, level1Units, level1Of, levels[0].units.length, () => undefined).links

  // the white boxes along the selection's chain
  const sel = input.selected
  for (let depth = 2; depth <= MAX_DEPTH && sel; depth++) {
    const parent = levels[depth - 2]
    const at = unitHolding(world, parent.units, unitOfs[depth - 2], sel) ?? (depth === 2 ? groupHolding(world, top, sel, input.previous) : undefined)
    if (at === undefined) break
    const opened = parent.units[at]
    // a block opens when it, or something inside it, is selected; inside a white box, only a folder that is itself on the way
    if (!opened.opens || (depth > 2 && !isWithin(world, sel, opened))) break
    const content = contentOf(input, opened, layerOf)
    const unitOf = new Map<string, number>()
    content.forEach((u, i) => u.files.forEach(f => unitOf.set(f, i)))
    // a file outside the opened block: the unit holding it on the deepest board above that has one other than the opened block
    const outside = (file: string): { level: number; unit: number } | undefined => {
      for (let k = depth - 2; k >= 0; k--) {
        const u = unitOfs[k].get(file)
        if (u === undefined) continue
        if (k === depth - 2 && u === at) return undefined // inside the opened block
        return { level: k, unit: u }
      }
      return undefined
    }
    const { links, stubs, moreStubs } = linksOf(input, content, unitOf, content.length, outside, levels, depth)
    const name = opened.kind === 'files' ? `${opened.name} own files` : opened.name
    levels.push({ depth, container: opened.id, title: `Level ${depth} · ${name}`, units: content, links, stubs, moreStubs, opened: at, unitOf })
    unitOfs.push(unitOf)
  }
  return { levels, system: { name: systemName, dir: top.system }, layers: input.layers.order, files: level1Of.size }
}

/**
 * Per level, the unit to put first: the block opened below it, and on the
 * deepest level the one holding the selection (undefined where none does).
 * Cheap, so it follows the selection without rebuilding the model.
 */
export function focusOf(levels: readonly Level[], world: World, sel: string | null): (number | undefined)[] {
  return levels.map((l, k) => {
    const next = levels[k + 1]
    if (next) return next.opened
    return sel ? unitHolding(world, l.units, l.unitOf, sel) : undefined
  })
}

/**
 * Which white boxes a selection opens, as a key: the level-1 block holding
 * it, and the folder below that block's on its way (the second white box).
 * Cheap enough for every update, so the layout changes only when they do.
 */
export function chainKey(world: World, top: TopBlocks, sel: string | null, previous?: string): string {
  if (!sel) return ''
  const file = fileIdOf(sel)
  const way = world.index.ancestors(file ?? sel).map(d => d.id)
  // as unitHolding: a file's block, a block by its own id, the folder block a folder lies in (grouped: groupHolding)
  const own = file ? top.blocks.findIndex(b => b.id === top.blockOf.get(file)) : top.blocks.findIndex(b => b.id === sel)
  const at =
    own >= 0 || file ? own : top.blocks.some(b => b.group) ? (groupHolding(world, top, sel, previous) ?? -1) : top.blocks.findIndex(b => !b.loose && way.includes(b.id))
  if (at < 0) return ''
  const block = top.blocks[at]
  // a folder inside the block, the one right below the block's home on the way
  const chain = sel.startsWith('d:') ? [sel, ...way] : way
  const k = chain.indexOf(block.home)
  const below = k > 0 ? chain[k - 1] : undefined
  return `${block.id}|${below?.startsWith('d:') ? below : ''}`
}

/**
 * With groups on level 1, the group a selected folder opens (by its index):
 * the one open before while it has files there (a folder may hold files of
 * several groups: a folder picked in a group's white box keeps that group),
 * else the one with the most files there. Undefined by folder, or when no
 * group has files there.
 */
function groupHolding(world: World, top: TopBlocks, sel: string, previous: string | undefined): number | undefined {
  if (!sel.startsWith('d:') || !top.blocks.some(b => b.group)) return undefined
  const path = world.node(sel)?.path ?? ''
  const inside = (f: string) => !path || (world.node(f)?.path ?? '').startsWith(`${path}/`)
  const counts = top.blocks.map(b => b.files.filter(inside).length)
  const before = top.blocks.findIndex(b => b.id === previous)
  if (before >= 0 && counts[before] > 0) return before
  let best = -1
  counts.forEach((n, i) => {
    if (n > 0 && (best < 0 || n > counts[best])) best = i
  })
  return best >= 0 ? best : undefined
}

/** The unit of a board that holds a selection: a file's (a symbol's file's) unit, or the folder unit at or above a folder. */
function unitHolding(world: World, units: readonly Unit[], unitOf: ReadonlyMap<string, number>, sel: string): number | undefined {
  const file = fileIdOf(sel)
  if (file) return unitOf.get(file)
  if (!sel.startsWith('d:')) {
    // a group (module:…, layer:…) by its own id
    const own = units.findIndex(u => u.id === sel)
    return own >= 0 ? own : undefined
  }
  const exact = units.findIndex(u => u.dir === sel)
  if (exact >= 0) return exact
  for (const d of world.index.ancestors(sel)) {
    const i = units.findIndex(u => u.kind === 'folder' && u.dir === d.id)
    if (i >= 0) return i
  }
  return undefined
}

/** Whether a selection is the unit's folder or inside it (a file of a group or one file isn't "inside"). */
function isWithin(world: World, sel: string, unit: Unit) {
  if (unit.kind !== 'folder' && unit.kind !== 'files') return false
  if (sel === unit.dir) return true
  if (unit.kind === 'files') return false
  const file = fileIdOf(sel)
  return world.index.ancestors(file ?? sel).some(d => d.id === unit.dir)
}

/** What a block holds, one level down: its subfolders, and its own files one by one or grouped. */
function contentOf(input: BlocksInput, block: Unit, layerOf: (files: string[]) => number | undefined): Unit[] {
  const { world } = input
  const dir = block.home ?? block.dir!
  const sub = new Map<string, string[]>()
  const loose: string[] = []
  for (const f of block.files) {
    const node = world.node(f)
    if (!node) continue
    if (node.parent === dir || block.kind === 'files') {
      loose.push(f)
      continue
    }
    // the folder right below the block's on the file's way up
    const way = world.index.ancestors(f)
    const i = way.findIndex(d => d.parent === dir)
    if (i < 0) loose.push(f)
    else push(sub, way[i].id, f)
  }
  const loc = (files: string[]) => files.reduce((n, f) => n + (world.node(f)?.metrics?.loc ?? 0), 0)
  const units: Unit[] = [...sub].map(([id, files]) => ({
    id,
    select: id,
    dir: id,
    name: world.node(id)?.name ?? id,
    kind: 'folder' as const,
    files,
    loc: loc(files),
    layer: layerOf(files),
    provided: 0,
    opens: true,
  }))
  const one = (f: string): Unit => ({ id: f, select: f, name: world.node(f)?.name ?? f, kind: 'file', files: [f], loc: loc([f]), layer: layerOf([f]), provided: 0, opens: false })
  // grouping that finds one module (files tied together only through a hub, an index say) says nothing: files one by one instead
  const groups = loose.length > MAX_LOOSE ? groupsOf(input, loose) : []
  const degenerate = groups.length > 0 && groups[0].length > loose.length * 0.6
  if (loose.length <= MAX_LOOSE || (degenerate && loose.length <= MAX_SINGLES)) units.push(...loose.map(one))
  else if (degenerate) {
    // the most used one by one, the rest together
    const ranked = [...loose].sort((a, b) => (input.incoming.get(b)?.length ?? 0) - (input.incoming.get(a)?.length ?? 0) || loc([b]) - loc([a]) || cmp(a, b))
    units.push(...ranked.slice(0, MAX_LOOSE - 1).map(one))
    const rest = ranked.slice(MAX_LOOSE - 1)
    units.push({ id: `blocks:group:${dir}:rest`, select: rest[0], name: 'other files', note: `${rest.length} files`, kind: 'group', files: rest, loc: loc(rest), layer: layerOf(rest), provided: 0, opens: false })
  } else {
    groups.forEach((files, k) => {
      const main = mostUsed(input, files)
      const stem = (world.node(main)?.name ?? main).replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, '')
      const rest = k === MAX_GROUPS && files.length > 1
      units.push({
        id: `blocks:group:${dir}:${k}`,
        select: main,
        name: rest ? 'other files' : stem,
        note: rest ? `${files.length} files` : files.length > 1 ? `+${files.length - 1} files` : undefined,
        kind: 'group',
        files,
        loc: loc(files),
        layer: layerOf(files),
        provided: 0,
        opens: false,
      })
    })
  }
  return units.sort((a, b) => b.files.length - a.files.length || b.loc - a.loc || cmp(a.id, b.id))
}

/**
 * Loose files grouped by the modules their dependencies on each other form
 * (Louvain): the largest MAX_GROUPS of two or more files, then the rest
 * (single files included) as one last group.
 */
function groupsOf(input: BlocksInput, files: string[]): string[][] {
  const set = new Set(files)
  const edges: { source: string; target: string; weight: number }[] = []
  for (const f of files) for (const [t, count] of input.weight.get(f) ?? []) if (set.has(t) && t !== f) edges.push({ source: f, target: t, weight: 1 + Math.log(count) })
  const of = louvain([...files].sort(), edges)
  const byModule = new Map<number, string[]>()
  for (const f of [...files].sort()) push(byModule, of.get(f)!, f)
  const modules = [...byModule.values()].sort((a, b) => b.length - a.length || cmp(a[0], b[0]))
  const kept = modules.filter(m => m.length > 1).slice(0, MAX_GROUPS)
  const keptSet = new Set(kept)
  const rest = modules.filter(m => !keptSet.has(m)).flat().sort()
  return rest.length ? [...kept, rest] : kept
}

/** The file of a group that the most files use (ties: the larger, then the first). */
function mostUsed(input: BlocksInput, files: string[]): string {
  const fanIn = (f: string) => input.incoming.get(f)?.length ?? 0
  const loc = (f: string) => input.world.node(f)?.metrics?.loc ?? 0
  return [...files].sort((a, b) => fanIn(b) - fanIn(a) || loc(b) - loc(a) || cmp(a, b))[0]
}

/**
 * File dependencies lifted to unit pairs, the units' provided interfaces,
 * and on a white box the neighbors outside it (stubs) with their links.
 */
function linksOf(
  input: BlocksInput,
  units: Unit[],
  unitOf: ReadonlyMap<string, number>,
  stubBase: number,
  outside: (file: string) => { level: number; unit: number } | undefined,
  levels?: Level[],
  depth = 1,
): { links: Link[]; stubs: Stub[]; moreStubs: number } {
  const pairs = new Map<string, Link>()
  const provided = units.map(() => new Set<string>())
  // neighbors outside: by "level:unit", what they use of the box (in) and what the box uses of them (out)
  const near = new Map<string, { level: number; unit: number; in: number; out: number }>()
  const nearLinks = new Map<string, { inner: number; key: string; dir: 'in' | 'out'; weight: number; pairs: number; violates: boolean }>()
  const touch = (key: string, ref: { level: number; unit: number }) => {
    let n = near.get(key)
    if (!n) near.set(key, (n = { ...ref, in: 0, out: 0 }))
    return n
  }
  const nearLink = (inner: number, key: string, dir: 'in' | 'out', count: number, violates: boolean) => {
    const k = `${inner}|${key}|${dir}`
    const l = nearLinks.get(k) ?? { inner, key, dir, weight: 0, pairs: 0, violates: false }
    if (violates) l.violates = true
    l.weight += count
    l.pairs++
    nearLinks.set(k, l)
  }
  for (const [file, a] of unitOf) {
    for (const [target, count] of input.weight.get(file) ?? []) {
      if (!target.startsWith('f:')) continue
      const b = unitOf.get(target)
      if (b !== undefined) {
        if (a === b) continue
        provided[b].add(target)
        const key = `${a}>${b}`
        const l = pairs.get(key) ?? { from: a, to: b, weight: 0, pairs: 0, up: false, violates: false }
        if (input.violating?.(file, target)) l.violates = true
        l.weight += count
        l.pairs++
        pairs.set(key, l)
        continue
      }
      const o = outside(target)
      if (!o) continue
      const key = `${o.level}:${o.unit}`
      touch(key, o).out += count
      nearLink(a, key, 'out', count, !!input.violating?.(file, target))
    }
  }
  // what outside uses of the box (incoming edges, found from the other end)
  if (levels)
    for (const [file, a] of unitOf)
      for (const source of input.incoming.get(file) ?? []) {
        if (!source.startsWith('f:') || unitOf.has(source)) continue
        const o = outside(source)
        if (!o) continue
        const count = input.weight.get(source)?.get(file) ?? 1
        provided[a].add(file)
        const key = `${o.level}:${o.unit}`
        touch(key, o).in += count
        nearLink(a, key, 'in', count, !!input.violating?.(source, file))
      }
  units.forEach((u, i) => (u.provided = provided[i].size))
  // tiered (features above shared code): only between tiers does a dependency point up
  const tiered = units.some(u => u.tier !== undefined)
  const layerRank = (i: number) => (tiered ? units[i].tier : units[i].layer)
  const links = [...pairs.values()].map(l => {
    const [la, lb] = [layerRank(l.from), layerRank(l.to)]
    return { ...l, up: la !== undefined && lb !== undefined && lb < la }
  })

  // stubs: the most strongly linked neighbors on each side
  const stubs: Stub[] = []
  let moreStubs = 0
  if (levels) {
    const ranked = [...near].sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out) || cmp(a[0], b[0]))
    const side = (n: { in: number; out: number }): Stub['side'] => (n.out >= n.in ? 'bottom' : 'top')
    const count = { top: 0, bottom: 0 }
    const index = new Map<string, number>()
    for (const [key, n] of ranked) {
      const s = side(n)
      if (count[s] >= MAX_STUBS) {
        moreStubs++
        continue
      }
      count[s]++
      const u = levels[n.level].units[n.unit]
      index.set(key, stubs.length)
      stubs.push({ id: stubId(u.id, depth), select: u.select, name: u.name, layer: u.layer, side: s })
    }
    for (const l of nearLinks.values()) {
      const s = index.get(l.key)
      if (s === undefined) continue
      const stub = stubBase + s
      const [from, to] = l.dir === 'out' ? [l.inner, stub] : [stub, l.inner]
      const [la, lb] = [from < stubBase ? layerRank(from) : stubs[s].layer, to < stubBase ? layerRank(to) : stubs[s].layer]
      links.push({ from, to, weight: l.weight, pairs: l.pairs, up: la !== undefined && lb !== undefined && lb < la, violates: l.violates })
    }
  }
  links.sort((a, b) => a.from - b.from || a.to - b.to)
  return { links, stubs, moreStubs }
}

/** A stub's box id: the neighbor's, marked with the level it stands on (the controller's baseId reads the node id back). */
export const stubId = (id: string, depth: number) => `${id}\u0000stub${depth}`

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
