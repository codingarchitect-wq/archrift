// Terrain view: the layout. The City's treemap (or its grouped variant) keeps
// the regions; each file's cell raises the ground by the chosen metric, and
// every box is refitted to the ground: a file's box spans its cell's terrain
// (top on the surface), a folder's box reaches up to the ground at its label.
import type { GraphNode } from '../../../core/model.ts'
import { isGroupId } from '../../groups.ts'
import { cityLayout } from '../../layouts/city.ts'
import type { Rect } from '../../layouts/city.ts'
import { groupedLayout } from '../../layouts/grouped.ts'
import { baseId } from '../../layouts/layers.ts'
import type { Box, Layout } from '../../layouts/types.ts'
import { buildHeightfield, cellOf, heightAt, levels, peaks, rangeIn } from './heightfield.ts'
import type { Heightfield } from './heightfield.ts'
import type { Metric } from './metric.ts'

/** Peaks labelled by file name. */
const PEAK_LABELS = 8

export interface TerrainInput {
  /** What to place: the timeline's union or watch mode's growing base keep the footprints still. */
  nodes: readonly GraphNode[]
  rootId: string
  isVisible: (n: GraphNode) => boolean
  /** A node as the shown world has it; undefined when it doesn't exist there (then) and sinks. */
  shown: (id: string) => GraphNode | undefined
  metric: { id: Metric; key: string }
  /** Districts by detected module, layer or group, as the City draws them. */
  grouping?: { groups: { id: string; label: string }[]; groupOf: (fileId: string) => string | undefined }
}

export interface Region {
  id: string
  rect: Rect
}

export interface Terrain {
  field: Heightfield
  /** World height of level 1. */
  scale: number
  metric: Metric
  /** Districts, outer to inner, then file cells: what colors and picks the ground. */
  regions: Region[]
  /** How many regions are districts (files come after them). */
  districts: number
  /** The highest peaks, as file ids, highest first. */
  peaks: string[]
}

/** World height of level 1: a tenth of the layout's side (the camera keeps its distance in proportion). */
export const heightScale = (size: number) => Math.max(14, size * 0.1)

export function terrainLayout(input: TerrainInput): { layout: Layout; terrain: Terrain } {
  const base = input.grouping
    ? groupedLayout({ ...input, groups: input.grouping.groups, groupOf: f => input.grouping!.groupOf(f.id) })
    : cityLayout(input)
  // what isn't there at this time sinks (the controller's presentIn does the same for the City)
  for (const id of [...base.placement.keys()]) {
    const b = baseId(id)
    if (isGroupId(b) || input.shown(b)) continue
    base.boxes.delete(id)
    base.placement.delete(id)
    base.depth.delete(id)
  }
  const size = base.size
  const scale = heightScale(size)

  const files = [...base.placement].filter(([, p]) => p === 'building').map(([id]) => id)
  const cells = files.map(id => cellOf(base.boxes.get(id)!))
  const values = files.map(id => input.shown(id)?.metrics?.[input.metric.key] ?? 0)
  const fileLevels = levels(values)
  const root = base.boxes.get(input.rootId)
  const pad = root ? Math.min(root.w, root.d) * 0.025 + 1.2 : 0 // the city's district padding
  const land = root ? { x: root.x - root.w / 2 + pad, z: root.z - root.d / 2 + pad, w: root.w - 2 * pad, d: root.d - 2 * pad } : null
  const field = buildHeightfield(
    size,
    cells.map((rect, i) => ({ rect, level: fileLevels[i] })),
    land,
  )

  // files: a box over the cell, from its lowest ground to its highest
  const tops: number[] = []
  files.forEach((id, i) => {
    const c = cells[i]
    const [lo, hi] = rangeIn(field, c)
    tops.push(hi)
    base.boxes.set(id, { x: c.x + c.w / 2, z: c.z + c.d / 2, w: c.w, d: c.d, y: lo * scale, h: Math.max((hi - lo) * scale, 0.3) })
  })
  // folders: from the ground up to the surface where their label stands (the engine puts it 3 in
  // from the north edge) or at their center (where folded arcs end), whichever is higher
  const districts = [...base.placement].filter(([, p]) => p === 'district').map(([id]) => id)
  districts.sort((a, b) => (base.depth.get(a) ?? 0) - (base.depth.get(b) ?? 0) || (a < b ? -1 : 1))
  const regions: Region[] = []
  for (const id of districts) {
    const b = base.boxes.get(id)!
    regions.push({ id, rect: { x: b.x - b.w / 2, z: b.z - b.d / 2, w: b.w, d: b.d } })
    const ground = Math.max(heightAt(field, b.x, b.z - b.d / 2 + 3), heightAt(field, b.x, b.z))
    base.boxes.set(id, { ...b, y: 0, h: Math.max(ground * scale, 0.5) })
  }
  files.forEach((id, i) => regions.push({ id, rect: cells[i] }))

  const centers = cells.map(c => ({ x: c.x + c.w / 2, z: c.z + c.d / 2 }))
  const high = peaks(centers, tops, PEAK_LABELS, size * 0.12).filter(i => fileLevels[i] >= 0.3)

  const layout: Layout = {
    ...base,
    view: 'terrain',
    hideBoxes: true,
    openFile: 'none',
    // a lower look than the City's, so the relief reads
    home: [0.1, 0.55, 0.92],
  }
  return {
    layout,
    terrain: { field, scale, metric: input.metric.id, regions, districts: districts.length, peaks: high.map(i => files[i]) },
  }
}

/**
 * Where a dependency arc runs from box a to box b: over the ground, a little
 * above it and never through a ridge between two samples, with a low rise in
 * the middle so paths over flat land still read as arcs. Ends excluded.
 */
export function groundPath(t: Terrain, a: Box, b: Box): [number, number, number][] {
  const dist = Math.hypot(b.x - a.x, b.z - a.z)
  const segments = Math.min(24, Math.max(2, Math.ceil(dist / (t.field.size * 0.04))))
  const lift = Math.max(0.6, t.scale * 0.035)
  const rise = Math.min(dist * 0.05, t.scale * 0.1)
  const points: [number, number, number][] = []
  for (let i = 1; i < segments; i++) {
    const u = i / segments
    let ground = 0
    for (const w of [u - 0.5 / segments, u, u + 0.5 / segments]) ground = Math.max(ground, heightAt(t.field, a.x + (b.x - a.x) * w, a.z + (b.z - a.z) * w))
    points.push([a.x + (b.x - a.x) * u, ground * t.scale + lift + Math.sin(Math.PI * u) * rise, a.z + (b.z - a.z) * u])
  }
  return points
}
