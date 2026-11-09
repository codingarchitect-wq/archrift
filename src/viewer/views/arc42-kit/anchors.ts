// arc42 kit: places for labels and for what the engine selects and flies to.
// The engine labels, frames and flies to a layout's boxes; a diagram drawn as
// a decoration still puts a box (an undrawn `cluster`) wherever a label or a
// selectable thing is.
import type { Layout } from '../../layouts/types.ts'
import type { V3 } from './sketch.ts'

/**
 * A label's anchor: a box that isn't drawn, the label just above `point`.
 * `width` lets a label with `minScreenWidth` hide while the camera is too far
 * to read it.
 */
export function anchor(layout: Layout, id: string, point: V3, width = 1) {
  layout.boxes.set(id, { x: point[0], y: point[1], z: point[2], w: width, d: 0.1, h: 0 })
  layout.placement.set(id, 'cluster')
}

/**
 * A node the diagram draws itself (hideBoxes), so the engine can still pick,
 * frame and fly to it: a box over its extent, placed as a building.
 */
export function stand(layout: Layout, id: string, box: { x: number; y: number; z: number; w: number; h: number; d: number }) {
  layout.boxes.set(id, box)
  layout.placement.set(id, 'building')
}
