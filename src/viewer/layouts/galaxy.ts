// Galaxy layout: files are stars placed by a 3D force simulation
// (links pull dependents together, charge pushes everything apart, a cluster
// force keeps each area together); directories become clusters. The
// simulation is pure and deterministic, so it runs in a worker and in tests.
import { forceCenter, forceLink, forceManyBody, forceSimulation } from 'd3-force-3d'
import type { GraphNode } from '../../core/model.ts'
import type { Box, Layout } from './types.ts'
import { emptyLayout } from './types.ts'

export type Vec3 = [number, number, number]

export interface GalaxyInput {
  /** group: the area a node is pulled toward; dir: its directory (the coarse level of large galaxies). */
  nodes: { id: string; group: string; dir?: string }[]
  links: { source: string; target: string }[]
  /** Positions from a previous run: a warm start keeps the galaxy where it was. */
  previous?: Record<string, Vec3>
  ticks?: number
  /** Above this many nodes, simulate directories first and then files around them. */
  coarseAbove?: number
}

interface SimNode {
  id: string
  group: string
  dir: string
  weight: number
  x: number
  y: number
  z: number
  vx?: number
  vy?: number
  vz?: number
}

type Progress = (done: number) => void

/**
 * Charge (repulsion) costs ~100 ms a tick at 10k nodes in 3D, so large
 * galaxies are built in two passes: one node per directory, then each file
 * near its directory with only local forces (M3: 22 s → about 2 s at 10k).
 */
export function simulateGalaxy(input: GalaxyInput, onProgress?: Progress): Record<string, Vec3> {
  if (!input.nodes.length) return {}
  return input.nodes.length > (input.coarseAbove ?? 3000) ? twoLevel(input, onProgress) : direct(input, onProgress)
}

const radiusOf = (weight: number) => 4 * Math.cbrt(weight)

/** One simulation over all nodes: links, charge, cluster pull, centering. */
function direct(input: GalaxyInput & { weights?: Map<string, number> }, onProgress?: Progress): Record<string, Vec3> {
  const n = input.nodes.length
  const groups = [...new Set(input.nodes.map(x => x.group))].sort()
  const spread = 14 * Math.cbrt(input.weights ? [...input.weights.values()].reduce((a, b) => a + b, 0) : n) + 20
  const centers = new Map(groups.map((g, i) => [g, fibonacciSphere(i, groups.length, spread)]))
  const groupSize = new Map<string, number>()
  for (const x of input.nodes) groupSize.set(x.group, (groupSize.get(x.group) ?? 0) + 1)

  let warm = 0
  const nodes: SimNode[] = input.nodes.map(x => {
    const weight = input.weights?.get(x.id) ?? 1
    const base = { id: x.id, group: x.group, dir: x.dir ?? x.group, weight }
    const prev = input.previous?.[x.id]
    if (prev) {
      warm++
      return { ...base, x: prev[0], y: prev[1], z: prev[2] }
    }
    const c = centers.get(x.group)!
    const r = 4 * Math.cbrt(groupSize.get(x.group)!)
    const j = jitter(x.id)
    return { ...base, x: c[0] + j[0] * r, y: c[1] + j[1] * r, z: c[2] + j[2] * r }
  })
  const known = new Set(input.nodes.map(x => x.id))
  const links = input.links.filter(l => known.has(l.source) && known.has(l.target) && l.source !== l.target).map(l => ({ ...l }))
  const mostlyWarm = warm > n * 0.8
  const ticks = input.ticks ?? (mostlyWarm ? 80 : 300)

  const sim = forceSimulation(nodes, 3)
    .randomSource(lcg(7))
    .alpha(mostlyWarm ? 0.25 : 1)
    .alphaDecay(1 - Math.pow(0.001, 1 / ticks))
    .force(
      'link',
      forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>(links)
        .id(d => d.id)
        .distance(l => 14 + radiusOf((l.source as SimNode).weight) + radiusOf((l.target as SimNode).weight)),
    )
    .force('charge', forceManyBody<SimNode>().strength(d => -28 * Math.pow(d.weight, 0.6)).theta(0.9).distanceMax(spread * 1.5))
    .force('cluster', clusterForce(0.18))
    .force('center', forceCenter(0, 0, 0))
    .stop()
  for (let i = 0; i < ticks; i++) {
    sim.tick()
    if (onProgress && i % 20 === 0) onProgress(i / ticks)
  }
  return Object.fromEntries(nodes.map(x => [x.id, [round(x.x), round(x.y), round(x.z)] as Vec3]))
}

