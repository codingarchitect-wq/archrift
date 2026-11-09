// Coherence view, Clouds mode, part 1: where the dots go. As in the essay's
// pictures, files are dots on a plane, pulled together by their dependencies
// and apart by a charge, and each block (a service, a folder) gathers into a
// lobe of its own. One layout serves every cloud: the clouds differ only in
// which dots a job colors, so the shape stays and the colors tell the story.
// Pure and deterministic, so it runs in a worker and in tests.
import { forceCenter, forceLink, forceManyBody, forceSimulation } from 'd3-force-3d'

export type Point = [number, number]

export interface CloudInput {
  /** A file, the block it gathers with, and its size (lines). */
  nodes: { id: string; block: string; loc: number }[]
  links: { source: string; target: string }[]
  /** Positions from a previous run: a warm start keeps the cloud where it was. */
  previous?: Record<string, Point>
  ticks?: number
}

interface SimNode {
  id: string
  block: string
  x: number
  y: number
  vx?: number
  vy?: number
}

/** Positions on the plane, roughly centered on 0. */
export function simulateCloud(input: CloudInput, onProgress?: (done: number) => void): Record<string, Point> {
  if (!input.nodes.length) return {}
  const n = input.nodes.length
  const blocks = [...new Set(input.nodes.map(x => x.block))].sort()
  const size = new Map<string, number>()
  for (const x of input.nodes) size.set(x.block, (size.get(x.block) ?? 0) + 1)
  // blocks sit on a sunflower spiral, the largest in the middle: their anchors, which keep them apart as lobes
  const byRank = [...blocks].sort((a, b) => size.get(b)! - size.get(a)! || (a < b ? -1 : 1))
  const spread = 12 * Math.sqrt(n) + 10
  const start = new Map(byRank.map((b, i) => [b, spiral(i, blocks.length, spread)]))
  let warm = 0
  const nodes: SimNode[] = input.nodes.map(x => {
    const prev = input.previous?.[x.id]
    if (prev) {
      warm++
      return { id: x.id, block: x.block, x: prev[0], y: prev[1] }
    }
    const c = start.get(x.block)!
    const r = 3 * Math.sqrt(size.get(x.block)!)
    const j = jitter(x.id)
    return { id: x.id, block: x.block, x: c[0] + j[0] * r, y: c[1] + j[1] * r }
  })
  const known = new Set(input.nodes.map(x => x.id))
  const links = input.links.filter(l => known.has(l.source) && known.has(l.target) && l.source !== l.target).map(l => ({ ...l }))
  const mostlyWarm = warm > n * 0.8
  const ticks = input.ticks ?? (mostlyWarm ? 60 : n > 3000 ? 160 : 260)
  const sim = forceSimulation(nodes, 2)
    .randomSource(lcg(5))
    .alpha(mostlyWarm ? 0.2 : 1)
    .alphaDecay(1 - Math.pow(0.001, 1 / ticks))
    .force(
      'link',
      forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>(links)
        .id(d => d.id)
        .distance(7)
        // within a block links hold tight; between blocks they only lean the lobes toward each other
        .strength(l => ((l.source as SimNode).block === (l.target as SimNode).block ? 0.25 : 0.015)),
    )
    // repulsion reaches about a lobe: the anchors, not the charge, set the lobes apart
    .force('charge', forceManyBody<SimNode>().strength(-10).theta(0.95).distanceMax(spread * 0.25))
    .force('block', blockForce(0.1))
    .force('home', homeForce(start, 0.1))
    .force('center', forceCenter(0, 0))
    .stop()
  for (let i = 0; i < ticks; i++) {
    sim.tick()
    if (onProgress && i % 20 === 0) onProgress(i / ticks)
  }
  return Object.fromEntries(nodes.map(x => [x.id, [round(x.x), round(x.y)] as Point]))
}

