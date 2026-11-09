// Risks view: the register and matrix a layout was made from (kept by layout,
// so colors, labels and the decoration read them without recomputing), the
// model cached per graph, and what a selection relates to.
import { fileIdOf } from '../../../core/ids.ts'
import type { GraphNode } from '../../../core/model.ts'
import type { Layout } from '../../layouts/types.ts'
import { labelOf, namesKey } from '../../store.ts'
import type { World } from '../../world.ts'
import type { ViewContext } from '../types.ts'
import { boardSize, matrixGeometry, rail } from './layout.ts'
import type { MatrixGeometry, RailStop } from './layout.ts'
import { riskModel } from './model.ts'
import type { RiskModel } from './model.ts'
import { fileLabel } from './names.ts'

export interface RiskMap {
  model: RiskModel
  geometry: MatrixGeometry
  /** The board's heading: what the matrix found, in a line. */
  heading: string
  /** The highest risks, named on a rail beside the matrix, and their names there. */
  rail: RailStop[]
  railText: Map<string, string>
}

/** How many of the highest risks are ranked on the matrix. */
export const RANKED = 10

export const maps = new WeakMap<Layout, RiskMap>()

let cached: { world: World; key: string; map: RiskMap } | undefined

/** Files the matrix rates: shown, and neither tests nor assets. */
export const rated = (n: GraphNode) => n.kind === 'file' && !n.tags?.includes('test') && !n.tags?.includes('asset')

export function riskMapOf(ctx: ViewContext): RiskMap {
  const key = `${ctx.graph.key}|${namesKey(ctx.s)}`
  if (cached?.world === ctx.world && cached.key === key) return cached.map
  const meta = ctx.world.graph.meta
  const files = [...ctx.visibility.ids].flatMap(id => {
    const n = id.startsWith('f:') ? ctx.world.node(id) : undefined
    return n && rated(n) ? [n] : []
  })
  const history = !!meta.history
  const model = riskModel({
    files,
    dependents: ctx.graph.in,
    history,
    cycles: meta.cycles,
    violations: meta.violations ?? [],
    coChanges: history ? id => ctx.world.coChanges(id) : undefined,
  })
  const geometry = matrixGeometry(model)
  const map: RiskMap = { model, geometry, heading: headingOf(model, meta.violations ?? []), rail: [], railText: new Map() }
  for (const f of model.files.slice(0, RANKED)) map.railText.set(f.id, `#${f.rank} ${labelOf(ctx.s, f.id, fileLabel(ctx.world.node(f.id) ?? { name: f.id }))}`)
  map.rail = rail(model, geometry, RANKED, id => map.railText.get(id) ?? id, boardSize(geometry))
  cached = { world: ctx.world, key, map }
  return map
}

function headingOf(model: RiskModel, violations: readonly { severity: string }[]): string {
  const parts = [plural(model.high, 'high risk')]
  if (model.debtCounts.cycle) parts.push(`${model.debtCounts.cycle} in import cycles`)
  const errors = violations.filter(v => v.severity === 'error').length
  const warnings = violations.length - errors
  if (errors) parts.push(plural(errors, 'rule error'))
  if (warnings) parts.push(plural(warnings, 'rule warning'))
  if (model.debtCounts.coupling) parts.push(`${model.debtCounts.coupling} hidden couplings`)
  if (model.debtCounts.untested) parts.push(`${model.debtCounts.untested} untested`)
  return parts.join(' · ')
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

/**
 * What a selection relates to on the matrix: a file and everything that
 * depends on it (what breaks with it), a folder's files, a symbol's file.
 * Null when nothing on the matrix is selected.
 */
export function relatedOf(ctx: ViewContext, map: RiskMap): Set<string> | null {
  const sel = ctx.s.selected
  if (!sel) return null
  const file = fileIdOf(sel)
  if (file && map.model.byId.has(file)) {
    const seen = new Set([file])
    const queue = [file]
    while (queue.length) {
      const id = queue.pop()!
      for (const d of ctx.graph.in.get(id) ?? [])
        if (!seen.has(d) && map.model.byId.has(d)) {
          seen.add(d)
          queue.push(d)
        }
    }
    return seen
  }
  const node = ctx.world.node(sel)
  if (node?.kind === 'directory') {
    const prefix = node.path ? `f:${node.path}/` : 'f:'
    const inside = new Set(map.model.files.filter(f => f.id.startsWith(prefix)).map(f => f.id))
    return inside.size ? inside : null
  }
  return null
}