function twoLevel(input: GalaxyInput, onProgress?: Progress): Record<string, Vec3> {
  const dirOf = new Map(input.nodes.map(x => [x.id, x.dir ?? x.group]))
  const members = new Map<string, GalaxyInput['nodes']>()
  for (const x of input.nodes) {
    const d = dirOf.get(x.id)!
    const list = members.get(d)
    if (list) list.push(x)
    else members.set(d, [x])
  }

  // 1. directories, weighted by their file count, linked where their files are
  const weights = new Map([...members].map(([d, m]) => [d, m.length]))
  const pairs = new Set<string>()
  const dirLinks: GalaxyInput['links'] = []
  for (const l of input.links) {
    const a = dirOf.get(l.source)
    const b = dirOf.get(l.target)
    if (!a || !b || a === b || pairs.has(`${a}\u0000${b}`)) continue
    pairs.add(`${a}\u0000${b}`)
    dirLinks.push({ source: a, target: b })
  }
  let previousDirs: Record<string, Vec3> | undefined
  if (input.previous) {
    previousDirs = {}
    for (const [d, m] of members) {
      const known = m.map(x => input.previous![x.id]).filter(Boolean)
      if (known.length) previousDirs[d] = [0, 1, 2].map(k => known.reduce((a, p) => a + p[k], 0) / known.length) as Vec3
    }
  }
  const anchors = direct(
    { nodes: [...members].map(([d, m]) => ({ id: d, group: m[0].group })), links: dirLinks, previous: previousDirs, ticks: input.ticks, weights },
    p => onProgress?.(p * 0.6),
  )

  // 2. files around their directory: their links, repulsion within the directory, a pull home
  const nodes: SimNode[] = input.nodes.map(x => {
    const dir = dirOf.get(x.id)!
    const prev = input.previous?.[x.id]
    const base = { id: x.id, group: x.group, dir, weight: 1 }
    if (prev) return { ...base, x: prev[0], y: prev[1], z: prev[2] }
    const c = anchors[dir]
    const r = radiusOf(weights.get(dir)!)
    const j = jitter(x.id)
    return { ...base, x: c[0] + j[0] * r, y: c[1] + j[1] * r, z: c[2] + j[2] * r }
  })
  const known = new Set(input.nodes.map(x => x.id))
  const links = input.links.filter(l => known.has(l.source) && known.has(l.target) && l.source !== l.target).map(l => ({ ...l }))
  const ticks = 60
  const sim = forceSimulation(nodes, 3)
    .randomSource(lcg(11))
    .alpha(0.6)
    .alphaDecay(1 - Math.pow(0.001, 1 / ticks))
    .force(
      'link',
      forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>(links)
        .id(d => d.id)
        .distance(22)
        .strength(l => ((l.source as SimNode).dir === (l.target as SimNode).dir ? 0.3 : 0.01)),
    )
    .force('local', localCharge(-28))
    .force('home', anchorForce(anchors, 0.12))
    .stop()
  for (let i = 0; i < ticks; i++) {
    sim.tick()
    if (onProgress && i % 10 === 0) onProgress(0.6 + (0.4 * i) / ticks)
  }
  return Object.fromEntries(nodes.map(x => [x.id, [round(x.x), round(x.y), round(x.z)] as Vec3]))
}

