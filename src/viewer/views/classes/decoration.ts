// Classes view, part 3: the kit's diagram decoration, told which card a
// selection stands for: a type's own, a member's type's, or (a file) the
// types it declares.
import { fileIdOf } from '../../../core/ids.ts'
import type { SceneEngine } from '../../scene/engine.ts'
import { DiagramDecoration } from '../diagram-kit/decoration.ts'
import type { Focus } from '../diagram-kit/scene.ts'
import type { ClassScene } from './model.ts'

/** The card a selection stands for: a type, or the type of a member. */
export function cardFor(scene: ClassScene, selected: string | null): number | undefined {
  if (!selected) return undefined
  return scene.cardOf.get(selected) ?? scene.memberCard.get(selected)
}

/** A selected file lights the types it declares. */
export function declaredIn(scene: ClassScene, selected: string): Focus | null {
  if (!selected.startsWith('f:')) return null
  const cards = new Set([...scene.cardOf].filter(([id]) => fileIdOf(id) === selected).map(([, i]) => i))
  return cards.size ? { card: -1, cards, links: new Set(), arcs: new Set() } : null
}

export class ClassesDecoration extends DiagramDecoration {
  constructor(engine: SceneEngine) {
    super(engine, {
      cardOf: (scene, selected) => cardFor(scene as ClassScene, selected),
      focusOther: (scene, selected) => declaredIn(scene as ClassScene, selected),
      stats: scene => {
        const links = [...scene.links, ...scene.arcs]
        const count = (end: string, dash: boolean) => links.filter(l => l.end === end && !!l.dash === dash).length
        return { types: scene.cards.length, extends: count('triangle', false), implements: count('triangle', true), associations: count('arrow', false), outside: scene.cards.filter(c => c.content.ghost).length }
      },
    })
  }
}
