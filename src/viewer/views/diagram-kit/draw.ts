// Diagram kit: drawing a card and a connector with the arc42 kit's Sketch
// (slabs, plates, ribbons) and the kit's text layer. A card is a slab with a
// paper top, a tinted title band, faint stripes under its rows (each row a
// pickable plate of its own), a rim, and its text in ink: names in the body
// face, types and signatures in monospace, what is quiet (nullable, a
// relation field, "+N more") muted. Connectors are ribbons on the board with
// UML or crow's-foot marks at their ends.
import { GROUND } from '../arc42-kit/sketch.ts'
import type { P2, Sketch } from '../arc42-kit/sketch.ts'
import { CARD, moreText } from './card.ts'
import type { CardRow, CardShape } from './card.ts'
import type { EndMark, PlacedCard } from './scene.ts'
import { ICON } from './text.ts'
import type { TextLayer } from './text.ts'

/** How tall a card's slab stands. */
export const CARD_HEIGHT = 0.45
export const LINK_WIDTH = 0.16

export interface CardOwners {
  card: number
  /** A row's owner, by compartment and row. */
  row: (section: number, row: number) => number
}

/** A card standing at `lift` above the floor. */
export function drawCard(sk: Sketch, text: TextLayer, card: PlacedCard, owners: CardOwners, lift: number) {
  const { shape, content } = card
  const rect = { u: card.u + shape.w / 2, v: card.v + shape.h / 2, w: shape.w, h: shape.h }
  const paint = { tone: 'rim', owner: owners.card }
  if (content.ghost) return drawGhost(sk, text, card, owners.card, lift)
  sk.slab({ tone: 'cardWall', owner: owners.card }, GROUND, rect, { r: CARD.r, lift, height: CARD_HEIGHT, top: 'paper' })
  const top = lift + CARD_HEIGHT
  sk.plate({ tone: `band:${card.band}`, owner: owners.card }, GROUND, { u: rect.u, v: card.v + shape.band / 2, w: shape.w, h: shape.band }, { r: CARD.r, lift: top + 0.006 })
  // the band's lower corners square, where the rows begin
  sk.plate({ tone: `band:${card.band}`, owner: owners.card }, GROUND, { u: rect.u, v: card.v + shape.band * 0.75, w: shape.w, h: shape.band / 2 }, { lift: top + 0.007 })
  shape.sections.forEach((s, i) => {
    if (i > 0) sk.ribbon(paint, GROUND, [[card.u, card.v + s.v], [card.u + shape.w, card.v + s.v]], { width: 0.07, lift: top + 0.02 })
    s.rows.forEach((row, k) => drawRowPlate(sk, card, s.v, k, owners.row(i, k), top))
  })
  sk.frame(paint, GROUND, rect, { r: CARD.r, lift: top + 0.025, width: 0.12 })
  drawTitle(text, card, owners.card, top + 0.04)
  shape.sections.forEach((s, i) => s.rows.forEach((row, k) => drawRow(sk, text, card, row, card.v + s.v + CARD.inset + k * CARD.row, owners.row(i, k), top + 0.04)))
}

function drawRowPlate(sk: Sketch, card: PlacedCard, v: number, k: number, owner: number, top: number) {
  const tone = k % 2 ? 'zebra' : 'paper'
  sk.plate({ tone, owner }, GROUND, { u: card.u + card.shape.w / 2, v: card.v + v + CARD.inset + (k + 0.5) * CARD.row, w: card.shape.w - 0.24, h: CARD.row }, { lift: top + 0.01 })
}

/** Outside the diagram: a name in a dashed outline, flat on the board. */
function drawGhost(sk: Sketch, text: TextLayer, card: PlacedCard, owner: number, lift: number) {
  const { shape, content } = card
  const rect = { u: card.u + shape.w / 2, v: card.v + shape.h / 2, w: shape.w, h: shape.h }
  sk.plate({ tone: 'ghostFill', owner }, GROUND, rect, { r: CARD.r, lift: lift + 0.01 })
  sk.frame({ tone: 'ghostRim', owner }, GROUND, rect, { r: CARD.r, lift: lift + 0.02, width: 0.12, dash: { on: 0.6, off: 0.4 } })
  text.add({ text: content.title, font: 'italic', size: CARD.titleEm * 0.9, u: rect.u, v: card.v + shape.h / 2 + 0.33, align: 'center', max: shape.w - 2 * CARD.pad, lift: lift + 0.04, tone: 'quiet', owner })
}

