// The Tree view (a view plug-in): the codebase as a living tree. The root
// folder is the trunk, folders are branches forking into their sub-folders,
// files are leaves at their folder's fork (sized by LOC, in the viewer's
// colors), the hottest files hang as fruit. On the timeline the tree keeps
// the shape of everything that ever existed and shows what existed then:
// scrubbing through history grows it.
import * as THREE from 'three'
import type { GraphNode } from '../../../core/model.ts'
import type { Layout } from '../../layouts/types.ts'
import { folderPriority } from '../../scene/labels.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { labelOf } from '../../store.ts'
import type { ViewPlugin } from '../types.ts'
import { Bark, remember } from './bark.ts'
import { growTree, shownTree } from './layout.ts'
import type { TreeGeometry } from './layout.ts'

/** How far a bundled arc is pulled from the forks toward a straight line (the engine's own bundling: 0.2). */
const PULL = 0.45

const lightness = new Map<string, number>()
const isDark = (color: string) => {
  let l = lightness.get(color)
  if (l === undefined) lightness.set(color, (l = new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 }).l))
  return l < 0.5
}

/** The last tree grown: on the timeline and in watch mode it outlives many points in time. */
let grown: { nodes: readonly GraphNode[]; key: string; tree: TreeGeometry } | undefined

const view: ViewPlugin = {
  id: 'tree',
  label: 'Tree',
  description: 'Folders as branches, files as leaves; the timeline grows it',
  order: 40,

  layout(ctx) {
    const s = ctx.s
    // on the timeline, everything that ever existed; in watch mode, everything seen since the page loaded
    const base = s.options.timeline && s.union ? s.union : s.liveBase
    const nodes = base ?? ctx.world.graph.nodes
    const key = `${ctx.world.rootId}|${ctx.visibility.key}`
    if (grown?.nodes !== nodes || grown.key !== key) grown = { nodes, key, tree: growTree({ nodes, rootId: ctx.world.rootId, isVisible: ctx.visibility.isVisible }) }
    const { layout, shape } = shownTree(grown.tree, id => ctx.world.node(id), ctx.visibility.isVisible)
    remember(layout, shape)
    return layout
  },

  decoration: (_ctx, engine) => new Bark(engine),

  // bundled arcs follow the tree from fork to fork, but float clear of the bark,
  // and on a dark background they're lighter than the foliage they cross
  routeArc(ctx, layout, arc) {
    const a = layout.boxes.get(arc.source)
    const b = layout.boxes.get(arc.target)
    if (arc.via?.length && a && b) {
      const forks = arc.via.flatMap(id => layout.boxes.get(id) ?? [])
      arc.points = forks.map((f, i) => {
        const t = (i + 1) / (forks.length + 1)
        const on = (k: 'x' | 'z') => a[k] + (b[k] - a[k]) * t
        const y = a.y + a.h / 2 + (b.y + b.h / 2 - (a.y + a.h / 2)) * t
        return [f.x + (on('x') - f.x) * PULL, f.y + f.h / 2 + (y - f.y - f.h / 2) * PULL, f.z + (on('z') - f.z) * PULL]
      })
      arc.via = undefined
    }
    // background arcs (they have a width), the heavier the lighter
    if (arc.width !== undefined && isDark(ctx.theme.background)) {
      const k = 1 + 0.22 * arc.width
      arc.from = arc.from.clone().multiplyScalar(k)
      arc.to = arc.to.clone().multiplyScalar(k)
    }
    return arc
  },

  // folder names at the forks of the top levels, however small the fork itself, the third once
  // its leaves show (the viewer's own labels need a wide box, and lose to these where they meet)
  labels(ctx, layout: Layout) {
    const specs: LabelSpec[] = []
    for (const [id, placement] of layout.placement) {
      const depth = layout.depth.get(id) ?? 0
      if (placement !== 'cluster' || depth < 1 || depth > 3) continue
      const code = ctx.world.node(id)?.name ?? id
      const text = labelOf(ctx.s, id, code)
      specs.push({ id, text, priority: folderPriority(depth, text !== code ? 'named' : 'plain') + 5, className: `district d${depth}`, minScreenWidth: depth === 3 ? 28 : undefined })
    }
    return specs
  },
}

export default view
