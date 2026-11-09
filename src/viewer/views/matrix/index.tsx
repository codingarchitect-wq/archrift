// The Matrix view: a dependency structure matrix as a wall of green light, in
// the style of the film. Rows and columns are the visible files in layer
// order, then by folder (by group first when one is chosen); a cell lights up
// where its row depends on its column, brighter with more references, red
// where the dependency points up against the layers, in the cycle and rule
// colors where it closes an import cycle or breaks a rule. Above ~1,500 files,
// rows are folders. Digital rain falls down each column, faster where the file
// changed recently, and bursts down the columns of files saved in watch mode.
import * as THREE from 'three'
import { AREA_PALETTE } from '../../colors.ts'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { labelOf, namesKey } from '../../store.ts'
import type { ViewPlugin } from '../types.ts'
import { MatrixControls } from './controls.tsx'
import { matrixDecoration } from './decoration.ts'
import { blockAnchorId, columnAnchorId, crossingAnchorId, matrixLayout, matrixModel } from './model.ts'
import type { MatrixModel } from './model.ts'
import { selectionOf } from './selection.ts'
import './matrix.css'

const MAX_COLUMN_LABELS = 40

/** The model each layout was made from, and the colors the viewer chose for it (the column ticks mirror them). */
const models = new WeakMap<Layout, MatrixModel>()
const colorMaps = new WeakMap<Layout, Map<string, THREE.Color>>()

const matrix: ViewPlugin = {
  id: 'matrix',
  label: 'Matrix',
  description: 'Dependency matrix: a row uses the columns lit in it; red points up against the layers',
  order: 10,

  // the names are the wall's headers
  layoutKey: ctx => `${ctx.graph.key}|${ctx.s.options.layering}|${namesKey(ctx.s)}`,

  layout(ctx) {
    const nodes = [...ctx.visibility.ids].flatMap(id => ctx.world.node(id) ?? [])
    const meta = ctx.world.graph.meta
    const model = matrixModel({
      nodes,
      weight: ctx.graph.weight,
      layers: ctx.layers(),
      grouping: ctx.grouping,
      cycles: meta.cycles,
      violations: meta.violations,
      target: ctx.s.options.target,
      nameOf: id => {
        const name = labelOf(ctx.s, id, '')
        return name || undefined
      },
    })
    const layout = matrixLayout(model, 'matrix')
    models.set(layout, model)
    return layout
  },

  decoration: (ctx, engine) => matrixDecoration(ctx, engine, { model: l => models.get(l), colors: l => colorMaps.get(l) }),

  colors(ctx, layout, colors) {
    colorMaps.set(layout, colors)
    const model = models.get(layout)
    if (!model || model.depth === null) return
    // folder rows: the viewer colors files; a folder takes its area's color (its group's, colored by group)
    const area = new Map(ctx.world.areas.map((a, i) => [a.id, i]))
    const ghost = new THREE.Color(ctx.theme.background)
    const white = new THREE.Color('#ffffff')
    const sel = selectionOf(ctx.s, ctx.world, model, ctx.grouping?.groupOf)
    model.units.forEach((u, i) => {
      if (u.kind !== 'folder') return
      const index = ctx.s.options.colorBy === 'group' && u.group !== undefined ? u.group : (area.get(ctx.world.areaOf.get(u.files[0]) ?? '') ?? 0)
      const c = new THREE.Color(AREA_PALETTE[index % AREA_PALETTE.length])
      if (sel && !sel.related.has(i)) c.lerp(ghost, 0.8)
      if (sel?.row === i) c.lerp(white, 0.45)
      colors.set(u.id, c)
    })
  },

  labels(ctx, layout) {
    const model = models.get(layout)
    if (!model) return []
    const specs: LabelSpec[] = model.blocks.map((b, i) => ({ id: blockAnchorId(i), text: b.label, priority: 900, className: 'matrix-block' }))
    const sel = selectionOf(ctx.s, ctx.world, model, ctx.grouping?.groupOf)
    if (sel?.row === undefined) return specs
    const row = sel.row
    const unit = model.units[row]
    // its column, and the columns of what it uses (strongest first): the row's lit cells
    specs.push({ id: columnAnchorId(unit.id), text: unit.name, priority: 990, className: 'selected matrix-col' })
    specs.push({ id: crossingAnchorId(unit.id), text: unit.name, priority: 995, className: 'selected matrix-crossing' })
    const weightTo = (col: number) => model.cells[model.cellAt.get(row * model.units.length + col)!].weight
    const uses = [...model.uses[row]].sort((a, b) => weightTo(b) - weightTo(a) || a - b).slice(0, MAX_COLUMN_LABELS)
    uses.forEach((col, k) => specs.push({ id: columnAnchorId(model.units[col].id), text: model.units[col].name, priority: 590 - k / 100, className: 'neighbor matrix-col' }))
    // rows the viewer can't label itself: a file selected inside a folder row, and folder rows' neighbors
    if (ctx.s.selected !== unit.id) specs.push({ id: unit.id, text: unit.name, priority: 1000, className: 'selected' })
    if (model.depth !== null)
      for (const r of new Set([...model.uses[row], ...model.usedBy[row]])) specs.push({ id: model.units[r].id, text: model.units[r].name, priority: 600, className: 'neighbor' })
    return specs
  },

  Controls: MatrixControls,
}

export default matrix
