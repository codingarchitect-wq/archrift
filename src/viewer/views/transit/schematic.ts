// Transit view, part 2: the schematic map. One column band per layer, left
// to right; stations on a grid of slots (several per band when a line stays in
// a layer) and rows. Every line (and each of its branches) gets a lane, lines
// sharing a station get neighboring lanes, an interchange sits on the middle
// lane of its lines, and no two stations share a grid point. Between stations,
// lines run straight or bend at 45°; where several share a stretch, they run
// side by side. Pure and deterministic; world units, centered on the origin.
import type { TransitLine } from './network.ts'

/** Grid spacing: between slots (x) and rows (z). */
export const SLOT = 14
export const ROW = 5
/** Ribbon width, and how far apart lines sharing a stretch run. */
export const RIBBON = 0.9
const BUNDLE_GAP = 0.95
/** The widest a bundle of lines gets: beyond it, they overlap into stripes. */
const MAX_SPREAD = 3.4
export const STATION_RADIUS = 0.85
const INTERCHANGE_RADIUS = 1.35
/** Slots one band may take (a line staying long in one layer). */
const MAX_SUB = 8
/** Where a route may turn, tried in order when the middle would pass a station. */
const BENDS = [0.5, 0.15, 0.85, 0, 1]

export type Point = [number, number]

export interface Station {
  id: string
  slot: number
  row: number
  x: number
  z: number
  /** Indexes of the lines through it (into the lines given), ascending. */
  lines: number[]
  interchange: boolean
  radius: number
}

export interface Segment {
  line: number
  from: string
  to: string
  /** XZ polyline from `from` to `to`, shifted sideways when lines share the stretch. */
  points: Point[]
}

