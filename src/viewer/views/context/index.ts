// §3 Context and Scope (an arc42 view plug-in): the system as a black box
// among its neighbors. The system is a glass tower in the middle, one slab
// per architecture layer, so the box is x-rayed. Round it stand who calls it
// (people through its pages, schedulers, webhooks, other API clients), the
// services it calls (from a catalog of well-known packages) and the data it
// keeps (what code queries: a Prisma schema, a Dexie database). Each tie runs
// as a tube into the layer whose code uses it, dots flowing the way requests
// go. This is the technical context, as found in the code: who the actors are
// and why they come is the business context, which needs the owner's words.
import { emptyLayout } from '../../layouts/types.ts'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { anchor, stand } from '../arc42-kit/anchors.ts'
import { ON_BOARD } from '../arc42-kit/board.ts'
import { ARC42, SECTIONS } from '../arc42-kit/sections.ts'
import type { ViewPlugin } from '../types.ts'
import { ContextDecoration } from './decoration.ts'
import { Legend } from './Legend.tsx'
import type { Tie } from './model.ts'
import { ICON, ICON_H, SHELL } from './place.ts'
import { contextOf, litBy, maps } from './state.ts'

const MAX_ROUTES = 2

const view: ViewPlugin = {
  id: 'context',
  label: SECTIONS.context.label,
  description: 'arc42 §3: the system among its neighbors, who calls it, what it calls, where its data lives, and which layer talks to each',
  order: SECTIONS.context.order,
  group: ARC42,
  // the ties are the view: no edges to choose
  edges: false,
  // the tower's slabs are the layers, whatever the toolbar groups by
  groupBy: false,

  layoutKey: ctx => `${ctx.s.options.target}|${ctx.s.options.layering}`,

  layout(ctx) {
    const { model, plan } = contextOf(ctx, ON_BOARD)
    const b = plan.board
    const out: Layout = {
      ...emptyLayout(),
      view: 'context',
      size: Math.max(b.w, b.h * 1.25),
      ground: true,
      hideBoxes: true,
      arcs: 'none',
      openFile: 'none',
      keepView: true,
      // from the front, high enough to see over the tower to the back
      home: [0, 0.4, 0.62],
      center: [b.u, 6, b.v + b.h * 0.1],
    }
    // what the engine picks, frames and flies to: the neighbors (a node may stand for one only)
    model.neighbors.forEach((nb, i) => {
      const at = plan.neighbors[i]
      if (!out.boxes.has(nb.select)) stand(out, nb.select, { x: at.x, y: ON_BOARD, z: at.z, w: ICON * 2, h: ICON_H, d: ICON * 2 })
      // the name where the viewer would name the selection, so it takes that place
      anchor(out, `context:name:${i}`, [at.x, ON_BOARD + ICON_H + 1.5, at.z], ICON * 2)
      anchor(out, `context:note:${i}`, [at.x, ON_BOARD, at.z + ICON + 2.2], ICON * 2)
    })
    plan.slabs.forEach((s, k) => anchor(out, `context:slab:${k}`, [-SHELL + 0.7, s.y0 + 0.3, SHELL + 0.05]))
    plan.ties.forEach((t, k) => anchor(out, `context:tie:${k}`, t.mid, 6))
    const left = b.u - b.w / 2 + 3
    const top = b.v - b.h / 2 + 3
    // the caption over the heading: apart in height, which the camera's tilt doesn't squash; both above
    // the tower's name, which the board's far edge would otherwise run into at the home view
    const above = ON_BOARD + 8
    anchor(out, 'context:caption', [left, above + 3.6, top])
    anchor(out, 'context:heading', [left, above, top])
    anchor(out, 'context:system', [0, plan.top + 1.6, 0])
    anchor(out, 'context:boundary', [0, ON_BOARD, SHELL + 3.5 + 2.4])
    maps.set(out, { model, plan })
    return out
  },

  decoration: () => new ContextDecoration(),

  labels(ctx, layout) {
    const map = maps.get(layout)
    if (!map) return []
    const { model, plan } = map
    const lit = litBy(ctx, model)
    const dim = (on: boolean) => (lit && !on ? ' a42-dim' : '')
    const specs: LabelSpec[] = [
      { id: 'context:heading', text: `${model.name} and its neighbors`, priority: 992, className: 'a42-heading a42-left' },
      { id: 'context:caption', text: `arc42 §${SECTIONS.context.number} · ${SECTIONS.context.title}`, priority: 991, className: 'a42-title a42-left' },
      { id: 'context:system', text: model.name, priority: 980, className: 'a42-name a42-pill' },
      { id: 'context:boundary', text: model.neighbors.length ? 'system boundary' : 'no neighbors found in the code', priority: 450, className: 'a42-small' },
    ]
    model.slabs.forEach((s, k) =>
      specs.push({ id: `context:slab:${k}`, text: s.label, priority: 870 - k, className: `a42-name a42-left${dim(!!lit?.slabs.has(k))}` }),
    )
    model.neighbors.forEach((nb, i) => {
      const on = !!lit?.neighbors.has(i)
      const selected = ctx.s.selected === nb.select
      specs.push({ id: `context:name:${i}`, text: nb.name, priority: selected ? 1001 : on ? 960 : 900 - i / 100, className: `a42-name a42-pill${selected ? ' a42-accent' : ''}${dim(on)}` })
      specs.push({ id: `context:note:${i}`, text: `${nb.about} · ${files(nb.files)}`, priority: on ? 700 : 600 - i / 100, className: `a42-small${dim(on)}` })
    })
    plan.ties.forEach((t, k) => {
      const tie = model.neighbors[t.neighbor].ties[t.tie]
      const on = !!lit?.ties.has(`${t.neighbor}:${t.tie}`)
      specs.push({ id: `context:tie:${k}`, text: tieText(ctx.world.node.bind(ctx.world), tie), priority: on ? 750 : 500 - k / 100, className: `a42-small${dim(on)}` })
    })
    return specs
  },

  Legend,
}

/** A tie's label: its channel, and the routes it comes in through or how many files use it. */
function tieText(node: (id: string) => { tags?: string[] } | undefined, tie: Tie): string {
  if (tie.dir === 'out') return `${tie.channel} · ${files(tie.files.length)}`
  const pages = tie.files.filter(f => node(f)?.tags?.some(t => t.startsWith('route:'))).length
  const routes = tie.routes.map(r => (r === 'pages' ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : r))
  const shown = routes.slice(0, MAX_ROUTES).join(', ')
  return `${tie.channel} · ${shown}${routes.length > MAX_ROUTES ? ` +${routes.length - MAX_ROUTES}` : ''}`
}

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`

export default view