/** Pairwise repulsion among the nodes of each directory (large ones sampled). */
function localCharge(strength: number) {
  let groups: SimNode[][] = []
  const force = (alpha: number) => {
    for (const g of groups) {
      const step = g.length > 300 ? Math.ceil(g.length / 300) : 1
      for (let i = 0; i < g.length; i++) {
        const a = g[i]
        for (let j = i + 1; j < g.length; j += step) {
          const b = g[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dz = b.z - a.z
          const d2 = Math.max(dx * dx + dy * dy + dz * dz, 1)
          const w = (strength * alpha * step) / d2
          a.vx = (a.vx ?? 0) + dx * w
          a.vy = (a.vy ?? 0) + dy * w
          a.vz = (a.vz ?? 0) + dz * w
          b.vx = (b.vx ?? 0) - dx * w
          b.vy = (b.vy ?? 0) - dy * w
          b.vz = (b.vz ?? 0) - dz * w
        }
      }
    }
  }
  force.initialize = (ns: SimNode[]) => {
    const byDir = new Map<string, SimNode[]>()
    for (const n of ns) {
      const list = byDir.get(n.dir)
      if (list) list.push(n)
      else byDir.set(n.dir, [n])
    }
    groups = [...byDir.values()]
  }
  return force
}

/** Pulls each node toward its directory's place from the coarse pass. */
function anchorForce(anchors: Record<string, Vec3>, strength: number) {
  let nodes: SimNode[] = []
  const force = (alpha: number) => {
    const k = strength * alpha
    for (const n of nodes) {
      const a = anchors[n.dir]
      n.vx = (n.vx ?? 0) + (a[0] - n.x) * k
      n.vy = (n.vy ?? 0) + (a[1] - n.y) * k
      n.vz = (n.vz ?? 0) + (a[2] - n.z) * k
    }
  }
  force.initialize = (ns: SimNode[]) => {
    nodes = ns
  }
  return force
}

/** Pulls every node toward the centroid of its group. */
function clusterForce(strength: number) {
  let nodes: SimNode[] = []
  const force = (alpha: number) => {
    const sums = new Map<string, [number, number, number, number]>()
    for (const n of nodes) {
      const s = sums.get(n.group) ?? [0, 0, 0, 0]
      s[0] += n.x
      s[1] += n.y
      s[2] += n.z
      s[3]++
      sums.set(n.group, s)
    }
    const k = strength * alpha
    for (const n of nodes) {
      const s = sums.get(n.group)!
      n.vx = (n.vx ?? 0) + (s[0] / s[3] - n.x) * k
      n.vy = (n.vy ?? 0) + (s[1] / s[3] - n.y) * k
      n.vz = (n.vz ?? 0) + (s[2] / s[3] - n.z) * k
    }
  }
  force.initialize = (ns: SimNode[]) => {
    nodes = ns
  }
  return force
}

export const starRadius = (loc: number) => 1.2 + Math.sqrt(Math.max(loc, 0)) * 0.32

/** Boxes from simulated positions: stars for files and externals, extents for directories. */
export function galaxyLayout(positions: Record<string, Vec3>, nodes: readonly GraphNode[]): Layout {
  const out: Layout = { ...emptyLayout(), view: 'galaxy', shape: 'sphere', arcAnchor: 'center', ground: false, home: [0.42, 0.3, 0.8] }
  const byId = new Map(nodes.map(n => [n.id, n]))
  // denser galaxies get smaller stars, so the space between them stays visible
  const scale = Math.min(1, Math.max(0.4, Math.pow(1000 / Math.max(Object.keys(positions).length, 1), 0.35)))
  const extents = new Map<string, [number, number, number, number, number, number]>() // min xyz, max xyz
  const distances: number[] = []
  for (const [id, [x, y, z]] of Object.entries(positions)) {
    const n = byId.get(id)
    if (!n) continue
    const r = (n.kind === 'external' ? 2.2 : starRadius(n.metrics?.loc ?? 0)) * scale
    out.boxes.set(id, { x, y: y - r, z, w: 2 * r, h: 2 * r, d: 2 * r })
    out.placement.set(id, n.kind === 'external' ? 'external' : 'building')
    distances.push(Math.hypot(x, y, z) + r)
    for (let p = n.parent; p !== undefined; p = byId.get(p)?.parent) {
      const e = extents.get(p) ?? [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
      e[0] = Math.min(e[0], x - r)
      e[1] = Math.min(e[1], y - r)
      e[2] = Math.min(e[2], z - r)
      e[3] = Math.max(e[3], x + r)
      e[4] = Math.max(e[4], y + r)
      e[5] = Math.max(e[5], z + r)
      extents.set(p, e)
    }
  }
  for (const [id, e] of extents) {
    const box: Box = { x: (e[0] + e[3]) / 2, y: e[1], z: (e[2] + e[5]) / 2, w: e[3] - e[0], h: e[4] - e[1], d: e[5] - e[2] }
    out.boxes.set(id, box)
    out.placement.set(id, 'cluster')
    let depth = 0
    for (let p = byId.get(id)?.parent; p !== undefined; p = byId.get(p)?.parent) depth++
    out.depth.set(id, depth)
  }
  // frame the bulk of the galaxy, not its few strays
  distances.sort((a, b) => a - b)
  const bulk = distances.length ? distances[Math.floor((distances.length - 1) * 0.95)] : 40
  out.size = Math.max(80, bulk * 2.4)
  return out
}

function fibonacciSphere(i: number, count: number, radius: number): Vec3 {
  if (count === 1) return [0, 0, 0]
  const y = 1 - (2 * (i + 0.5)) / count
  const r = Math.sqrt(1 - y * y)
  const theta = Math.PI * (3 - Math.sqrt(5)) * i
  return [Math.cos(theta) * r * radius, y * radius * 0.7, Math.sin(theta) * r * radius]
}

/** A stable pseudo-random unit-ish vector per id. */
function jitter(id: string): Vec3 {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  const next = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 2 ** 32) * 2 - 1
  return [next(), next(), next()]
}

function lcg(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

const round = (v: number) => Math.round(v * 100) / 100
