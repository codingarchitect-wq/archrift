// What the selection means on the matrix: one row and column (a file, a
// folder row, or the row a file or symbol belongs to), or a set of rows (an
// import cycle, a rule violation, a detected module or layer, a folder whose
// files are rows of their own).
import { fileIdOf } from '../../../core/ids.ts'
import { isGroupId } from '../../groups.ts'
import type { State } from '../../store.ts'
import type { World } from '../../world.ts'
import type { MatrixModel } from './model.ts'

export interface MatrixSelection {
  /** The selected row (= column), when the selection is one. */
  row?: number
  /** Rows to keep bright: the row's neighbors, or the set's members. */
  related: Set<number>
}

export function selectionOf(
  s: Pick<State, 'selected'>,
  world: World,
  model: MatrixModel,
  groupOf?: (fileId: string) => string | undefined,
): MatrixSelection | null {
  const sel = s.selected
  if (!sel) return null
  const rows = (ids: Iterable<string>) => {
    const out = new Set<number>()
    for (const id of ids) {
      const row = model.rowOf(id)
      if (row !== undefined) out.add(row)
    }
    return out
  }
  if (sel.startsWith('cycle:')) return { related: rows(world.graph.meta.cycles[Number(sel.slice(6))] ?? []) }
  if (sel.startsWith('violation:')) {
    const v = world.graph.meta.violations?.[Number(sel.slice(10))]
    return v ? { related: rows(v.path ?? [v.from, v.to]) } : null
  }
  if (isGroupId(sel)) {
    const members = model.units.flatMap(u => u.files).filter(f => groupOf?.(f) === sel)
    return { related: rows(members) }
  }
  const direct = model.index.get(sel) ?? model.rowOf(fileIdOf(sel) ?? sel)
  if (direct !== undefined) return { row: direct, related: new Set([direct, ...model.uses[direct], ...model.usedBy[direct]]) }
  // a folder shown as its files
  if (world.node(sel)?.kind === 'directory') {
    const related = rows(world.index.descendants(sel).map(n => n.id))
    return related.size ? { related } : null
  }
  return null
}
