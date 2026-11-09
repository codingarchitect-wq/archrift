// arc42 kit: the top-level building blocks, shared by the views that draw
// them (§5's level 1, §8's pillars, §6's lifelines when grouped) so they
// agree on what the blocks are. By folder: from the root down through
// folders that hold (nearly) all the code, to the folder where it splits;
// that folder's subfolders are the blocks, and whatever lay beside the way
// down (a prisma/ next to src/, the config files at the root) becomes a block
// of its own. Grouped (the toolbar's detected modules, layers or configured
// groups): the groups are the blocks.
import type { GraphNode } from '../../../core/model.ts'
import { groupName } from '../../groups.ts'
import { labelOf } from '../../store.ts'
import type { State } from '../../store.ts'
import type { World } from '../../world.ts'

export { groupName }

export interface TopBlock {
  /**
   * The folder's id (d:…); a loose block stands for the files lying directly
   * in that folder, and has the folder's id too. A group's id (module:…,
   * layer:…) when the blocks are the toolbar's groups.
   */
  id: string
  name: string
  /** The files shown in it. */
  files: string[]
  loc: number
  loose: boolean
  /** It is one of the toolbar's groups, not a folder. */
  group: boolean
  /** The folder its code sits in: its own for a folder, the deepest folder holding all its files for a group. */
  home: string
}

/** The toolbar's grouping, as the viewer's controller hands it to views (ctx.grouping). */
export interface BlockGrouping {
  groups: readonly { id: string; label: string }[]
  groupOf: (fileId: string) => string | undefined
}

export interface TopBlocks {
  /** The folder the code splits in: the system's white box. */
  system: string
  /** Largest first (by files, then lines, then name). */
  blocks: TopBlock[]
  /** A shown file → its block's id. */
  blockOf: Map<string, string>
}

/** A folder holding at least this share of its parent's files is the way down. */
const MAIN = 0.8

export function topBlocks(world: World, isShown: (file: GraphNode) => boolean): TopBlocks {
  const index = world.index
  const shown = world.graph.nodes.filter(n => n.kind === 'file' && isShown(n))
  // per folder: the shown files somewhere below it
  const under = new Map<string, string[]>()
  for (const f of shown) for (const d of index.ancestors(f.id)) push(under, d.id, f.id)
  const kidsOf = (dir: string) =>
    (index.children.get(dir) ?? []).filter(c => index.node(c)?.kind === 'directory' && (under.get(c)?.length ?? 0) > 0)
  const looseOf = (dir: string) => shown.filter(f => f.parent === dir).map(f => f.id)
  const count = (dir: string) => under.get(dir)?.length ?? 0

  const blocks: TopBlock[] = []
  const block = (id: string, files: string[], loose: boolean): TopBlock => {
    const node = index.node(id)
    const name = node?.path || node?.name || id
    return { id, name: loose ? `${name.split('/').pop()} (own files)` : name.split('/').pop()!, files, loc: locOf(world, files), loose, group: false, home: id }
  }

  let current = world.rootId
  for (;;) {
    const kids = kidsOf(current)
    const main = [...kids].sort((a, b) => count(b) - count(a) || cmp(a, b))[0]
    // go down while one folder holds nearly everything and splits further below
    if (!main || count(main) < MAIN * count(current) || kidsOf(main).length < 2) break
    for (const k of kids) if (k !== main) blocks.push(block(k, under.get(k)!, false))
    const loose = looseOf(current)
    if (loose.length) blocks.push(block(current, loose, true))
    current = main
  }
  for (const k of kidsOf(current)) blocks.push(block(k, under.get(k)!, false))
  const loose = looseOf(current)
  if (loose.length) blocks.push(block(current, loose, true))

  blocks.sort((a, b) => b.files.length - a.files.length || b.loc - a.loc || cmp(a.name, b.name))
  const blockOf = new Map<string, string>()
  for (const b of blocks) for (const f of b.files) blockOf.set(f, b.id)
  return { system: current, blocks, blockOf }
}

/**
 * The top-level blocks as the toolbar groups them: the groups (detected
 * modules, layers, configured groups), or with no grouping the folders
 * (topBlocks). `system` stays the folder the code splits in.
 */
export function levelOneBlocks(world: World, isShown: (file: GraphNode) => boolean, grouping: BlockGrouping | null): TopBlocks {
  const folders = topBlocks(world, isShown)
  if (!grouping) return folders
  const filesOf = new Map<string, string[]>()
  for (const n of world.graph.nodes) {
    if (n.kind !== 'file' || !isShown(n)) continue
    const g = grouping.groupOf(n.id)
    if (g !== undefined) push(filesOf, g, n.id)
  }
  const blocks: TopBlock[] = grouping.groups.flatMap(g => {
    const files = filesOf.get(g.id)
    return files?.length ? [{ id: g.id, name: groupName(g), files, loc: locOf(world, files), loose: false, group: true, home: commonFolder(world, files) }] : []
  })
  blocks.sort((a, b) => b.files.length - a.files.length || b.loc - a.loc || cmp(a.name, b.name))
  const blockOf = new Map<string, string>()
  for (const b of blocks) for (const f of b.files) blockOf.set(f, b.id)
  return { system: folders.system, blocks, blockOf }
}

/** The deepest folder holding all of the files. */
function commonFolder(world: World, files: readonly string[]): string {
  let common: string[] | undefined
  for (const f of files) {
    const way = world.index.ancestors(f).map(d => d.id).reverse() // root first
    if (!common) common = way
    else {
      let k = 0
      while (k < common.length && k < way.length && common[k] === way[k]) k++
      common = common.slice(0, k)
    }
  }
  return common?.[common.length - 1] ?? world.rootId
}

const locOf = (world: World, files: readonly string[]) => files.reduce((n, f) => n + (world.node(f)?.metrics?.loc ?? 0), 0)

/** The layer most of a block's files are in (ties: the higher layer), or undefined when none has one. */
export function layerOfBlock(block: Pick<TopBlock, 'files'>, world: World, layerOf: (n: GraphNode) => string | undefined, order: readonly string[]): string | undefined {
  const votes = new Map<string, number>()
  for (const f of block.files) {
    const layer = layerOf(world.node(f)!)
    if (layer !== undefined) votes.set(layer, (votes.get(layer) ?? 0) + 1)
  }
  const rank = (l: string) => (order.indexOf(l) < 0 ? order.length : order.indexOf(l))
  return [...votes].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))[0]?.[0]
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A block's name on the map: the one written for its folder (described names on; for a loose block, the one for the folder's own files), else its own. A group keeps its own. */
export const blockName = (s: State, b: Pick<TopBlock, 'id' | 'name' | 'group' | 'loose'>): string => (b.group ? b.name : labelOf(s, b.id, b.name, b.loose))
