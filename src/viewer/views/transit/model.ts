// Transit view: the map a layout stands for (lines, colors, the schematic),
// kept by layout so labels, colors and the decoration read it without
// recomputing, and the lines network cached per graph.
import * as THREE from 'three'
import { fileIdOf } from '../../../core/ids.ts'
import { AREA_PALETTE } from '../../colors.ts'
import type { Layout } from '../../layouts/types.ts'
import type { Theme } from '../../scene/engine.ts'
import type { World } from '../../world.ts'
import type { ViewContext } from '../types.ts'
import { buildNetwork, pairKinds } from './network.ts'
import type { Network, TransitLine } from './network.ts'
import type { Schematic } from './schematic.ts'

export interface TransitMap {
  network: Network
  /** The lines shown, best first, and each one's rank among all lines (its color). */
  shown: TransitLine[]
  ranks: number[]
  schematic: Schematic
  /** Column headers, left to right. */
  headers: string[]
}

/** How much a line or station that doesn't pass the selected station fades into the ground. */
export const DIM = 0.78

/** The map each Transit layout was made from. */
export const maps = new WeakMap<Layout, TransitMap>()

let cached: { world: World; key: string; network: Network } | undefined

/** The lines of the graph shown (recomputed when the world, the filters, the edge kinds or the layering change). */
export function networkOf(ctx: ViewContext): Network {
  const key = `${ctx.graph.key}|${ctx.s.options.layering}`
  if (cached?.world === ctx.world && cached.key === key) return cached.network
  const layers = ctx.layers()
  const files = [...ctx.visibility.ids].flatMap(id => (id.startsWith('f:') ? (ctx.world.node(id) ?? []) : []))
  const network = buildNetwork({
    files,
    out: ctx.graph.out,
    in: ctx.graph.in,
    weight: ctx.graph.weight,
    kinds: pairKinds(ctx.world.graph.edges, ctx.s.options.target),
    order: layers.order,
    layerOf: layers.layerOf,
  })
  cached = { world: ctx.world, key, network }
  return network
}

/** Column headers: the layer names; for derived layers (`level 2: src/client, src/ui`), their folders' own names. */
export function headersOf(ctx: ViewContext, network: Network) {
  const labels = ctx.layers().labels
  return network.columns.map(c => {
    const label = labels?.get(c)
    if (!label) return c
    return label
      .slice(label.indexOf(': ') + 2)
      .split(', ')
      .map(area => area.replace(/^.*\//, ''))
      .join(', ')
  })
}

/** A line's color by its rank: the area palette, then hues around the circle. */
export function lineColor(rank: number): string {
  if (rank < AREA_PALETTE.length) return AREA_PALETTE[rank]
  const hue = ((rank - AREA_PALETTE.length) * 137.508 + 20) % 360
  return `#${new THREE.Color().setHSL(hue / 360, 0.55, 0.55).getHexString()}`
}

/** On a light background, pale line colors are darkened until they stand out. */
export function lineColorOn(rank: number, theme: Theme): THREE.Color {
  const c = new THREE.Color(lineColor(rank))
  if (!isLight(theme)) return c
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  return c.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.min(hsl.l, 0.5))
}

export const isLight = (theme: Theme) => new THREE.Color(theme.background).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5

/** The lines (indexes into `shown`) through the selected station, or null when nothing on the map is selected. */
export function litLines(ctx: ViewContext, map: TransitMap): Set<number> | null {
  const sel = ctx.s.selected
  if (!sel) return null
  const station = map.schematic.stations.get(fileIdOf(sel) ?? sel)
  return station ? new Set(station.lines) : null
}

/** Stations, branch stations included, of a line. */
export const stationsOf = (l: TransitLine) => [...new Set([...l.stations, ...l.branches.flat()])]
