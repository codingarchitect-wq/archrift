// Wheel view (radial hierarchical edge bundling, Holten 2006): files around a
// ring in one sector per folder (or group), folders as nested bands inside
// it, and every dependency routed through the folder tree, so arcs between
// the same parts of the codebase run together as one bundle. How tangled it
// is shows at a glance. layout.ts has the geometry and the routes,
// decoration.ts draws the bands and ticks and lights up hovered bundles.
import * as THREE from 'three'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { labelOf } from '../../store.ts'
import type { ViewPlugin } from '../types.ts'
import { WheelDecoration } from './decoration.ts'
import { BETA, routePoints, wheelLayout } from './layout.ts'
import type { Wheel } from './layout.ts'

const wheels = new WeakMap<Layout, Wheel>()
/** The colors the viewer chose last: the decoration paints the ticks with them. */
let lastColors: Map<string, THREE.Color> | null = null
let routed = 0

const wheel: ViewPlugin = {
  id: 'wheel',
  label: 'Wheel',
  description: 'Files around a ring by folder, folders as bands inside it; dependencies bundled along the folder tree',
  order: 20,

  layout(ctx) {
    const w = wheelLayout({
      nodes: ctx.world.graph.nodes,
      rootId: ctx.world.rootId,
      isVisible: ctx.visibility.isVisible,
      groups: ctx.grouping?.groups,
      groupOf: ctx.grouping?.groupOf,
    })
    wheels.set(w.layout, w)
    return w.layout
  },

  // background and focus arcs alike follow the tree (straight when bundling is off); background ones
  // stay thin (fat translucent lines bead on dense routes), their weight shown by how much ink they get
  routeArc(ctx, layout, arc) {
    const w = wheels.get(layout)
    const points = w && routePoints(w, arc.source, arc.target, ctx.s.options.bundle ? BETA : 0)
    if (!points) return null
    arc.points = points
    arc.via = undefined
    if (arc.width && arc.width > 1) {
      // heavier: more ink (brighter on a dark background, darker on a light one)
      const k = (arc.width === 3 ? 0.9 : 0.45) * (light(ctx.theme.background) ? -0.5 : 1)
      arc.from = arc.from.clone().multiplyScalar(1 + k)
      arc.to = arc.to.clone().multiplyScalar(1 + k)
      arc.width = 1
    }
    routed++
    return arc
  },

  // folder names off the ring; file names come with the selection (the viewer's neighbor labels)
  labels(ctx, layout): LabelSpec[] {
    const w = wheels.get(layout)
    return (w?.labels ?? []).map(l => ({
      id: l.id,
      text: l.group ? l.text : labelOf(ctx.s, l.sector, l.text),
      priority: l.level === 0 ? 430 : 380,
      className: l.group ? 'group' : l.level === 0 ? 'district d1' : 'district',
      minScreenWidth: l.level === 0 ? 14 : 30,
    }))
  },

  // a folded folder's tick: its files' colors, those the selection keeps bright if there are any
  colors(ctx, layout, colors) {
    lastColors = colors
    const w = wheels.get(layout)
    if (!w?.folded) return
    const background = new THREE.Color(ctx.theme.background)
    const members = new Map<string, THREE.Color[]>()
    for (const [id, mark] of w.markOf) {
      const c = colors.get(id)
      if (!c || id === mark || layout.placement.get(id) !== 'building') continue
      const list = members.get(mark)
      if (list) list.push(c)
      else members.set(mark, [c])
    }
    const white = new THREE.Color('#ffffff')
    for (const [mark, list] of members) {
      const reach = list.map(c => Math.hypot(c.r - background.r, c.g - background.g, c.b - background.b))
      const most = Math.max(...reach)
      const mean = new THREE.Color(0, 0, 0)
      let n = 0
      list.forEach((c, i) => {
        if (reach[i] < most * 0.6) return
        mean.add(c)
        n++
      })
      mean.multiplyScalar(1 / n)
      if (ctx.s.selected === mark) mean.lerp(white, 0.45)
      colors.set(mark, mean)
    }
  },

  decoration(_ctx, engine) {
    return new WheelDecoration(engine, {
      wheelOf: layout => wheels.get(layout),
      colors: () => lastColors,
      routed: () => {
        const n = routed
        routed = 0
        return n
      },
    })
  },
}

export default wheel

const light = (background: string) => new THREE.Color(background).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5
