// Risks view, part 2: the matrix on the ground. Likelihood runs left to
// right, impact from the front to the back (up the screen, as on paper), so
// the hot corner is at the back right. Each cell is a plinth as high as its
// risk, so the matrix rises toward the hot corner. Every cell is the same
// size, a square grid big enough for the fullest one; a cell's files stand in
// a block at its middle, the tallest at the back so the short ones in front
// stay visible. Towers are as tall as the file is complex, and tall enough for
// the debt rings they carry. Pure and deterministic; world units, centered on
// the origin.
import type { Box } from '../../layouts/types.ts'
import { ON_BOARD } from '../arc42-kit/board.ts'
import { HIGH } from './model.ts'
import type { RiskFile, RiskModel } from './model.ts'

/** Grid spacing of towers in a cell, a tower's footprint, a cell's margin, the gap between cells. */
export const SLOT = 2.4
export const TOWER = 1.5
const CELL_PAD = 1.7
export const GAP = 1.6
/** Debt rings: their height, the distance between them, how far below the roof the first one sits. */
export const RING_H = 0.3
export const RING_STEP = 0.5
export const RING_TOP = 0.45

export interface Cell {
  /** 1–5 each. */
  likelihood: number
  impact: number
  risk: number
  /** Its plinth's height, and where its floor is (the towers' base). */
  plinth: number
  top: number
  /** Center (x, z) and side length. */
  x: number
  z: number
  size: number
  /** Its files, as placed (tallest first). */
  files: string[]
}

export interface MatrixGeometry {
  /** 25 cells, `cellIndex(likelihood, impact)`. */
  cells: Cell[]
  towers: Map<string, Box>
  cellSize: number
  /** Distance between neighboring cells' centers. */
  step: number
  /** The matrix's extent: left, right, back (impact 5), front (impact 1). */
  left: number
  right: number
  back: number
  front: number
}

export const cellIndex = (likelihood: number, impact: number) => (impact - 1) * 5 + (likelihood - 1)

/** A cell's plinth: low for the calm cells, rising to its tallest in the hot corner (a seventh of a 30-wide cell, in proportion to others). */
export const plinthHeight = (risk: number, cellSize = 30) => (0.3 + 3.7 * Math.pow((risk - 1) / 24, 1.2)) * Math.min(1.5, cellSize / 30)

/** A tower's height: by complexity (square root, so a few huge files don't flatten the rest), room for its rings. */
export function towerHeight(r: Pick<RiskFile, 'complexity' | 'debts'>): number {
  const byComplexity = 0.5 + 0.45 * Math.sqrt(Math.max(0, r.complexity))
  const forRings = RING_TOP + r.debts.length * RING_STEP + 0.25
  return Math.max(Math.min(9, byComplexity), r.debts.length ? forRings : 0)
}

export function matrixGeometry(model: RiskModel): MatrixGeometry {
  const perCell: RiskFile[][] = Array.from({ length: 25 }, () => [])
  for (const f of model.files) perCell[cellIndex(f.likelihood, f.impact)].push(f)
  const fullest = Math.max(1, ...perCell.map(c => c.length))
  const k = Math.max(3, Math.ceil(Math.sqrt(fullest)))
  const cellSize = k * SLOT + CELL_PAD * 2
  const step = cellSize + GAP
  const span = 5 * cellSize + 4 * GAP
  const left = -span / 2
  const back = -span / 2

  const towers = new Map<string, Box>()
  const cells: Cell[] = []
  for (let impact = 1; impact <= 5; impact++)
    for (let likelihood = 1; likelihood <= 5; likelihood++) {
      const x = left + (likelihood - 1) * step + cellSize / 2
      const z = back + (5 - impact) * step + cellSize / 2
      const plinth = plinthHeight(likelihood * impact, cellSize)
      const top = ON_BOARD + plinth
      const files = perCell[cellIndex(likelihood, impact)]
      const heights = new Map(files.map(f => [f.id, towerHeight(f)]))
      // tallest at the back; among equals, higher priority first
      const placed = [...files].sort((a, b) => heights.get(b.id)! - heights.get(a.id)! || a.rank - b.rank)
      const cols = Math.min(k, Math.ceil(Math.sqrt(placed.length)))
      const rows = Math.ceil(placed.length / Math.max(1, cols))
      placed.forEach((f, i) => {
        const row = Math.floor(i / cols)
        const col = i % cols
        // a short last row sits centered
        const inRow = row === rows - 1 ? placed.length - row * cols : cols
        towers.set(f.id, {
          x: x + (col - (inRow - 1) / 2) * SLOT,
          y: top,
          z: z + (row - (rows - 1) / 2) * SLOT,
          w: TOWER,
          d: TOWER,
          h: heights.get(f.id)!,
        })
      })
      cells.push({ likelihood, impact, risk: likelihood * impact, plinth, top, x, z, size: cellSize, files: placed.map(f => f.id) })
    }
  return { cells, towers, cellSize, step, left, right: left + span, back, front: back + span }
}

/**
 * The outline of the cells at or above a risk (the high-risk corner), as a
 * closed polygon in grid units: x is the column boundary (0–5, left to right),
 * y the row boundary (0–5, impact 1's front edge to impact 5's back edge).
 * A staircase, since risk only grows to the right and to the back.
 */
