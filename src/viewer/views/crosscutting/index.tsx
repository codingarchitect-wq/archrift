// arc42 §8 Crosscutting Concepts (a view plug-in): concerns many building
// blocks share, drawn literally cutting across them. The top-level blocks
// stand as pillars in an arc; each candidate concept (code used by many of
// them: translations, validation, auth …) is a band at its own height,
// collaring the pillars that use it and sleeved where its code lives. The
// candidates come from how widely code is used; their names are suggestions,
// as questions (model.ts).
import { emptyLayout } from '../../layouts/types.ts'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { namesKey } from '../../store.ts'
import { anchor, stand } from '../arc42-kit/anchors.ts'
import { blockName } from '../arc42-kit/blocks.ts'
import { ON_BOARD } from '../arc42-kit/board.ts'
import { Arc42Legend, Swatch } from '../arc42-kit/Legend.tsx'
import { ARC42, SECTIONS } from '../arc42-kit/sections.ts'
import type { ViewPlugin } from '../types.ts'
import { CrosscuttingDecoration } from './decoration.ts'
import { arrange } from './layout.ts'
import { crosscuttingModel } from './model.ts'
import { BAND, isLit, litBy, scenes } from './scene.ts'

const PAD = 4

/** What the pillars are, by the toolbar's group option: one, several. */
const BLOCKS_BY: Record<string, [string, string]> = {
  directory: ['building block', 'building blocks'],
  feature: ['feature', 'features'],
  community: ['detected module', 'detected modules'],
  layer: ['layer', 'layers'],
  custom: ['group', 'groups'],
}

const view: ViewPlugin = {
  id: 'crosscutting',
  label: SECTIONS.crosscutting.label,
  description: 'arc42 §8: concept candidates as bands cutting across the building blocks that use them',
  order: SECTIONS.crosscutting.order,
  group: ARC42,
  // the bands are the view: no edges to choose
  edges: false,

  // the pillars' names set how they stagger
  layoutKey: ctx => `${ctx.graph.key}|${ctx.s.options.layering}|${namesKey(ctx.s)}`,

  layout(ctx) {
    const layers = ctx.layers()
    const found = crosscuttingModel({
      world: ctx.world,
      // production code only: tests use everything, and aren't a building block of the system
      isShown: n => ctx.visibility.ids.has(n.id) && !n.tags?.includes('test'),
      in: ctx.graph.in,
      weight: ctx.graph.weight,
      order: layers.order,
      layerOf: layers.layerOf,
      grouping: ctx.grouping,
    })
    const model = { ...found, blocks: found.blocks.map(b => ({ ...b, name: blockName(ctx.s, b) })) }
    const a = arrange(model)
    const out: Layout = {
      ...emptyLayout(),
      view: 'crosscutting',
      size: a.size,
      shape: 'box',
      arcAnchor: 'roof',
      ground: true,
      hideBoxes: true,
      arcs: 'none',
      openFile: 'none',
      keepView: true,
      // from the front, a little above: the pillars upright, the bands one above the other
      home: [0, 0.4, 0.92],
      center: [...a.center],
    }
    // pillars: boxes the engine frames and flies to (the drawing does the picking). Bands get none: the engine
    // would label a selected pillar's neighbors in the middle of their bands; a band shows its selection itself.
    a.pillars.forEach(p => stand(out, p.id, { x: p.x, y: 0, z: p.z, w: p.side, h: p.h, d: p.side }))
    // label places: above the left end (the board's far corner hides behind the pillars), pillar feet (every
    // other one a row nearer, on a leader), a band's name past its right end and its note before its left end
    const left = a.board.u - a.board.w / 2 + PAD
    const z0 = a.pillars[0]?.z ?? 0
    // the caption a line above the heading: a line is about the same share of the view at any size
    anchor(out, 'cc:caption', [left, a.height + 3.5 + Math.max(2, a.size * 0.026), z0])
    anchor(out, 'cc:heading', [left, a.height + 3.5, z0])
    a.pillars.forEach(p => anchor(out, `cc:pillar:${a.pillars.indexOf(p)}`, [p.x, ON_BOARD, p.nameZ], 1))
    a.bands.forEach((b, k) => {
      anchor(out, `cc:band:${k}`, b.label)
      anchor(out, `cc:note:${k}`, b.note)
    })
    if (!model.candidates.length) anchor(out, 'cc:empty', [a.board.u, a.height * 0.55, a.pillars.length ? a.pillars[0].z + 6 : 0])
    scenes.set(out, { model, arrangement: a })
    return out
  },

  decoration: () => new CrosscuttingDecoration(),

  labels(ctx, layout) {
    const scene = scenes.get(layout)
    if (!scene) return []
    const { model } = scene
    const lit = litBy(scene, ctx.world, ctx.s.selected)
    const blocks = model.blocks.length
    const noun = BLOCKS_BY[ctx.grouping ? ctx.s.options.groupBy : 'directory'] ?? BLOCKS_BY.directory
    const specs: LabelSpec[] = [
      { id: 'cc:caption', text: `arc42 §${SECTIONS.crosscutting.number} · ${SECTIONS.crosscutting.title}`, priority: 995, className: 'a42-title a42-left' },
      {
        id: 'cc:heading',
        text: `${model.candidates.length} concept candidate${model.candidates.length === 1 ? '' : 's'} across ${blocks} ${blocks === 1 ? noun[0] : noun[1]}`,
        priority: 994,
        className: 'a42-heading a42-left',
      },
    ]
    if (!model.candidates.length)
      specs.push({
        id: 'cc:empty',
        text: blocks < 3 ? 'Too few building blocks for anything to cut across them' : `No crosscutting candidates: no code is used by ${model.threshold} or more of the other blocks`,
        priority: 990,
        className: 'a42-pill cc-empty',
      })
    model.blocks.forEach((b, i) => {
      const dim = isLit(lit, i) ? '' : ' a42-dim'
      specs.push({ id: `cc:pillar:${i}`, text: b.name, priority: 800 - i / 100, className: `a42-name cc-pillar${dim}` })
    })
    model.candidates.forEach((c, k) => {
      const dim = isLit(lit, BAND + k) ? '' : ' a42-dim'
      const where = c.members.length === 1 ? c.members[0].path : `${c.members[0].path} +${c.members.length - 1}`
      const on = lit?.bands.has(k) ? ' cc-on' : ''
      specs.push({ id: `cc:band:${k}`, text: c.name, priority: 900 - k / 100, className: `a42-left cc-band cc${k}${on}${dim}` })
      specs.push({ id: `cc:note:${k}`, text: `${where} · used by ${c.breadth} of ${blocks} blocks`, priority: 700 - k / 100, className: `a42-small cc-note${dim}` })
    })
    return specs
  },

  Legend: () => (
    <Arc42Legend section="crosscutting">
      <Swatch color="var(--accent)" shape="line">
        band: a concept candidate
      </Swatch>
      <Swatch color="var(--accent)">collar: a block uses it (thicker: more)</Swatch>
      <Swatch color="color-mix(in srgb, var(--accent) 70%, var(--text))">sleeve: where its code lives</Swatch>
      <Swatch color="var(--muted)" shape="dashed">
        faint: passes blocks that don’t use it
      </Swatch>
    </Arc42Legend>
  ),
}

export default view
