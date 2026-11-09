// Diagram kit: the Layout a diagram view hands the engine. The kit's
// decoration draws everything, so the engine gets the camera (home, framed to
// the boards), places for the boards' captions and headings, and an undrawn
// box per card so the minimap shows where cards are. A layout with nothing to
// draw says why in a few words in the middle (no schema found, no types).
import { emptyLayout } from '../../layouts/types.ts'
import type { Layout } from '../../layouts/types.ts'
import type { LabelSpec } from '../../scene/labels.ts'
import { anchor, stand } from '../arc42-kit/anchors.ts'
import { ON_BOARD } from '../arc42-kit/board.ts'
import { diagramScenes } from './decoration.ts'
import { CARD } from './card.ts'
import { CARD_HEIGHT } from './draw.ts'
import { HOME, homeFor, screenNow } from './frame.ts'
import { extentOf } from './scene.ts'
import type { DiagramScene, Focus, PlacedCard } from './scene.ts'

/** Where a board's caption and heading start, in from its top-left corner, and the heading below the caption (apart enough not to hide each other at home). */
const CORNER = 2.8
const HEADING_BELOW = 5.4

export function diagramLayout(view: string, scene: DiagramScene, inspector: boolean): Layout {
  const home = homeFor(extentOf(scene), screenNow(inspector))
  const out: Layout = {
    ...emptyLayout(),
    view,
    size: home.size,
    shape: 'box',
    arcAnchor: 'roof',
    ground: true,
    hideBoxes: true,
    arcs: 'none',
    openFile: 'none',
    keepView: true,
    home: HOME,
    center: home.center,
  }
  scene.boards.forEach((b, k) => {
    anchor(out, `${view}:caption:${k}`, [b.u + CORNER, ON_BOARD, b.v + CORNER])
    anchor(out, `${view}:heading:${k}`, [b.u + CORNER, ON_BOARD, b.v + CORNER + HEADING_BELOW], b.w)
  })
  // what the minimap shows; the ids are the view's own, so the engine labels and frames none of them
  scene.cards.forEach((c, i) => {
    stand(out, `${view}:card:${i}`, { x: c.u + c.shape.w / 2, y: ON_BOARD, z: c.v + c.shape.h / 2, w: c.shape.w, h: CARD_HEIGHT, d: c.shape.h })
    // its width stands for the title's em, so the label hands over to the card's text at one size of type
    anchor(out, `${view}:title:${i}`, [c.u + c.shape.w / 2, ON_BOARD + CARD_HEIGHT, c.v + c.shape.band * 0.85], TITLE_SPAN)
  })
  diagramScenes.set(out, scene)
  return out
}

/** A character's width in a caption (10 px capitals, spaced) and a heading (14 px bold), so the labels next to them keep clear. */
const CAPTION_PX = 8
const HEADING_PX = 8.6

/** The boards' captions and headings, as the arc42 boards have them. */
export function boardLabels(view: string, scene: DiagramScene): LabelSpec[] {
  return scene.boards.flatMap((b, k) => [
    // the heading wins when they meet, far away
    { id: `${view}:caption:${k}`, text: b.caption, priority: 1080 - k, className: 'a42-title', align: 'start' as const, width: b.caption.length * CAPTION_PX + 12 },
    { id: `${view}:heading:${k}`, text: b.heading, priority: 1100 - k, className: 'a42-heading', align: 'start' as const, minScreenWidth: 90, width: b.heading.length * HEADING_PX + 12 },
  ])
}

/**
 * A card's own title reads once its em is about 10 px on screen: until then
 * a label writes it over the card. The label's anchor is TITLE_SPAN ems wide,
 * so it hides once that is READABLE_PX on screen.
 */
const TITLE_SPAN = 15 * CARD.titleEm
const READABLE_PX = 150

/**
 * The cards' titles from afar: while a card is small on screen its title is
 * a label over its band; closer, the card's own text takes over. The most
 * connected first, as there's room for 150 labels at most.
 */
export function cardLabels(view: string, scene: DiagramScene, focus: Focus | null): LabelSpec[] {
  const degree = new Map<number, number>()
  for (const l of [...scene.links, ...scene.arcs]) for (const c of [l.from, l.to]) degree.set(c, (degree.get(c) ?? 0) + 1)
  // the selected card opened above the board covers the titles under it
  const open = focus && focus.card >= 0 ? scene.cards[focus.card] : undefined
  const covered = (c: PlacedCard) => !!open?.full && c !== open && c.u + c.shape.w / 2 >= open.u && c.u + c.shape.w / 2 <= open.u + open.full.w && c.v + c.shape.band >= open.v && c.v <= open.v + open.full.h
  return scene.cards.flatMap((c, i) => (covered(c) ? [] : [{
    id: `${view}:title:${i}`,
    text: c.content.title,
    priority: 500 + Math.min(200, (degree.get(i) ?? 0) * 10) + (focus?.cards.has(i) ? 300 : 0),
    className: `a42-name a42-pill dg-title${focus && !focus.cards.has(i) ? ' a42-dim' : ''}${focus?.card === i ? ' a42-accent' : ''}`,
    maxScreenWidth: READABLE_PX,
  }]))
}

/** Layouts that only say something. */
const notes = new WeakMap<Layout, string[]>()

/** A layout with nothing drawn but a heading and a line under it. */
export function noteLayout(view: string, lines: string[]): Layout {
  const out: Layout = { ...emptyLayout(), view, size: 80, ground: true, arcs: 'none', openFile: 'none', hideBoxes: true, keepView: true, home: HOME, center: [0, 0, 0] }
  lines.forEach((_, i) => anchor(out, `${view}:note:${i}`, [0, 0, i * 2.2]))
  notes.set(out, lines)
  return out
}

export function noteLabels(view: string, layout: Layout): LabelSpec[] {
  return (notes.get(layout) ?? []).map((text, i) => ({ id: `${view}:note:${i}`, text, priority: 1000 - i, className: i ? 'a42-small' : 'a42-heading' }))
}