export function zoneOutline(threshold = HIGH): [number, number][] {
  // per column, the lowest impact at or above the threshold (6: none)
  const lowest = [1, 2, 3, 4, 5].map(l => [1, 2, 3, 4, 5].find(i => l * i >= threshold) ?? 6)
  const first = lowest.findIndex(i => i <= 5)
  if (first < 0) return []
  const points: [number, number][] = [
    [first, 5],
    [5, 5],
  ]
  for (let col = 4; col >= first; col--) {
    const bottom = lowest[col] - 1
    points.push([col + 1, bottom])
    if (col > first && lowest[col - 1] - 1 !== bottom) points.push([col, bottom])
    else if (col === first) points.push([col, bottom])
  }
  // drop points on a straight line
  return points.filter((p, i) => {
    const a = points[(i - 1 + points.length) % points.length]
    const b = points[(i + 1) % points.length]
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]))
  })
}

/** A grid point of `zoneOutline` in world (x, z): halfway into the gaps around the cells. */
export function gridToWorld(g: MatrixGeometry, gx: number, gy: number): [number, number] {
  return [g.left - GAP / 2 + gx * g.step, g.front + GAP / 2 - gy * g.step]
}

/**
 * The board's margins round the matrix, as shares of its width (so labels get
 * the same room on screen whatever its size): left for the row names, right
 * for the rail, back for the caption and heading, front for the column names
 * and the axis.
 */
export const MARGIN = { left: 0.16, right: 0.3, back: 0.2, front: 0.1 }

/** The matrix's width (and depth). */
export const spanOf = (g: MatrixGeometry) => g.right - g.left

/** The axes' distance from the matrix, and how far below the likelihood axis the column names go. */
export const axisGap = (g: MatrixGeometry) => GAP * 0.7
export const underAxis = (g: MatrixGeometry) => spanOf(g) * 0.028 + 1

/** The board's rectangle (world x/z) round the matrix. */
export function boardRect(g: MatrixGeometry) {
  const span = spanOf(g)
  const x0 = g.left - MARGIN.left * span
  const x1 = g.right + MARGIN.right * span
  const z0 = g.back - MARGIN.back * span
  const z1 = g.front + MARGIN.front * span
  return { u: (x0 + x1) / 2, v: (z0 + z1) / 2, w: x1 - x0, h: z1 - z0 }
}

/** The layout's size: the board's longer side. */
export const boardSize = (g: MatrixGeometry) => {
  const r = boardRect(g)
  return Math.max(r.w, r.h)
}

/** How far right of the matrix the rail runs (for a matrix 155 wide; it scales with it). */
export const RAIL_GAP = 5

/**
 * About how many pixels a world unit spans at the back of the board at the
 * home view, per unit of layout size, and a label character's width (labels.ts):
 * a rail label is centered on a point right of the rail by about half its
 * width, so the label layer, which centers labels, sees where it really is.
 */
const PIXELS_PER_SIZE = 820
const CHAR_PX = 7

export interface RailStop {
  id: string
  /** Where the leader ends, on the rail. */
  at: [number, number, number]
  /** The label's center: right of the rail by about half its width. */
  label: [number, number, number]
  /** The leader from the tower's roof over the matrix to the label. */
  leader: [number, number, number][]
}

/**
 * The highest risks, named on a rail right of the matrix, highest first from
 * the back, each joined to its tower by a leader arcing over the towers in
 * between (the hot corner is at the back right, so they stay short).
 */
export function rail(model: RiskModel, g: MatrixGeometry, count: number, textOf: (id: string) => string, size: number): RailStop[] {
  const ranked = model.files.slice(0, count).filter(f => g.towers.has(f.id))
  const pxPerUnit = PIXELS_PER_SIZE / size
  const span = spanOf(g)
  const step = Math.max(span * 0.055, Math.min(g.step * 0.3, (span * 0.85) / Math.max(1, ranked.length)))
  const x = g.right + RAIL_GAP * (span / 155)
  return ranked.map((f, i) => {
    const b = g.towers.get(f.id)!
    const top = b.y + b.h
    const end: [number, number, number] = [x, ON_BOARD + 0.4, g.back + span * 0.012 + i * step]
    const apex = Math.max(top, 3) + 3 + Math.hypot(end[0] - b.x, end[2] - b.z) * 0.08
    const half = ((textOf(f.id).length * CHAR_PX + 16) / 2) / pxPerUnit
    return {
      id: f.id,
      at: end,
      label: [end[0] + 0.6 + half, end[1], end[2]],
      leader: [
        [b.x, top, b.z],
        [b.x, top + 1.2, b.z],
        [(b.x * 0.35 + end[0] * 0.65), apex, (b.z * 0.35 + end[2] * 0.65)],
        [end[0] - 1.2, end[1] + 0.8, end[2]],
        [end[0] - 0.4, end[1], end[2]],
      ],
    }
  })
}

/** Is a cell at or above the threshold (in the zone)? */
export const inZone = (c: Pick<Cell, 'risk'>, threshold = HIGH) => c.risk >= threshold
