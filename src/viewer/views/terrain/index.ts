// Terrain view (a view plug-in, see ../README.md): the City melted into a
// landscape. Folders keep the City's regions; files raise a smooth ground by
// the metric chosen in the toolbar (complexity, churn, hotspots, lines), so
// hard code becomes mountains and calm code plains. File and folder boxes
// stay, hidden, fitted to the ground for selection, labels and fly-to; the
// highest peaks are named, and dependencies run over the land like paths.
import type * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { labelOf } from '../../store.ts'
import type { ViewPlugin } from '../types.ts'
import { TerrainControls } from './controls.tsx'
import { groundPath, terrainLayout } from './layout.ts'
import type { Terrain } from './layout.ts'
import { effectiveMetric, setHistoryAvailable, setRefresh } from './metric.ts'
import { TerrainSurface } from './surface.ts'

const terrains = new WeakMap<Layout, Terrain>()
/** The colors the viewer chose last (the `colors` hook runs just before the decoration's update). */
let shownColors: Map<string, THREE.Color> | null = null

const terrain: ViewPlugin = {
  id: 'terrain',
  label: 'Terrain',
  description: 'The city as a landscape: complex (or churning) code rises into mountains, calm code stays plains',
  order: 30,
  layoutKey: ctx => effectiveMetric(ctx.s.now?.graph.meta).id,
  layout(ctx) {
    setRefresh(ctx.refresh)
    setHistoryAvailable(!!ctx.s.now?.graph.meta.history)
    const s = ctx.s
    // on the timeline everything that ever existed keeps its place; in watch mode everything seen so far
    const base = s.options.timeline && s.union ? s.union : s.liveBase
    const { layout, terrain } = terrainLayout({
      nodes: base ?? ctx.world.graph.nodes,
      rootId: ctx.world.rootId,
      isVisible: ctx.visibility.isVisible,
      shown: id => ctx.world.node(id),
      metric: effectiveMetric(s.now?.graph.meta),
      grouping: ctx.grouping ?? undefined,
    })
    terrains.set(layout, terrain)
    return layout
  },
  decoration: (_ctx, engine) =>
    new TerrainSurface(
      engine,
      layout => terrains.get(layout),
      () => shownColors,
    ),
  colors(_ctx, _layout, colors) {
    shownColors = colors
  },
  labels(ctx, layout): LabelSpec[] {
    return (terrains.get(layout)?.peaks ?? []).map((id, i) => ({ id, text: `▲ ${labelOf(ctx.s, id, ctx.world.node(id)?.name ?? id)}`, priority: 520 - i, className: 'peak' }))
  },
  routeArc(_ctx, layout, arc) {
    const t = terrains.get(layout)
    const a = layout.boxes.get(arc.source)
    const b = layout.boxes.get(arc.target)
    return t && a && b ? { ...arc, points: groundPath(t, a, b) } : arc
  },
  Controls: TerrainControls,
}

export default terrain