function drawTitle(text: TextLayer, card: PlacedCard, owner: number, lift: number) {
  const { shape, content } = card
  const center = content.align === 'center'
  const u = center ? card.u + shape.w / 2 : card.u + CARD.pad
  const room = shape.w - 2 * CARD.pad
  if (content.over) text.add({ text: content.over, font: 'text', size: CARD.smallEm, u, v: card.v + 1.15, align: center ? 'center' : 'left', max: room, lift, tone: 'quiet', owner })
  const baseline = card.v + shape.band - (content.over ? 0.7 : 0.78)
  const asideW = content.aside ? Math.min(room * 0.45, text.width(content.aside, 'text', CARD.smallEm) + 0.5) : 0
  const font = content.italic ? 'italic' : 'title'
  const titleW = text.add({ text: content.title, font, size: CARD.titleEm, u, v: baseline, align: center ? 'center' : 'left', max: room - asideW, lift, tone: 'text', owner })
  if (content.aside && !center) text.add({ text: content.aside, font: 'text', size: CARD.smallEm, u: u + titleW + 0.5, v: baseline, max: room - titleW - 0.5, lift, tone: 'quiet', owner })
}

function drawRow(sk: Sketch, text: TextLayer, card: PlacedCard, row: CardRow, top: number, owner: number, lift: number) {
  const { shape, content } = card
  const baseline = top + CARD.row * 0.68
  let u = card.u + CARD.pad
  const end = card.u + shape.w - CARD.pad
  if (row.more !== undefined) return void text.add({ text: moreText(row.more), font: 'italic', size: CARD.nameEm, u: u + shape.marks + shape.signs, v: baseline, lift, tone: 'quiet', owner })
  drawMarks(text, row, shape, u, baseline, lift, owner)
  u += shape.marks
  if (row.sign) text.add({ text: row.sign, font: 'mono', size: CARD.detailEm, u, v: baseline, lift, tone: 'quiet', owner })
  u += shape.signs
  const tone = row.quiet ? 'quiet' : 'text'
  const nameFont = row.italic ? 'italic' : 'text'
  const detailW = row.detail ? text.width(row.detail, 'mono', CARD.detailEm) : 0
  const room = end - u
  if (content.detail === 'right') {
    // the type keeps its column; a long name gives way first, then the type
    const typeRoom = row.detail ? Math.min(detailW, Math.max(room * 0.45, room - text.width(row.name, nameFont, CARD.nameEm) - CARD.gap)) : 0
    const nameW = text.add({ text: row.name, font: nameFont, size: CARD.nameEm, u, v: baseline, max: room - (row.detail ? typeRoom + CARD.gap * 0.6 : 0), lift, tone, owner })
    if (row.underline) underline(sk, u, baseline, nameW, owner, lift, tone)
    if (row.detail) text.add({ text: row.detail, font: 'mono', size: CARD.detailEm, u: end, v: baseline, align: 'right', max: typeRoom, lift, tone: row.quiet ? 'quiet' : 'text2', owner })
    return
  }
  const nameW = text.add({ text: row.name, font: nameFont, size: CARD.nameEm, u, v: baseline, max: room, lift, tone, owner })
  if (row.underline) underline(sk, u, baseline, nameW, owner, lift, tone)
  if (row.detail && room - nameW > 1) text.add({ text: row.detail, font: 'mono', size: CARD.detailEm, u: u + nameW + 0.02, v: baseline, max: room - nameW - 0.02, lift, tone: 'quiet', owner })
}

/** The mark column: a key for a primary key, then a tag (FK, UQ). */
function drawMarks(text: TextLayer, row: CardRow, shape: CardShape, u: number, baseline: number, lift: number, owner: number) {
  if (!shape.marks) return
  if (row.key) text.add({ text: ICON.key, font: 'text', size: CARD.nameEm * 0.95, u, v: baseline, lift, tone: 'key', owner })
  if (row.tag) text.add({ text: row.tag, font: 'mono', size: CARD.smallEm * 0.92, u: u + (row.key ? 0.95 : 0), v: baseline - 0.02, lift, tone: 'quiet', owner })
}

