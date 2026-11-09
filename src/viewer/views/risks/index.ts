// Risks (arc42 §11, Risks and Technical Debt): the classic 5 × 5 risk
// matrix, made 3D where it carries meaning. Every file stands as a tower in
// its cell: likelihood of change left to right, impact (what depends on it)
// from front to back. Cells are plinths as high as their risk, so the matrix
// rises to the high-risk corner at the back right, rimmed in dashed red. A
// tower is as tall as the file is complex, colored by its risk, and ringed by
// the debt it carries (an import cycle, a broken rule, hidden coupling, no
// tests, complexity among the highest). The ten highest risks are named on a
// rail beside the matrix; the toolbar's register lists every file by
// priority. Selecting a file keeps it and everything that depends on it bright.
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { namesKey } from '../../store.ts'
import { anchor } from '../arc42-kit/anchors.ts'
import { ON_BOARD } from '../arc42-kit/board.ts'
import { fade, inkOf } from '../arc42-kit/ink.ts'
import { ARC42, SECTIONS } from '../arc42-kit/sections.ts'
import type { ViewPlugin } from '../types.ts'
import { towerColor } from './colors.ts'
import { Controls } from './Controls.tsx'
import { DIM, RisksDecoration } from './decoration.ts'
import { axisGap, boardRect, gridToWorld, spanOf, underAxis, zoneOutline } from './layout.ts'
import { Legend } from './Legend.tsx'
import { maps, relatedOf, riskMapOf } from './map.ts'
import { HIGH, stepRange } from './model.ts'
import { publish } from './register.ts'
import './risks.css'

const STEP_NAMES = ['none', 'low', 'medium', 'high', 'very high']
const UNITS = { churn: 'lines changed', commits: 'commits', proxy: 'complexity × uses' }

