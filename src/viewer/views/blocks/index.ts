// arc42 §5, the Building Block View (a view plug-in in the arc42 menu): the
// system's white box as a diagram of its top-level blocks, sized by their
// code, in rows by layer, with the dependencies between them routed as an
// architect would draw them and each block's provided interface as a
// lollipop. Selecting a block opens its white box (its subfolders, its own
// files) floating above and behind, an exploded view, one more level down
// along the selection's folders; its neighbors wait at the edge as stubs.
import type { GraphNode } from '../../../core/model.ts'
import { NO_FEATURE_GROUP, SHARED_GROUP } from '../../groups.ts'
import { emptyLayout } from '../../layouts/types.ts'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import type { World } from '../../world.ts'
import { anchor, stand } from '../arc42-kit/anchors.ts'
import { ON_BOARD } from '../arc42-kit/board.ts'
import { levelOneBlocks } from '../arc42-kit/blocks.ts'
import type { BlockGrouping, TopBlocks } from '../arc42-kit/blocks.ts'
import { ARC42, SECTIONS } from '../arc42-kit/sections.ts'
import type { ViewPlugin } from '../types.ts'
import { Legend } from './Controls.tsx'
import { BlocksDecoration, scenes } from './decoration.ts'
import { buildModel, chainKey, focusOf } from './model.ts'
import type { Unit } from './model.ts'
import { DEFAULT_SCREEN, HOME, compose, framing } from './scene.ts'
import type { LinkMode, Screen } from './scene.ts'
import type { Board } from './scene.ts'
import { publish } from './settings.ts'
import { labelOf } from '../../store.ts'

let cachedTop: { world: World; key: string; top: TopBlocks } | undefined
/** The top-level blocks of the files shown, folders or the toolbar's groups (cached per graph, filters and grouping). */
function topOf(world: World, key: string, visible: ReadonlySet<string>, grouping: (BlockGrouping & { key: string }) | null) {
  const k = `${key}|${grouping?.key ?? 'dirs'}`
  if (cachedTop?.world !== world || cachedTop.key !== k) cachedTop = { world, key: k, top: levelOneBlocks(world, (n: GraphNode) => visible.has(n.id), grouping) }
  return cachedTop.top
}

/** The level-1 block whose white box was open last: a folder selected inside it keeps it open when grouped. */
let opened: string | undefined

/** A feature group's tier on level 1: the features, then the shared code; the files without a feature have none (a last row). */
const featureTier = (id: string) => (id === NO_FEATURE_GROUP ? undefined : id.startsWith(SHARED_GROUP) ? 1 : 0)

/** The toolbar's edges option → the dependencies a board draws. */
const MODES: Record<string, LinkMode> = { auto: 'main', all: 'all', selection: 'selection', violations: 'violations', none: 'none' }

/** File dependencies that break a rule in a target: each violation's pair, or each step of its path (cached per graph and target). */
let violatingCache: { world: World; target: string; test: (from: string, to: string) => boolean } | undefined
function violatingIn(world: World, target: string) {
  if (violatingCache?.world === world && violatingCache.target === target) return violatingCache.test
  const steps = new Set<string>()
  for (const v of world.graph.meta.violations ?? []) {
    if (!v.targets.includes(target)) continue
    const on = v.path ?? [v.from, v.to]
    for (let i = 1; i < on.length; i++) steps.add(`${on[i - 1]}\u0000${on[i]}`)
  }
  const test = (from: string, to: string) => steps.has(`${from}\u0000${to}`)
  violatingCache = { world, target, test }
  return test
}

/** What level 1's groups are, by the toolbar's group option. */
const GROUPED_BY: Record<string, string> = { feature: 'feature', community: 'detected module', layer: 'layer', custom: 'configured group' }

/** Where a board's caption and heading go: its top-left corner. */
const PAD = 3

