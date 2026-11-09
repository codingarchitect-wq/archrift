// Crosscutting view, part 2: where things stand. The building blocks are
// pillars in a gentle arc facing the camera (top layer on the left), as wide
// as they are big. Each candidate is a band at its own height, the most
// widely spread highest, running along the arc from the first pillar past the
// last to its label: through the pillars that use it (a collar marks each,
// thicker for more use; a sleeve marks where its code lives), behind the
// ones that don't, faint where no pillar on either side uses it. Pure and
// deterministic; world units, x across, z toward the camera, y up.
import type { Rect, V3 } from '../arc42-kit/sketch.ts'
import type { CrosscuttingModel } from './model.ts'

/** Between pillar centers, along the arc. */
export const SPACING = 11.5
const MIN_SIDE = 3.4
const MAX_SIDE = 6.8
/** The arc's depth, as a share of its width. */
const SAG = 0.09
/** The lowest band, and the step up between bands. */
const BASE = 7
export const GAP = 5.2
/** Above the highest band. */
const HEADROOM = 4.5
/** How far behind a pillar a band runs when the pillar doesn't use it. */
const BEHIND = 1.6
/** Pillar names: the first row this far in front of the pillars, each further row this much nearer still. */
const NAME_ROW = 3
const NAME_STAGGER = 12
const NAME_ROWS = 3
/** About how many pixels the layout's size spans at the home view, and a label character's width (labels.ts). */
const HOME_PIXELS = 1100
const CHAR_PX = 7
/** Samples of a band's curve per span between pillars. */
const SAMPLES = 10
/** Room right of the bands for their names, and left of them for their notes (world units at the home view). */
const LABEL_ROOM = 44
const NOTE_ROOM = 60

export interface Pillar {
  id: string
  x: number
  z: number
  /** Footprint (square) and height. */
  side: number
  h: number
  /** Its layer's index, or -1. */
  layer: number
  /** Where its name stands, in front of it (every other one a row nearer, so long names don't collide). */
  nameZ: number
}

export interface BandSpan {
  /** Points along the band's curve. */
  points: V3[]
  /** Some pillar at either end uses it (or it leads to the label): drawn strong, else faint. */
  strong: boolean
}

export interface Band {
  id: string
  y: number
  /** The band's centerline, cut into spans: before the first pillar, between pillars, and on to the label. */
  spans: BandSpan[]
  /** Per pillar: references from it (0: it doesn't use the band), and whether the band's code lives there. */
  uses: number[]
  homes: boolean[]
  /** Where its name goes: past the last pillar; and its note: before the first. */
  label: V3
  note: V3
}

export interface Arrangement {
  pillars: Pillar[]
  bands: Band[]
  /** The board under it all. */
  board: Rect
  /** The tallest pillar. */
  height: number
  /** Spans the layout gives the camera. */
  size: number
  center: V3
}