const risks: ViewPlugin = {
  id: 'risks',
  label: SECTIONS.risks.label,
  description: 'arc42 §11: a 5 × 5 risk matrix (how often files change × what depends on them), towers ringed by the debt they carry',
  order: SECTIONS.risks.order,
  group: ARC42,
  // a risk matrix draws no dependencies
  edges: false,
  // a risk is a file's: grouping has nothing to change
  groupBy: false,

  // the register's names set where its rail runs
  layoutKey: ctx => `${ctx.graph.key}|${ctx.world.graph.meta.history ? 'history' : ''}|${namesKey(ctx.s)}`,

  layout(ctx) {
    const map = riskMapOf(ctx)
    publish(map.model, ctx.world.graph.meta.history?.windowDays ?? 90, id => {
      const n = ctx.world.node(id)
      const path = n?.path ?? id
      return { name: n?.name ?? id, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }
    })
    const g = map.geometry
    const rect = boardRect(g)
    const out: Layout = {
      view: 'risks',
      size: Math.max(rect.w, rect.h),
      boxes: new Map(),
      placement: new Map(),
      depth: new Map(),
      shape: 'box',
      arcAnchor: 'roof',
      ground: true,
      arcs: 'none',
      openFile: 'none',
      keepView: true,
      // from the front, high enough to see into every cell
      home: [0, 0.84, 0.68],
      center: [rect.u, 0, rect.v + rect.h * 0.1],
    }
    for (const [id, box] of g.towers) {
      out.boxes.set(id, box)
      out.placement.set(id, 'building')
    }
    // labels: the caption and heading in the board's corner, the scales, the axes, the counts, the hot corner, the ranks
    const span = spanOf(g)
    const pad = span * 0.022
    const left = rect.u - rect.w / 2 + pad
    const top = rect.v - rect.h / 2 + pad
    anchor(out, 'risks:caption', [left, ON_BOARD, top])
    anchor(out, 'risks:heading', [left, ON_BOARD, top + span * 0.075])
    const gap = axisGap(g)
    const under = g.front + gap + underAxis(g)
    for (let step = 1; step <= 5; step++) {
      const col = g.cells[step - 1]
      anchor(out, `risks:col:${step}`, [col.x, ON_BOARD, under], g.cellSize)
      const row = g.cells[(step - 1) * 5]
      anchor(out, `risks:row:${step}`, [g.left - gap * 2.5, ON_BOARD, row.z], g.cellSize)
    }
    anchor(out, 'risks:xaxis', [(g.left + g.right) / 2, ON_BOARD, under + span * 0.045])
    anchor(out, 'risks:yaxis', [g.left - gap, ON_BOARD, g.back - span * 0.014])
    g.cells.forEach((c, i) => anchor(out, `risks:count:${i}`, [c.x + c.size / 2 - 2.4, c.top, c.z + c.size / 2 - 1.3], c.size))
    const zone = zoneOutline()
    if (zone.length) {
      const [x, z] = gridToWorld(g, zone[0][0], zone[0][1])
      anchor(out, 'risks:zone', [x + span * 0.05, ON_BOARD, z - span * 0.012 - 0.4])
    }
    for (const stop of map.rail) anchor(out, `risks:rank:${stop.id}`, stop.label)
    maps.set(out, map)
    return out
  },

  decoration: () => new RisksDecoration(),

  colors(ctx, layout, colors) {
    const map = maps.get(layout)
    if (!map) return
    const ink = inkOf(ctx.theme)
    const related = relatedOf(ctx, map)
    for (const f of map.model.files) {
      const c = towerColor(ink, f.risk)
      colors.set(f.id, related && !related.has(f.id) ? fade(c, ink, DIM) : c)
    }
  },

  labels(ctx, layout) {
    const map = maps.get(layout)
    if (!map) return []
    const { model, geometry: g } = map
    const related = relatedOf(ctx, map)
    const specs: LabelSpec[] = [
      { id: 'risks:caption', text: `arc42 §${SECTIONS.risks.number} · ${SECTIONS.risks.title}`, priority: 990, className: 'a42-title a42-left' },
      { id: 'risks:heading', text: map.heading, priority: 995, className: 'a42-heading a42-left' },
      { id: 'risks:xaxis', text: `likelihood of change: ${UNITS[model.measure]} →`, priority: 970, className: 'a42-name' },
      { id: 'risks:yaxis', text: '↑ impact: files that depend on it', priority: 970, className: 'a42-name' },
    ]
    if (layout.boxes.has('risks:zone')) specs.push({ id: 'risks:zone', text: 'high risk', priority: 960, className: 'risks-zone' })
    for (let step = 1; step <= 5; step++) {
      const col = step === 1 ? (model.measure === 'proxy' ? 'none' : 'unchanged') : `${STEP_NAMES[step - 1]} · ${stepRange(step, model.likelihoodSteps)}`
      specs.push({ id: `risks:col:${step}`, text: col, priority: 950, className: 'a42-name' })
      const row = step === 1 ? 'nothing depends on it' : `${STEP_NAMES[step - 1]} · ${stepRange(step, model.impactSteps)}`
      specs.push({ id: `risks:row:${step}`, text: row, priority: 950, className: 'a42-name risks-right' })
    }
    g.cells.forEach((c, i) => {
      if (!c.files.length) return
      const dim = related && !c.files.some(f => related.has(f)) ? ' a42-dim' : ''
      specs.push({ id: `risks:count:${i}`, text: String(c.files.length), priority: 500, className: `a42-small${dim}`, minScreenWidth: 40 })
    })
    for (const { id } of map.rail) {
      const f = model.byId.get(id)!
      const dim = related && !related.has(id) ? ' a42-dim' : ''
      specs.push({ id: `risks:rank:${id}`, text: map.railText.get(id)!, priority: 900 - f.rank, className: `a42-pill risks-rank${f.risk >= HIGH ? ' high' : ''}${dim}` })
    }
    return specs
  },

  Controls,
  Legend,
}

export default risks
