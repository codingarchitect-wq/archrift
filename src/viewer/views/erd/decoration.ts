// ERD view, part 4: the kit's diagram decoration, plus what the ERD adds on
// selection: the selected table's readers and writers for the legend, and a
// row click selecting its column where the column is a node of its own.
import { fileIdOf } from '../../../core/ids.ts'
import type { Layout } from '../../layouts/types.ts'
import type { SceneEngine } from '../../scene/engine.ts'
import { store } from '../../store.ts'
import { DiagramDecoration, diagramScenes } from '../diagram-kit/decoration.ts'
import type { Focus } from '../diagram-kit/scene.ts'
import type { ViewContext } from '../types.ts'
import type { ErdScene } from './model.ts'
import { erd, knownOr, showUses } from './state.ts'

/** The card a selection stands for: a table's node, or a column of one (`…#Account.iban`). */
export function cardFor(scene: ErdScene, selected: string | null): number | undefined {
  if (!selected) return undefined
  const direct = scene.cardOf.get(selected)
  if (direct !== undefined) return direct
  const dot = selected.lastIndexOf('.')
  return dot > selected.indexOf('#') && selected.includes('#') ? scene.cardOf.get(selected.slice(0, dot)) : undefined
}

/** A selected file (or symbol) lights the tables it queries, once its details are loaded. */
export function queriedBy(scene: ErdScene, selected: string): Focus | null {
  const file = fileIdOf(selected)
  const d = file ? store.getState().details[file] : undefined
  if (!d) return null
  const from = selected === file ? (id: string) => fileIdOf(id) === file : (id: string) => id === selected || id.startsWith(`${selected}.`)
  const cards = new Set<number>()
  for (const e of d.edges) if (e.kind === 'queries' && from(e.source)) cards.add(scene.cardOf.get(e.target) ?? -1)
  cards.delete(-1)
  return cards.size ? { card: -1, cards, links: new Set(), arcs: new Set() } : null
}

export class ErdDecoration extends DiagramDecoration {
  constructor(engine: SceneEngine) {
    super(engine, {
      cardOf: (scene, selected) => cardFor(scene as ErdScene, selected),
      focusOther: (scene, selected) => queriedBy(scene as ErdScene, selected),
      rowId: knownOr,
      stats: scene => ({ tables: scene.cards.length, foreignKeys: scene.links.length + scene.arcs.length }),
    })
  }

  update(ctx: ViewContext, layout: Layout) {
    super.update(ctx, layout)
    const scene = diagramScenes.get(layout) as ErdScene | undefined
    const card = scene ? cardFor(scene, ctx.s.selected) : undefined
    if (scene && card !== undefined) return showUses(scene.tables[card].table)
    // one of the table's readers or writers, picked from the legend, keeps the list there
    const uses = erd.getState().uses?.uses
    const file = ctx.s.selected ? fileIdOf(ctx.s.selected) : undefined
    if (!uses || ![...uses.reads, ...uses.writes, ...uses.other].some(u => u.file === file)) showUses(null)
  }

  dispose() {
    showUses(null)
    super.dispose()
  }
}
