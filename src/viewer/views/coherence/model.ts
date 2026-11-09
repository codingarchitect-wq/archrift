// Coherence view, part 1: the measures (core/coherence.ts) for the graph
// shown, its blocks, and the colors. Blocks are the toolbar's groups when
// chosen, else the config's groups, else folders where the production code
// splits (as `archrift coherence` has them). Measured over all files, whatever
// the filters show, so the numbers match the command line's; computed once
// per graph and grouping.
import { coherenceModel, fileLinks, folderBlocks, recentSince } from '../../../core/coherence.ts'
import type { CoherenceModel, ConcernStats } from '../../../core/coherence.ts'
import { fileIdOf } from '../../../core/ids.ts'
import type { GraphNode } from '../../../core/model.ts'
import { Color } from 'three'
import { AREA_PALETTE, heat } from '../../colors.ts'
import { groupName, isGroupId } from '../../groups.ts'
import { reachFrom } from '../../world.ts'
import type { World } from '../../world.ts'
import type { ViewContext } from '../types.ts'

/** A group's color in the clouds: the area palette, then hues a golden angle apart. */
export function groupColor(i: number): string {
  if (i < AREA_PALETTE.length) return AREA_PALETTE[i]
  return `#${new Color().setHSL(((i * 137.508) % 360) / 360, 0.55, 0.6).getHexString()}`
}

/** A concern's ways, main way first: calm blue, then colors far from it and from each other. */
export const WAY_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#59a14f', '#b07aa1', '#edc948', '#76b7b2', '#ff9da7', '#9c755f']
/** A file on two ways or more: where code translates between them. */
export const MIXED_COLOR = '#ff3dd4'

export interface Blocks {
  /** What they are: groups or folders. */
  kind: 'group' | 'folder'
  of: (f: GraphNode) => string | undefined
  name: (block: string) => string
}

export interface Coherence {
  model: CoherenceModel
  blocks: Blocks
  /** The graph knows its concerns (false: analyzed before coherence was measured). */
  measured: boolean
}

interface GroupingLike {
  key: string
  groups: readonly { id: string; label: string }[]
  groupOf: (fileId: string) => string | undefined
}

const memo = new WeakMap<World, Map<string, Coherence>>()

export function coherenceFor(world: World, grouping: GroupingLike | null): Coherence {
  const key = grouping?.key ?? 'default'
  const cached = memo.get(world)?.get(key)
  if (cached) return cached
  const files = world.graph.nodes.filter(n => n.kind === 'file')
  const blocks = blocksOf(files, grouping)
  const model = coherenceModel({
    files,
    concerns: world.graph.meta.concerns ?? [],
    links: fileLinks(world.graph, world.index),
    blockOf: blocks.of,
    since: recentSince(files),
  })
  const c = { model, blocks, measured: world.graph.meta.concerns !== undefined }
  const forWorld = memo.get(world) ?? new Map<string, Coherence>()
  forWorld.set(key, c)
  memo.set(world, forWorld)
  return c
}

function blocksOf(files: GraphNode[], grouping: GroupingLike | null): Blocks {
  if (grouping) {
    const labels = new Map(grouping.groups.map(g => [g.id, groupName(g)]))
    return { kind: 'group', of: f => grouping.groupOf(f.id), name: b => labels.get(b) ?? b }
  }
  if (files.some(f => f.tags?.some(t => t.startsWith('group:')))) return { kind: 'group', of: f => f.tags?.find(t => t.startsWith('group:'))?.slice(6), name: b => b }
  const byFolder = folderBlocks(files.filter(f => !f.tags?.includes('test')).map(f => f.path ?? f.id))
  return { kind: 'folder', of: f => byFolder(f.path ?? f.id), name: b => b }
}

/** Each way's color, main way first. */
export function wayColors(c: ConcernStats): Map<string, string> {
  return new Map(c.paradigms.map((p, i) => [p.id, WAY_COLORS[i % WAY_COLORS.length]]))
}

/** A file's color: its way in the concern shown, or (no concern picked) how many concerns it strays from its block's way in. */
export function fileColor(c: Coherence, concern: ConcernStats | undefined, id: string): string | undefined {
  const ways = c.model.ways.get(id)
  if (concern) {
    const own = ways?.get(concern.concern.id)
    if (!own) return undefined
    return own.length > 1 ? MIXED_COLOR : wayColors(concern).get(own[0])
  }
  if (!ways) return undefined
  return strayHeat(c.model.strays.get(id)?.length ?? 0)
}

/** Off its block's way in this many concerns: 0 calm blue, 1 yellow, 2 orange, 3 or more red. */
export const strayHeat = (n: number) => heat([0, 0.5, 0.78, 1][Math.min(n, 3)])

/** What a selection keeps bright: what it uses and what uses it (the toolbar's focus), a folder's or group's files. */
export function relatedOf(ctx: ViewContext): Set<string> | null {
  const sel = ctx.s.selected
  if (!sel) return null
  if (isGroupId(sel)) {
    const out = new Set<string>([sel])
    for (const id of ctx.visibility.ids) if (ctx.grouping?.groupOf(id) === sel) out.add(id)
    return out
  }
  const node = ctx.world.node(sel)
  if (!node) return null
  const start =
    node.kind === 'directory'
      ? ctx.world.index.descendants(node.id).filter(d => d.kind === 'file' && ctx.visibility.ids.has(d.id)).map(d => d.id)
      : [node.kind === 'external' ? node.id : fileIdOf(node.id) ?? node.id]
  const out = new Set<string>(start)
  const r = reachFrom(ctx.graph, start, ctx.s.options.focusDir, ctx.s.options.focusDepth)
  for (const id of r.out.keys()) out.add(id)
  for (const id of r.in.keys()) out.add(id)
  return out
}

export const titleOf = (c: ConcernStats) => `${c.concern.stack} · ${c.concern.label}`
export const pct = (x: number) => `${Math.round(x * 100)} %`