/** UML underlines a static member. */
function underline(sk: Sketch, u: number, baseline: number, w: number, owner: number, lift: number, tone: string) {
  sk.plate({ tone, owner }, GROUND, { u: u + w / 2, v: baseline + 0.16, w, h: 0.07 }, { lift: lift - 0.01 })
}

// ── connectors ──────────────────────────────────────────────────────────────

/** How far each mark reaches back from its end along the connector. */
const MARK_LENGTH: Record<EndMark, number> = { none: 0, triangle: 1.3, arrow: 0, one: 0, bar: 0, 'bar-ring': 0, 'crow-ring': 0 }

/** A connector on the board: a ribbon, its marks at both ends. */
export function drawLink(sk: Sketch, points: readonly P2[], o: { owner: number; tone: string; lift: number; dash?: boolean; start: EndMark; end: EndMark; round?: number }) {
  if (points.length < 2) return
  let path = shorten(points, MARK_LENGTH[o.end])
  path = shorten([...path].reverse(), MARK_LENGTH[o.start]).reverse()
  const paint = { tone: o.tone, owner: o.owner }
  sk.ribbon(paint, GROUND, path, { width: LINK_WIDTH, lift: o.lift, round: o.round ?? 0.9, ...(o.dash ? { dash: { on: 0.7, off: 0.45 } } : {}) })
  endMark(sk, points[points.length - 1], direction(points, false), o.end, paint, o.lift)
  endMark(sk, points[0], direction(points, true), o.start, paint, o.lift)
}

/** The direction a polyline arrives at its end (or, `atStart`, at its start, pointing into the card there). */
export function direction(points: readonly P2[], atStart: boolean): P2 {
  const [a, b] = atStart ? [points[1], points[0]] : [points[points.length - 2], points[points.length - 1]]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
}

function endMark(sk: Sketch, tip: P2, d: P2, mark: EndMark, paint: { tone: string; owner: number }, lift: number) {
  const n: P2 = [-d[1], d[0]]
  const at = (back: number, side = 0): P2 => [tip[0] - d[0] * back + n[0] * side, tip[1] - d[1] * back + n[1] * side]
  const line = (a: P2, b: P2) => sk.ribbon(paint, GROUND, [a, b], { width: LINK_WIDTH, lift: lift + 0.005 })
  const ring = (back: number) => {
    sk.disc({ tone: 'board', owner: paint.owner }, GROUND, at(back), 0.42, { lift: lift + 0.006 })
    sk.ring(paint, GROUND, at(back), 0.32, 0.46, { lift: lift + 0.008 })
  }
  switch (mark) {
    case 'triangle': {
      // hollow: filled with the board, outlined in the line's tone
      const corners: P2[] = [tip, at(1.3, 0.75), at(1.3, -0.75)]
      sk.polygon({ tone: 'board', owner: paint.owner }, GROUND, corners, { lift: lift + 0.006 })
      sk.ribbon(paint, GROUND, corners, { width: LINK_WIDTH * 0.9, lift: lift + 0.008, closed: true })
      return
    }
    case 'arrow':
      line(at(0.95, 0.55), tip)
      line(at(0.95, -0.55), tip)
      return
    case 'one':
      line(at(0.6, 0.55), at(0.6, -0.55))
      return
    case 'bar':
      line(at(0.5, 0.55), at(0.5, -0.55))
      line(at(0.85, 0.55), at(0.85, -0.55))
      return
    case 'bar-ring':
      line(at(0.5, 0.55), at(0.5, -0.55))
      ring(1.15)
      return
    case 'crow-ring':
      line(at(1.0), at(0, 0.62))
      line(at(1.0), at(0, -0.62))
      ring(1.5)
      return
  }
}

/** A polyline cut short by `by` at its end. */
function shorten(points: readonly P2[], by: number): P2[] {
  if (by <= 0 || points.length < 2) return [...points]
  const [a, b] = [points[points.length - 2], points[points.length - 1]]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len <= by) return [...points.slice(0, -1)]
  const t = 1 - by / len
  return [...points.slice(0, -1), [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]]
}

/** Where a connector's label goes: the middle of its longest run. */
export function labelPlace(points: readonly P2[]): { at: P2; along: boolean } {
  let best = 0
  let place: { at: P2; along: boolean } = { at: points[0], along: true }
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len <= best) continue
    best = len
    place = { at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], along: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) }
  }
  return place
}
