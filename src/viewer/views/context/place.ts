// §3 Context view, part 3: where everything stands. The system is a tower in
// the middle of the board, one slab per layer, top layer highest. Its
// neighbors stand round it on arcs: callers on the left, the services it
// calls on the right and at the back, data stores in front, the busiest in
// the middle of their arc. An arc too full for its neighbors to keep apart
// moves out. Each tie runs as a curve from its neighbor into the side of the
// tower, at the height of the layer it enters. Pure and deterministic; world
// units, the tower at the origin.
import * as THREE from 'three'
import type { Rect, V3 } from '../arc42-kit/sketch.ts'
import type { Side } from './catalog.ts'
import type { ContextModel } from './model.ts'

/** Half the tower's footprint, and its glass shell's. */
export const TOWER = 7
export const SHELL = TOWER + 1.2
/** A slab's thickness and the step from one to the next (the tallest a tower gets: MAX_TOWER). */
const SLAB_STEP = 4.4
const SLAB_FILL = 0.76
const MAX_TOWER = 30
/** Neighbors: the radius they stand on, how far apart along it, the footprint of their icon. */
const RADIUS = 42
const SPACING = 17
export const ICON = 3.4
export const ICON_H = 6
/**
 * The arcs, in degrees from +x toward +z (the camera's side): callers on the
 * left, services at the back on the right, stores in front on the right. The
 * front left stays free, where the tower's layers are named.
 */
const ARCS: Record<Side, { center: number; half: number }> = {
  in: { center: 184, half: 42 },
  out: { center: 318, half: 36 },
  store: { center: 66, half: 34 },
}
/** The least angle between neighbors on an arc, in degrees, while the arc has room. */
const MIN_STEP = 30
const BOARD_PAD = 11
/** Above the farthest neighbors: their names, and the board's caption and heading. */
const BOARD_TOP = 18
const SAMPLES = 40

export interface TowerSlab {
  /** Bottom and top of the slab. */
  y0: number
  y1: number
}

export interface PlacedNeighbor {
  x: number
  z: number
  /** Direction from the tower (unit). */
  dx: number
  dz: number
}

export interface PlacedTie {
  neighbor: number
  tie: number
  /** The curve, neighbor end first, sampled finely. */
  points: V3[]
  /** Where its label goes: a third of the way from the neighbor. */
  mid: V3
}

export interface ContextPlan {
  board: Rect
  /** Where the tower stands: its base and top. */
  base: number
  top: number
  slabs: TowerSlab[]
  neighbors: PlacedNeighbor[]
  ties: PlacedTie[]
}

export function placeContext(model: ContextModel, base: number): ContextPlan {
  const n = Math.max(1, model.slabs.length)
  const step = Math.min(SLAB_STEP, MAX_TOWER / n)
  const slabs = model.slabs.map((_, i) => {
    const y0 = base + (n - 1 - i) * step
    return { y0, y1: y0 + step * SLAB_FILL }
  })
  const top = base + n * step

  // neighbors on their arcs: slots from the middle outward, the busiest first (the model's order)
  const neighbors: PlacedNeighbor[] = new Array(model.neighbors.length)
  for (const side of ['in', 'out', 'store'] as const) {
    const members = model.neighbors.flatMap((nb, i) => (nb.side === side ? [i] : []))
    if (!members.length) continue
    const arc = ARCS[side]
    const k = members.length
    // keep them SPACING apart: move the arc out when its angle won't hold them
    const radius = Math.max(RADIUS, ((k - 1) * SPACING) / ((arc.half * 2 * Math.PI) / 180))
    // a few spread over their arc (seen from the front, neighbors close on an arc stand behind each other)
    const stepAngle = k > 1 ? Math.min(Math.max((SPACING / radius) * (180 / Math.PI), MIN_STEP), (arc.half * 2) / (k - 1)) : 0
    const slots = Array.from({ length: k }, (_, i) => i - (k - 1) / 2).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)
    members.forEach((m, j) => {
      const angle = ((arc.center + slots[j] * stepAngle) * Math.PI) / 180
      const dx = Math.cos(angle)
      const dz = Math.sin(angle)
      neighbors[m] = { x: dx * radius, z: dz * radius, dx, dz }
    })
  }

  // ties: from the neighbor's icon, low over the board, then up into the tower's shell at the slab's height
  const ties: PlacedTie[] = []
  model.neighbors.forEach((nb, i) => {
    const at = neighbors[i]
    nb.ties.forEach((tie, j) => {
      const side = (j - (nb.ties.length - 1) / 2) * 1.8
      const across = new THREE.Vector3(-at.dz, 0, at.dx).multiplyScalar(side)
      const slab = slabs[tie.slab] ?? slabs[slabs.length - 1]
      const y = (slab.y0 + slab.y1) / 2
      const start = new THREE.Vector3(at.x - at.dx * ICON, base + ICON_H * 0.45, at.z - at.dz * ICON).add(across)
      const reach = SHELL / Math.max(Math.abs(at.dx), Math.abs(at.dz))
      const end = new THREE.Vector3(at.dx * (reach + 0.15), y, at.dz * (reach + 0.15)).addScaledVector(across, 0.6)
      // low along the board, then up the tower's side to its layer
      const low = start.clone().lerp(end, 0.5)
      low.y = start.y + 0.8
      const rise = start.clone().lerp(end, 0.86)
      rise.y = end.y + 0.5
      const curve = new THREE.CatmullRomCurve3([start, low, rise, end], false, 'centripetal')
      const points = curve.getPoints(SAMPLES).map(p => [round(p.x), round(p.y), round(p.z)] as V3)
      // the label nearer the neighbor, where ties are still apart
      const label = curve.getPoint(0.36)
      ties.push({ neighbor: i, tie: j, points, mid: [round(label.x), round(label.y + 1), round(label.z)] })
    })
  })

  // the board: round everything, room above for the caption and heading
  const xs = [SHELL, -SHELL, ...neighbors.map(p => p.x)]
  const zs = [SHELL, -SHELL, ...neighbors.map(p => p.z)]
  const minX = Math.min(...xs) - ICON - BOARD_PAD
  const maxX = Math.max(...xs) + ICON + BOARD_PAD
  const minZ = Math.min(...zs) - ICON - BOARD_PAD - BOARD_TOP
  const maxZ = Math.max(...zs) + ICON + BOARD_PAD
  const board = { u: (minX + maxX) / 2, v: (minZ + maxZ) / 2, w: maxX - minX, h: maxZ - minZ }
  return { board, base, top, slabs, neighbors, ties }
}

const round = (v: number) => Math.round(v * 1000) / 1000