export function arrange(model: CrosscuttingModel): Arrangement {
  const n = model.blocks.length
  const most = Math.max(1, ...model.blocks.map(b => b.files.length))
  const width = Math.max(0, n - 1) * SPACING
  const height = BASE + Math.max(0, model.candidates.length - 1) * GAP + HEADROOM
  const zAt = (i: number) => {
    const t = n > 1 ? i / (n - 1) : 0.5
    return -SAG * width * (1 - (2 * t - 1) ** 2)
  }
  // name rows: each name in the first row where it clears the names already there (widths as on screen at the home view)
  const bands = model.candidates.length
  const unitsPerPixel = sizeFor(width + SPACING * 1.55 + (bands ? NOTE_ROOM + LABEL_ROOM : SPACING * 0.8), height) / HOME_PIXELS
  const rows: [number, number][][] = Array.from({ length: NAME_ROWS }, () => [])
  const pillars: Pillar[] = model.blocks.map((b, i) => {
    const side = MIN_SIDE + (MAX_SIDE - MIN_SIDE) * Math.sqrt(b.files.length / most)
    const x = i * SPACING - width / 2
    const half = ((b.name.length * CHAR_PX + 14) * unitsPerPixel) / 2 + 1
    let row = rows.findIndex(r => r.every(([a, z]) => x + half < a || x - half > z))
    if (row < 0) row = i % NAME_ROWS
    rows[row].push([x - half, x + half])
    return { id: b.id, x, z: zAt(i), side, h: height, layer: model.layers[i], nameZ: zAt(i) + side / 2 + NAME_ROW + row * NAME_STAGGER }
  })

  const endX = width / 2 + SPACING * 0.95
  const startX = -width / 2 - SPACING * 0.6
  const lastZ = n ? pillars[n - 1].z : 0
  const out: Band[] = model.candidates.map((c, k) => {
    const y = BASE + (bands - 1 - k) * GAP
    const uses = pillars.map(p => c.users.get(p.id) ?? 0)
    const homes = pillars.map(p => c.homes.includes(p.id))
    const on = (i: number) => uses[i] > 0 || homes[i]
    // through a pillar that uses it, behind one that doesn't
    const knots: V3[] = [[startX, y, n ? zAt(0) : 0]]
    pillars.forEach((p, i) => knots.push([p.x, y, on(i) ? p.z : p.z - p.side / 2 - BEHIND]))
    knots.push([width / 2 + SPACING * 0.55, y, lastZ], [endX, y, lastZ])
    const curve = sampleCentripetal(knots, SAMPLES)
    const spans: BandSpan[] = []
    for (let s = 0; s < knots.length - 1; s++) {
      // span s runs from knot s to knot s + 1; knot i + 1 is pillar i
      const left = s - 1
      const right = s
      const strong = s >= n || (left >= 0 && on(left)) || (right < n && on(right))
      spans.push({ points: curve.slice(s * SAMPLES, (s + 1) * SAMPLES + 1), strong })
    }
    return { id: c.id, y, spans, uses, homes, label: [endX + 0.8, y, lastZ], note: [startX - 0.8, y, n ? zAt(0) : 0] }
  })

  const minZ = Math.min(0, ...pillars.map(p => p.z - p.side / 2)) - BEHIND - 10
  const maxZ = Math.max(0, ...pillars.map(p => p.nameZ)) + 6
  const minX = startX - (bands ? NOTE_ROOM : SPACING * 0.4)
  const maxX = endX + (bands ? LABEL_ROOM : SPACING * 0.4)
  const board: Rect = { u: (minX + maxX) / 2, v: (minZ + maxZ) / 2, w: maxX - minX, h: maxZ - minZ }
  const size = sizeFor(board.w, height)
  return { pillars, bands: out, board, height, size, center: [board.u, height * 0.42, (minZ + maxZ) / 2 + 2] }
}

/** What the camera needs to see a board this wide with pillars this tall. */
const sizeFor = (boardWidth: number, height: number) => Math.max(70, boardWidth * 0.75, height * 2.4)

/** Points along a centripetal Catmull-Rom curve through the knots, `per` per span (the last knot included). */
export function sampleCentripetal(knots: readonly V3[], per: number): V3[] {
  if (knots.length < 2) return [...knots]
  const pts = [mirror(knots[1], knots[0]), ...knots, mirror(knots[knots.length - 2], knots[knots.length - 1])]
  const out: V3[] = []
  for (let s = 1; s < pts.length - 2; s++) {
    const [p0, p1, p2, p3] = [pts[s - 1], pts[s], pts[s + 1], pts[s + 2]]
    for (let k = 0; k < per; k++) out.push(catmull(p0, p1, p2, p3, k / per))
  }
  out.push(knots[knots.length - 1])
  return out
}

const mirror = (a: V3, b: V3): V3 => [2 * b[0] - a[0], 2 * b[1] - a[1], 2 * b[2] - a[2]]

/** One point of a centripetal Catmull-Rom segment from p1 to p2 (Barry and Goldman's form). */
function catmull(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const d = (a: V3, b: V3) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])))
  const t0 = 0
  const t1 = t0 + d(p0, p1)
  const t2 = t1 + d(p1, p2)
  const t3 = t2 + d(p2, p3)
  const u = t1 + (t2 - t1) * t
  const lerp = (a: V3, b: V3, ta: number, tb: number): V3 => {
    const w = (u - ta) / (tb - ta)
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]
  }
  const a1 = lerp(p0, p1, t0, t1)
  const a2 = lerp(p1, p2, t1, t2)
  const a3 = lerp(p2, p3, t2, t3)
  const b1 = lerp(a1, a2, t0, t2)
  const b2 = lerp(a2, a3, t1, t3)
  return lerp(b1, b2, t1, t2)
}
