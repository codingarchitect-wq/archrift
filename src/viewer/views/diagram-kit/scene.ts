// Diagram kit: what a diagram view hands the kit to draw. Boards on the
// floor, cards on them (laid out, their rows chosen), connectors between
// cards with marks at their ends, and connectors drawn only while one of
// their ends is selected (those to a card nearly everything references,
// which would otherwise cover the board). Plain data: the views' models make
// it, decoration.ts draws it.
import type { CardContent, CardShape } from './card.ts'

/** A connector's end: UML's hollow triangle (a generalization) or open arrow; crow's-foot marks (exactly one, zero or one, zero or many, one). */
export type EndMark = 'none' | 'triangle' | 'arrow' | 'one' | 'bar' | 'bar-ring' | 'crow-ring'

/** The room a board keeps above its cards for its caption and heading. */
export const BOARD_HEAD = 11

export interface SceneBoard {
  /** Top-left corner on the floor, and size. */
  u: number
  v: number
  w: number
  h: number
  /** Small, in its corner ("Diagram · Tables"), and the heading under it. */
  caption: string
  heading: string
}

export interface PlacedCard {
  content: CardContent
  /** As laid out: the rows shown. */
  shape: CardShape
  /** Every row, when the card shows fewer: what it opens to while selected. */
  full?: CardShape
  /** Top-left corner. */
  u: number
  v: number
  /** The title band's tone (a light tint of it is drawn). */
  band: string
  /** The board it's on. */
  board: number
}

export interface SceneLink {
  /** The cards it joins (relatedness and dimming). */
  from: number
  to: number
  /** On the floor, from `from` to `to`. */
  points: [number, number][]
  dash?: boolean
  start: EndMark
  end: EndMark
  /** A name along it (an association's property). */
  label?: string
}

/** A connector drawn only while one of its ends is selected: an arc over the board. */
export interface SceneArc {
  from: number
  to: number
  /** Where it leaves and meets the cards, down from their tops. */
  fromAt: number
  toAt: number
  start: EndMark
  end: EndMark
  dash?: boolean
}

export interface DiagramScene {
  boards: SceneBoard[]
  cards: PlacedCard[]
  links: SceneLink[]
  arcs: SceneArc[]
}

/** The cards and connectors tied to a selected card (null: nothing selected, all bright). */
export interface Focus {
  /** The selected card, or -1 when the selection lights cards without being one (a file and the tables it queries). */
  card: number
  cards: Set<number>
  links: Set<number>
  arcs: Set<number>
}

/** What the selection lights: the card, the cards it's joined to and the connectors between them. */
export function focusOn(scene: DiagramScene, card: number | undefined): Focus | null {
  if (card === undefined || card < 0) return null
  const focus: Focus = { card, cards: new Set([card]), links: new Set(), arcs: new Set() }
  const take = (set: Set<number>, list: readonly { from: number; to: number }[]) =>
    list.forEach((l, k) => {
      if (l.from !== card && l.to !== card) return
      set.add(k)
      focus.cards.add(l.from).add(l.to)
    })
  take(focus.links, scene.links)
  take(focus.arcs, scene.arcs)
  return focus
}

/** The board's extent holding every board: for the camera. */
export function extentOf(scene: DiagramScene): { u0: number; v0: number; u1: number; v1: number } {
  const b = scene.boards
  if (!b.length) return { u0: -10, v0: -10, u1: 10, v1: 10 }
  return {
    u0: Math.min(...b.map(x => x.u)),
    v0: Math.min(...b.map(x => x.v)),
    u1: Math.max(...b.map(x => x.u + x.w)),
    v1: Math.max(...b.map(x => x.v + x.h)),
  }
}