const view: ViewPlugin = {
  id: 'blocks',
  label: SECTIONS.blocks.label,
  description: 'arc42 §5: the top-level blocks and their dependencies; selecting one opens its white box above',
  order: SECTIONS.blocks.order,
  group: ARC42,

  layoutKey: ctx =>
    `${ctx.graph.key}|${ctx.s.options.layering}|${ctx.s.options.edges}|${ctx.s.options.edges === 'selection' ? ctx.s.selected : ''}|${chainKey(ctx.world, topOf(ctx.world, ctx.visibility.key, ctx.visibility.ids, ctx.grouping), ctx.s.selected, opened)}`,

  layout(ctx) {
    const layers = ctx.layers()
    const model = buildModel({
      world: ctx.world,
      visible: ctx.visibility.ids,
      weight: ctx.graph.weight,
      incoming: ctx.graph.in,
      layers: { order: layers.order, layerOf: layers.layerOf },
      grouping: ctx.grouping,
      previous: opened,
      by: ctx.grouping ? GROUPED_BY[ctx.s.options.groupBy] : undefined,
      // features cut across the layers: they stand above the shared code, which shouldn't use them
      tierOf: ctx.s.options.groupBy === 'feature' && ctx.grouping ? featureTier : undefined,
      violating: violatingIn(ctx.world, ctx.s.options.target),
      selected: ctx.s.selected,
    })
    if (model.levels[1]) opened = model.levels[0].units[model.levels[1].opened!].id
    const mode = MODES[ctx.s.options.edges] ?? 'main'
    const focus = focusOf(model.levels, ctx.world, ctx.s.selected)
    const scene = compose(model, mode, focus)
    // the deepest two boards: with three open, level 1 shows below, cut off; the inspector is open while a white box is
    const frame = framing(scene.boards.slice(-2), screenNow(scene.boards.length > 1))
    const out: Layout = {
      ...emptyLayout(),
      view: 'blocks',
      size: frame.size,
      shape: 'box',
      arcAnchor: 'roof',
      ground: true,
      hideBoxes: true,
      arcs: 'none',
      openFile: 'none',
      keepView: true,
      home: HOME,
      center: frame.center,
    }
    scene.boards.forEach((b, k) => {
      const lv = b.level
      anchor(out, `blocks:caption:${k}`, [b.x - b.w / 2 + PAD, b.y + ON_BOARD, b.z - b.d / 2 + PAD])
      anchor(out, `blocks:heading:${k}`, [b.x - b.w / 2 + PAD, b.y + ON_BOARD, b.z - b.d / 2 + PAD + 6.5])
      b.diagram.boxes.forEach((box, i) => {
        const x = b.x - b.w / 2 + box.u
        const z = b.z - b.d / 2 + box.v
        const unit = i < lv.units.length
        const id = unit ? lv.units[i].select : lv.stubs[i - lv.units.length].id
        const top = b.y + ON_BOARD + b.heights[i]
        stand(out, id, { x, y: b.y + ON_BOARD, z, w: box.w, h: Math.max(0.3, b.heights[i]), d: box.h })
        if (unit) {
          // the name just above the middle, what it holds below (a label stands on its anchor)
          anchor(out, `blocks:name:${id}`, [x, top, z + 0.6], box.w)
          anchor(out, `blocks:note:${id}`, [x, top, z + Math.min(4.2, box.h / 2 - 0.4)], box.w)
          // the selected block's note goes under it, clear of the selection's name on top
          anchor(out, `blocks:under:${id}`, [x, b.y + ON_BOARD, z + box.h / 2 + 3.8], box.w)
        } else anchor(out, `blocks:stub:${id}`, [x, b.y + ON_BOARD, z], box.w)
      })
      if (lv.moreStubs) anchor(out, `blocks:more:${k}`, [b.x + b.w / 2 - PAD, b.y + ON_BOARD, b.z + b.d / 2 - PAD])
    })
    scenes.set(out, { scene, chain: chainKey(ctx.world, topOf(ctx.world, ctx.visibility.key, ctx.visibility.ids, ctx.grouping), ctx.s.selected, opened) })
    const deepest = scene.boards[scene.boards.length - 1]
    publish({
      title: deepest.level.title,
      levels: scene.boards.length,
      blocks: deepest.level.units.length,
      links: deepest.level.links.length,
      shown: deepest.shown.length,
      up: deepest.shown.filter(i => deepest.level.links[i].up).length,
      upMeans: ctx.s.options.groupBy === 'feature' && ctx.grouping && scene.boards.length === 1 ? 'shared code using a feature' : 'points up, against the layers',
      mode,
      focused: focus[focus.length - 1] !== undefined,
    })
    return out
  },

  decoration: (_ctx, engine) => new BlocksDecoration(engine),

  labels(ctx, layout) {
    const made = scenes.get(layout)
    if (!made) return []
    const boards = made.scene.boards
    const focus = focusOf(
      boards.map(b => b.level),
      ctx.world,
      ctx.s.selected,
    )
    const specs: LabelSpec[] = []
    boards.forEach((b, k) => {
      // the deepest board is what the reader looks at: its labels first
      const base = 900 - (boards.length - 1 - k) * 150
      const lv = b.level
      specs.push({ id: `blocks:caption:${k}`, text: k === 0 ? `arc42 §${SECTIONS.blocks.number} · ${SECTIONS.blocks.title}` : `white box of ${boards[k - 1].level.units[lv.opened!].name}`, priority: 980 - k, className: 'a42-title a42-left' })
      specs.push({ id: `blocks:heading:${k}`, text: lv.title, priority: 990 - k, className: 'a42-heading a42-left' })
      const lit = related(b, focus[k])
      const n = lv.units.length
      lv.units.forEach((u, i) => {
        const dim = lit && !lit.has(i) ? ' a42-dim' : ''
        const size = Math.min(40, Math.sqrt(u.loc) / 5)
        specs.push({ id: `blocks:name:${u.select}`, text: labelOf(ctx.s, u.select, u.name, u.kind === 'files'), priority: base + size + (focus[k] === i ? 50 : 0), className: `a42-name${dim}` })
        // the block in focus also says how wide its provided interface is
        const focused = focus[k] === i
        const note = focused && u.provided ? `${noteOf(u)} · ${u.provided} used outside` : noteOf(u)
        if (focused) specs.push({ id: `blocks:under:${u.select}`, text: note, priority: base + 80, className: 'a42-small a42-pill' })
        // only where the block is wide enough on screen to hold its name: a note under a name that didn't fit says nothing
        else specs.push({ id: `blocks:note:${u.select}`, text: note, priority: base - 250 + size, className: `a42-small${dim}`, minScreenWidth: Math.max(70, u.name.length * 7 + 12) })
      })
      lv.stubs.forEach((s, i) => {
        const dim = lit && !lit.has(n + i) ? ' a42-dim' : ''
        specs.push({ id: `blocks:stub:${s.id}`, text: s.name, priority: base - 100, className: `a42-small blk-stub${dim}` })
      })
      if (lv.moreStubs) specs.push({ id: `blocks:more:${k}`, text: `+${lv.moreStubs} more neighbors`, priority: base - 300, className: 'a42-small' })
    })
    return specs
  },

  Legend,
}