/** Each node is pulled toward the middle of its block. */
function blockForce(strength: number) {
  let nodes: SimNode[] = []
  const force = (alpha: number) => {
    const sum = new Map<string, { x: number; y: number; n: number }>()
    for (const d of nodes) {
      const s = sum.get(d.block) ?? { x: 0, y: 0, n: 0 }
      s.x += d.x
      s.y += d.y
      s.n++
      sum.set(d.block, s)
    }
    for (const d of nodes) {
      const s = sum.get(d.block)!
      d.vx = (d.vx ?? 0) + (s.x / s.n - d.x) * strength * alpha
      d.vy = (d.vy ?? 0) + (s.y / s.n - d.y) * strength * alpha
    }
  }
  force.initialize = (ns: SimNode[]) => void (nodes = ns)
  return force
}

/** Each node is pulled toward its block's anchor. */
function homeForce(anchors: ReadonlyMap<string, Point>, strength: number) {
  let nodes: SimNode[] = []
  const force = (alpha: number) => {
    for (const d of nodes) {
      const a = anchors.get(d.block)!
      d.vx = (d.vx ?? 0) + (a[0] - d.x) * strength * alpha
      d.vy = (d.vy ?? 0) + (a[1] - d.y) * strength * alpha
    }
  }
  force.initialize = (ns: SimNode[]) => void (nodes = ns)
  return force
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function boundsOf(points: Iterable<Point>): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const [x, y] of points) {
    b.minX = Math.min(b.minX, x)
    b.minY = Math.min(b.minY, y)
    b.maxX = Math.max(b.maxX, x)
    b.maxY = Math.max(b.maxY, y)
  }
  if (!Number.isFinite(b.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return b
}

export interface Cell {
  /** Where the cloud's middle goes (x, z on the ground). */
  x: number
  z: number
  /** World units per layout unit. */
  scale: number
  /** The caption's place, under the cloud. */
  caption: [number, number]
}

/** Side of one cloud of several, in world units. */
export const CELL = 100
/** Side of a cloud alone. */
export const ALONE = 260

/**
 * Where each of `count` clouds goes: alone, one big cloud; several, a grid as
 * close to a wide screen's shape as the count allows, at most 6 wide, the first
 * in the top left. Every cloud gets the same scale, so the same file is in the
 * same place of each.
 */
export function arrangeClouds(count: number, b: Bounds): { cells: Cell[]; width: number; height: number } {
  const w = Math.max(b.maxX - b.minX, 1)
  const h = Math.max(b.maxY - b.minY, 1)
  const side = count === 1 ? ALONE : CELL
  const scale = side / Math.max(w, h)
  const cw = w * scale
  const ch = h * scale
  const cols = count === 1 ? 1 : Math.min(6, Math.max(1, Math.ceil(Math.sqrt(count * 1.8))))
  const rows = Math.ceil(count / cols)
  const gapX = side * 0.22
  const gapZ = side * 0.32 // room for the caption
  const width = cols * cw + (cols - 1) * gapX
  const height = rows * ch + (rows - 1) * gapZ
  const cells: Cell[] = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = -width / 2 + col * (cw + gapX) + cw / 2
    const z = -height / 2 + row * (ch + gapZ) + ch / 2
    cells.push({ x, z, scale, caption: [x - cw / 2, z + ch / 2 + side * 0.06] })
  }
  return { cells, width, height }
}

/** A point of the layout in a cell: x to the right, the layout's y toward the viewer. */
export function placeIn(cell: Cell, b: Bounds, p: Point): [number, number] {
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  return [cell.x + (p[0] - cx) * cell.scale, cell.z + (p[1] - cy) * cell.scale]
}

/** A dot's radius as a share of its cloud's side: bigger files, bigger dots, within reason. */
export const dotRadius = (loc: number) => 0.0055 * (1 + Math.min(1.4, Math.cbrt(Math.max(loc, 1)) / 7))

function spiral(i: number, n: number, radius: number): Point {
  if (n === 1) return [0, 0]
  const r = radius * Math.sqrt((i + 0.5) / n)
  const a = i * 2.399963229728653 // the golden angle
  return [r * Math.cos(a), r * Math.sin(a)]
}

function jitter(id: string): Point {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  const a = ((h >>> 0) % 3600) / 3600
  const b = (((h >>> 12) >>> 0) % 1000) / 1000
  return [Math.cos(a * Math.PI * 2) * b, Math.sin(a * Math.PI * 2) * b]
}

function lcg(seed: number) {
  let s = seed
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296
}

const round = (v: number) => Math.round(v * 100) / 100
