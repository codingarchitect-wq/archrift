// arc42 kit: a diagram's board, the sheet an arc42 diagram is drawn on (or
// one of several, such as the levels of the building block view). A thin slab
// just off its surface with a quiet rim; its caption and heading go in its
// top-left corner (the far side from the home camera on the ground, the top
// on a wall).
import { at } from './sketch.ts'
import type { Rect, Sketch, Surface, V3 } from './sketch.ts'

export const BOARD_HEIGHT = 0.25
/** How far ink on a board must be lifted off its surface to lie on top of it. */
export const ON_BOARD = BOARD_HEIGHT + 0.03

export interface BoardPlaces {
  /** Where the small caption goes ("arc42 §5 · Building Block View"). */
  caption: V3
  /** Where the heading goes, just under the caption. */
  heading: V3
}

export function board(sk: Sketch, s: Surface, rect: Rect, o: { owner?: number; r?: number; lift?: number; pad?: number } = {}): BoardPlaces {
  const lift = o.lift ?? 0
  const r = o.r ?? Math.min(4, rect.w / 12, rect.h / 12)
  // the sheet's face is flat ink, so its color is exactly the board tone whatever the light; the slab's
  // own top has that tone too, so where the two fight for depth far from the camera nothing flickers
  sk.slab({ tone: 'edge', owner: o.owner }, s, rect, { r, lift, height: BOARD_HEIGHT, top: 'board', bottom: true })
  sk.plate({ tone: 'board', owner: o.owner }, s, rect, { r, lift: lift + BOARD_HEIGHT + 0.005 })
  sk.frame({ tone: 'edge', owner: o.owner }, s, rect, { r, lift: lift + BOARD_HEIGHT + 0.01, width: 0.3 })
  const pad = o.pad ?? 3
  const left = rect.u - rect.w / 2 + pad
  const top = rect.v - rect.h / 2 + pad
  const point = (v: number) => at(s, left, v, lift + ON_BOARD).toArray() as unknown as V3
  return { caption: point(top), heading: point(top + 3.2) }
}