/** The window's shape and what covers it (the inspector, 412 px wide, while something is selected). */
function screenNow(inspector: boolean): Screen {
  if (typeof innerWidth !== 'number' || !innerWidth || !innerHeight) return { ...DEFAULT_SCREEN, right: inspector ? 0.26 : 0 }
  return { aspect: innerWidth / innerHeight, top: Math.min(0.3, 165 / innerHeight), bottom: Math.min(0.3, 160 / innerHeight), right: inspector && innerWidth > 760 ? 412 / innerWidth : 0 }
}

/** The units (stubs after them) the focus of a board is linked to, or null when nothing on it is in focus. */
function related(b: Board, focus: number | undefined): Set<number> | null {
  if (focus === undefined) return null
  const out = new Set([focus])
  for (const i of b.shown) {
    const l = b.level.links[i]
    if (l.from === focus) out.add(l.to)
    else if (l.to === focus) out.add(l.from)
  }
  return out
}

/** Under a block's name: what it holds. */
export function noteOf(u: Unit): string {
  const lines = u.loc >= 1000 ? `${(u.loc / 1000).toFixed(1)}k lines` : `${u.loc} lines`
  if (u.kind === 'file') return lines
  const files = `${u.files.length} file${u.files.length === 1 ? '' : 's'}`
  if (u.kind === 'files') return `own files · ${files}`
  return `${files} · ${lines}`
}

export default view
