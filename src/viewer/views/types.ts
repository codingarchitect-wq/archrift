// The contract a view plug-in implements (src/viewer/views/<id>/index.ts,
// found by registry.ts). A view turns the graph into a Layout (boxes keyed by
// node id, which the engine draws, tweens, picks, labels and flies to) and may
// add its own 3D content (a Decoration), labels, colors, arc routes and
// toolbar controls. See views/README.md.
import type { ComponentType } from 'react'
import type * as THREE from 'three'
import type { GraphNode } from '../../core/model.ts'
import type { Grouping, Visibility } from '../controller.ts'
import type { Layout } from '../layouts/types.ts'
import type { Decoration } from '../scene/decoration.ts'
import type { ArcSpec, SceneEngine, Theme } from '../scene/engine.ts'
import type { LabelSpec } from '../scene/labels.ts'
import type { State } from '../store.ts'
import type { DepGraph, World } from '../world.ts'

export interface ViewContext {
  /** Everything the viewer knows (options, selection, details, timeline …). Read-only. */
  s: State
  /** The graph shown (a snapshot's on the timeline). */
  world: World
  /** Which nodes the filters let through. */
  visibility: Visibility
  /** File-level dependencies under the filters, edge kinds and build target. */
  graph: DepGraph
  /** The grouping chosen in the toolbar (detected modules, layers, custom groups), or null for folders. */
  grouping: Grouping | null
  /** The architecture layers (configured, or derived from dependencies when there are none). */
  layers(): { order: string[]; layerOf: (n: GraphNode) => string | undefined; labels?: Map<string, string> }
  theme: Theme
  /** Run the controller again, e.g. when a layout computed off the main thread is ready. */
  refresh(): void
}

/** A decoration that follows the viewer's state. */
export interface ViewDecoration extends Decoration {
  /** After every change to colors, selection, options or the graph. */
  update?(ctx: ViewContext, layout: Layout): void
}

export interface ViewPlugin {
  /** In the URL (`?view=<id>`); lowercase letters. */
  id: string
  /** On the toolbar button. */
  label: string
  /** The button's tooltip: what the view shows. */
  description: string
  /** Toolbar order (City, Layers, Galaxy come first, then plug-ins by this). */
  order: number
  /**
   * Plug-ins sharing a group share one toolbar button, a menu of them named
   * after the group (the arc42 views), placed where the first of them would be.
   */
  group?: string
  /** False: the toolbar's group option (folders, detected modules, layers) means nothing here, so it's hidden. */
  groupBy?: false
  /** False: the toolbar's edges option means nothing here (the view draws no dependencies, or its own way), so it's hidden. */
  edges?: false
  /** The layout, or undefined while it's being computed (call ctx.refresh() when it's ready). */
  layout(ctx: ViewContext): Layout | undefined
  /** When this changes, the layout is recomputed (it always is when filters, grouping or the graph change). */
  layoutKey?(ctx: ViewContext): string
  /** Created when the view is shown, disposed of when another one is. */
  decoration?(ctx: ViewContext, engine: SceneEngine): ViewDecoration
  /** Labels besides the usual ones (districts, the selection, its neighbors, floors). */
  labels?(ctx: ViewContext, layout: Layout): LabelSpec[]
  /** Adjust the colors the viewer chose (mutate the map). */
  colors?(ctx: ViewContext, layout: Layout, colors: Map<string, THREE.Color>): void
  /** Route an arc (set `points`), or return null to leave it out. */
  routeArc?(ctx: ViewContext, layout: Layout, arc: ArcSpec): ArcSpec | null
  /** Shown in the toolbar while the view is. */
  Controls?: ComponentType
  /**
   * The legend's key while the view is shown, in place of the color key and
   * the uses/used-by swatches; null when those don't apply and there's
   * nothing to say instead. Leave it out to keep the viewer's own.
   */
  Legend?: ComponentType | null
}