export interface Schematic {
  /** Column bands, left to right, with their x extents (empty bands keep one slot). */
  bands: { name: string; x0: number; x1: number }[]
  stations: Map<string, Station>
  segments: Segment[]
  /** Each line's lane (its row where it runs alone). */
  lanes: number[]
  /** Extent of the grid (station centers), in world units. */
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

interface Path {
  line: number
  lane: number
  stations: string[]
  main: boolean
}

export function schematic(lines: readonly TransitLine[], column: ReadonlyMap<string, number>, columns: readonly string[]): Schematic {
  const paths: Path[] = lines.flatMap((l, i) => [
    { line: i, lane: 0, stations: l.stations, main: true },
    ...l.branches.map(b => ({ line: i, lane: 0, stations: b, main: false })),
  ])
  const band = (id: string) => column.get(id) ?? 0

  // slots: a station after another of its line in the same band moves one slot right
  const sub = new Map<string, number>()
  for (const p of paths) for (const id of p.stations) sub.set(id, 0)
  for (let pass = 0; pass < 2 * MAX_SUB + 2; pass++) {
    let changed = false
    for (const p of paths)
      for (let k = 1; k < p.stations.length; k++) {
        const [u, v] = [p.stations[k - 1], p.stations[k]]
        const want = Math.min(MAX_SUB, sub.get(u)! + 1)
        if (band(u) === band(v) && sub.get(v)! < want) {
          sub.set(v, want)
          changed = true
        }
      }
    if (!changed) break
  }
  const widths = columns.map(() => 1)
  for (const [id, s] of sub) widths[band(id)] = Math.max(widths[band(id)], s + 1)
  const bandStart: number[] = []
  widths.reduce((at, w, i) => ((bandStart[i] = at), at + w), 0)
  const slots = widths.reduce((a, b) => a + b, 0)
  const slotOf = (id: string) => bandStart[band(id)] + sub.get(id)!

  // which lines pass each station
  const linesAt = new Map<string, number[]>()
  for (const p of paths)
    for (const id of p.stations) {
      const list = linesAt.get(id) ?? []
      if (!list.includes(p.line)) list.push(p.line)
      linesAt.set(id, list)
    }
  const shared = (id: string) => linesAt.get(id)!.length > 1

  // lanes: lines ordered by the first station they share, so lines meeting there are neighbors
  const firstShared = lines.map((l, i) => paths.filter(p => p.line === i).flatMap(p => p.stations).find(shared))
  const order = lines
    .map((_, i) => i)
    .sort((a, b) => {
      const sa = firstShared[a]
      const sb = firstShared[b]
      if (!sa || !sb) return (sa ? 0 : 1) - (sb ? 0 : 1) || a - b
      return slotOf(sa) - slotOf(sb) || cmp(sa, sb) || a - b
    })
  const lanes: number[] = new Array(lines.length)
  let next = 0
  for (const i of order)
    for (const p of paths.filter(q => q.line === i)) {
      p.lane = next++
      if (p.main) lanes[i] = p.lane
    }

  // rows: a station on one line sits in its lane (a branch's own lane off the main path), an interchange between its lines' lanes
  const wanted = new Map<string, number>()
  for (const [id, on] of linesAt) {
    const own = on.map(line => {
      const through = paths.filter(p => p.line === line && p.stations.includes(id))
      return (through.find(p => p.main) ?? through[0]).lane
    })
    wanted.set(id, Math.round(own.reduce((a, b) => a + b, 0) / own.length))
  }
  const byPriority = [...linesAt.keys()].sort((a, b) => linesAt.get(b)!.length - linesAt.get(a)!.length || slotOf(a) - slotOf(b) || cmp(a, b))
  const taken = new Set<string>()
  const rowOf = new Map<string, number>()
  // interchanges are big: two never sit in neighboring rows of a slot
  const big = new Set<string>()
  const place = (id: string, row: number) => {
    const slot = slotOf(id)
    const interchange = shared(id)
    for (let d = 0; ; d = d > 0 ? -d : 1 - d) {
      const r = row + d
      if (taken.has(`${slot}:${r}`) || (interchange && (big.has(`${slot}:${r - 1}`) || big.has(`${slot}:${r + 1}`)))) continue
      taken.add(`${slot}:${r}`)
      if (interchange) big.add(`${slot}:${r}`)
      rowOf.set(id, r)
      return
    }
  }
  for (const id of byPriority) place(id, wanted.get(id)!)

  // a line mustn't seem to stop at a station it passes: bend elsewhere, or failing that move the station
  const xOf = (slot: number) => (slot - (slots - 1) / 2) * SLOT
  const at = (id: string): Point => [xOf(slotOf(id)), rowOf.get(id)! * ROW]
  const pairs = new Map<string, [string, string]>()
  for (const p of paths)
    for (let k = 1; k < p.stations.length; k++) {
      const [a, b] = [p.stations[k - 1], p.stations[k]]
      pairs.set(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`, a < b ? [a, b] : [b, a])
    }
  const bends = new Map<string, number>()
  const inSlot: string[][] = Array.from({ length: slots }, () => [])
  for (const id of byPriority) inSlot[slotOf(id)].push(id)
  // only stations in the slots a route spans can be in its way
  const blocking = (route: Point[], u: string, v: string) => {
    const [from, to] = [slotOf(u), slotOf(v)].sort((a, b) => a - b)
    return inSlot.slice(from, to + 1).flatMap(ids => ids.filter(id => id !== u && id !== v && nearPolyline(at(id), route, ROW * 0.4)))
  }
  for (let pass = 0; pass < 4; pass++) {
    let moved = false
    for (const [key, [u, v]] of pairs) {
      const bend = BENDS.find(b => !blocking(routeBetween(at(u), at(v), b), u, v).length)
      bends.set(key, bend ?? 0.5)
      if (bend !== undefined) continue
      for (const id of blocking(routeBetween(at(u), at(v)), u, v)) {
        const was = `${slotOf(id)}:${rowOf.get(id)}`
        place(id, rowOf.get(id)!) // its old point is still taken, so it moves
        taken.delete(was)
        big.delete(was)
        moved = true
      }
    }
    if (!moved) break
  }

  const rows = [...rowOf.values()]
  const midRow = (Math.min(...rows) + Math.max(...rows)) / 2
  const stations = new Map<string, Station>()
  for (const [id, on] of linesAt) {
    const row = rowOf.get(id)!
    stations.set(id, {
      id,
      slot: slotOf(id),
      row,
      x: xOf(slotOf(id)),
      z: (row - midRow) * ROW,
      lines: [...on].sort((a, b) => a - b),
      interchange: on.length > 1,
      radius: on.length > 1 ? INTERCHANGE_RADIUS : STATION_RADIUS,
    })
  }

  // segments: lines sharing a stretch run side by side, in lane order
  const stretches = new Map<string, { u: string; v: string; runs: { line: number; lane: number; reversed: boolean }[] }>()
  for (const p of paths)
    for (let k = 1; k < p.stations.length; k++) {
      const [a, b] = [p.stations[k - 1], p.stations[k]]
      const [u, v] = a < b ? [a, b] : [b, a]
      const key = `${u}\u0000${v}`
      const s = stretches.get(key) ?? { u, v, runs: [] }
      if (!s.runs.some(r => r.line === p.line)) s.runs.push({ line: p.line, lane: p.lane, reversed: a !== u })
      stretches.set(key, s)
    }
  const segments: Segment[] = []
  for (const { u, v, runs } of stretches.values()) {
    const a = stations.get(u)!
    const b = stations.get(v)!
    const route = routeBetween([a.x, a.z], [b.x, b.z], bends.get(`${u}\u0000${v}`))
    runs.sort((r, q) => r.lane - q.lane || r.line - q.line)
    const gap = runs.length > 1 ? Math.min(BUNDLE_GAP, MAX_SPREAD / (runs.length - 1)) : 0
    const spread = gap * (runs.length - 1)
    // the station ends of a bundle must stay under the stations' discs
    for (const s of [a, b]) if (spread) s.radius = Math.max(s.radius, spread / 2 + RIBBON / 2 + 0.35)
    runs.forEach((r, i) => {
      const points = offsetPolyline(route, (i - (runs.length - 1) / 2) * gap)
      segments.push({ line: r.line, from: r.reversed ? v : u, to: r.reversed ? u : v, points: r.reversed ? points.reverse() : points })
    })
  }
  segments.sort((a, b) => a.line - b.line || cmp(a.from, b.from) || cmp(a.to, b.to))

  const xs = [...stations.values()].map(s => s.x)
  const zs = [...stations.values()].map(s => s.z)
  return {
    bands: columns.map((name, i) => ({ name, x0: xOf(bandStart[i]) - SLOT / 2, x1: xOf(bandStart[i] + widths[i] - 1) + SLOT / 2 })),
    stations,
    segments,
    lanes,
    minX: xs.length ? Math.min(...xs) : 0,
    maxX: xs.length ? Math.max(...xs) : 0,
    minZ: zs.length ? Math.min(...zs) : 0,
    maxZ: zs.length ? Math.max(...zs) : 0,
  }
}

/**
 * The route between two stations: straight when they share a row or a slot,
 * else a straight run, a 45° diagonal and a straight run, or for a steep one a
 * diagonal, a vertical run and a diagonal. `bend` says where the turn is,
 * from 0 (right at `a`) to 1 (right at `b`).
 */
export function routeBetween(a: Point, b: Point, bend = 0.5): Point[] {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const ax = Math.abs(dx)
  const az = Math.abs(dz)
  if (ax < 1e-6 || az < 1e-6) return [a, b]
  const sx = Math.sign(dx)
  const sz = Math.sign(dz)
  let points: Point[]
  if (az <= ax) {
    const run = ax - az
    points = [a, [a[0] + sx * run * bend, a[1]], [b[0] - sx * run * (1 - bend), b[1]], b]
  } else {
    const d = ax * bend
    points = [a, [a[0] + sx * d, a[1] + sz * d], [b[0] - sx * (ax - d), b[1] - sz * (ax - d)], b]
  }
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6)
}

/** A polyline moved sideways by `d` (positive: towards +z, or +x for a vertical one), mitered at bends. */
export function offsetPolyline(points: readonly Point[], d: number): Point[] {
  if (!d) return points.map(p => [p[0], p[1]])
  const normals = points.slice(1).map((p, i) => {
    const q = points[i]
    const len = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1
    let n: Point = [-(p[1] - q[1]) / len, (p[0] - q[0]) / len]
    if (n[1] < -1e-9 || (Math.abs(n[1]) < 1e-9 && n[0] < 0)) n = [-n[0], -n[1]]
    return n
  })
  return points.map((p, i) => {
    const a = normals[Math.max(0, i - 1)]
    const b = normals[Math.min(normals.length - 1, i)]
    const m: Point = [a[0] + b[0], a[1] + b[1]]
    const len = Math.hypot(m[0], m[1]) || 1
    const scale = d / Math.max(0.5, (m[0] * a[0] + m[1] * a[1]) / len)
    return [p[0] + (m[0] / len) * scale, p[1] + (m[1] / len) * scale]
  })
}

function nearPolyline(p: Point, line: readonly Point[], tolerance: number) {
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1]
    const [bx, bz] = line[i]
    const dx = bx - ax
    const dz = bz - az
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1)))
    if (Math.hypot(p[0] - ax - t * dx, p[1] - az - t * dz) < tolerance) return true
  }
  return false
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
