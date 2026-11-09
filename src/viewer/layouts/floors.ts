// Inside a building: a file's top-level symbols become floors,
// first declaration at the bottom, each at least tall enough to click. The
// building grows when its symbols need more room than its LOC height gives.
import type { GraphNode } from '../../core/model.ts'
import type { Box } from './types.ts'

export const FLOOR_MIN = 1.4
export const FLOOR_GAP = 0.3

export interface Floors {
  /** The building's box once it holds the floors (possibly taller). */
  building: Box
  floors: { id: string; box: Box }[]
}

export function floorsFor(building: Box, symbols: readonly GraphNode[]): Floors {
  const tops = symbols
    .filter(s => s.kind === 'symbol')
    .sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0) || (a.id < b.id ? -1 : 1))
  if (!tops.length) return { building, floors: [] }
  const n = tops.length
  const height = Math.max(building.h, n * (FLOOR_MIN + FLOOR_GAP))
  const spare = height - n * (FLOOR_MIN + FLOOR_GAP)
  const locs = tops.map(s => Math.max(s.metrics?.loc ?? 1, 1))
  const total = locs.reduce((a, b) => a + b, 0)
  let y = building.y
  const floors = tops.map((s, i) => {
    const h = FLOOR_MIN + (spare * locs[i]) / total
    const box = { x: building.x, z: building.z, y, w: building.w * 0.96, d: building.d * 0.96, h }
    y += h + FLOOR_GAP
    return { id: s.id, box }
  })
  return { building: { ...building, h: height }, floors }
}

/**
 * The Galaxy's version of floors: a file's top-level symbols as moons on a
 * ring around its star, in source order, sized by LOC.
 */
export function moonsFor(star: Box, symbols: readonly GraphNode[]): Floors {
  const tops = symbols
    .filter(s => s.kind === 'symbol')
    .sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0) || (a.id < b.id ? -1 : 1))
  const r = star.w / 2
  const ring = r + 3 + tops.length * 0.35
  const cy = star.y + r
  const floors = tops.map((s, i) => {
    const angle = (i / Math.max(tops.length, 1)) * Math.PI * 2
    const m = Math.min(0.6 + Math.sqrt(Math.max(s.metrics?.loc ?? 1, 1)) * 0.18, r * 0.6 + 0.6)
    const x = star.x + Math.cos(angle) * ring
    const z = star.z + Math.sin(angle) * ring
    const y = cy + Math.sin(angle * 3) * r * 0.3
    return { id: s.id, box: { x, y: y - m, z, w: 2 * m, h: 2 * m, d: 2 * m } }
  })
  return { building: star, floors }
}
