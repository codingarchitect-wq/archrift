// Diagram kit: a whole board's arrangement. Cards tied by connectors (or by
// ordering constraints) fall into groups, each laid out in layers
// (layered.ts) with its rank axis along u (the ERD: parents left) or v (the
// class diagram: bases above); cards tied to nothing go into a grid; groups
// and the grid are packed on shelves toward the board's wanted shape. Pure
// and deterministic.
import { layered } from './layered.ts'
import type { LayerEdge, LayerOptions, P } from './layered.ts'

export interface ArrangeInput {
  /** Card sizes on the board. */
  cards: readonly { w: number; h: number }[]
  /** Connectors to route; their attach offsets run across the rank axis. */
  edges: readonly LayerEdge[]
  /** [earlier, later]: the earlier card's rank comes first. */
  before: readonly [number, number][]
  /** The rank axis. */
  axis: 'u' | 'v'
  layers: Omit<LayerOptions, 'cap'>
  /** The board's wanted width over height. */
  aspect: number
  /** Between groups on a shelf, and between shelves. */
  gap: number
}

export interface Arranged {
  /** Each card's top-left corner. */
  cards: { u: number; v: number }[]
  /** Each connector's polyline, in (u, v). */
  edges: [number, number][][]
  w: number
  h: number
}

export function arrange(input: ArrangeInput): Arranged {
  const n = input.cards.length
  const { groups, singles } = components(n, [...input.edges.map(e => [e.from, e.to] as [number, number]), ...input.before])
  const blocks = groups.map(g => groupBlock(g, input))
  // a few loose cards as tall as the tallest group, so they stand beside it; many shaped like the board
  const groupArea = blocks.reduce((a, b) => a + b.w * b.h, 0)
  const looseArea = singles.reduce((a, i) => a + input.cards[i].w * input.cards[i].h, 0)
  if (singles.length) blocks.push(gridBlock(singles, input, looseArea < groupArea ? Math.max(0, ...blocks.map(b => b.h)) : 0))
  // the biggest group first; the grid of loose cards last
  const order = blocks.map((_, i) => i).sort((a, b) => Number(blocks[a].grid) - Number(blocks[b].grid) || blocks[b].w * blocks[b].h - blocks[a].w * blocks[a].h || a - b)
  const placed = shelves(order.map(i => blocks[i]), input.gap, input.aspect)
  const cards: Arranged['cards'] = new Array(n)
  const edges: Arranged['edges'] = new Array(input.edges.length).fill([])
  order.forEach((b, k) => {
    const { u, v } = placed.at[k]
    for (const [i, c] of blocks[b].cards) cards[i] = { u: u + c.u, v: v + c.v }
    for (const [i, line] of blocks[b].edges) edges[i] = line.map(([pu, pv]) => [u + pu, v + pv])
  })
  return { cards, edges, w: placed.w, h: placed.h }
}

interface Block {
  w: number
  h: number
  grid: boolean
  cards: [number, { u: number; v: number }][]
  edges: [number, [number, number][]][]
}

/** One connected group, laid out in layers. */
function groupBlock(group: number[], input: ArrangeInput): Block {
  const local = new Map(group.map((g, i) => [g, i]))
  const alongU = input.axis === 'u'
  const nodes = group.map(i => (alongU ? { r: input.cards[i].w, c: input.cards[i].h } : { r: input.cards[i].h, c: input.cards[i].w }))
  const edgeIds = input.edges.map((_, k) => k).filter(k => local.has(input.edges[k].from))
  const edges = edgeIds.map(k => ({ ...input.edges[k], from: local.get(input.edges[k].from)!, to: local.get(input.edges[k].to)! }))
  const before = input.before.filter(([a]) => local.has(a)).map(([a, b]) => [local.get(a)!, local.get(b)!] as [number, number])
  const area = nodes.reduce((s, x) => s + (x.r + input.layers.gap) * (x.c + input.layers.spacing), 0)
  // the cross extent that gives the group about the board's shape
  const cap = Math.max(...nodes.map(x => x.c), Math.sqrt(area * (alongU ? 1 / input.aspect : input.aspect)) * 1.15)
  const out = layered(nodes, edges, before, { ...input.layers, cap })
  const uv = (p: P): [number, number] => (alongU ? [p[0], p[1]] : [p[1], p[0]])
  return {
    w: alongU ? out.size.r : out.size.c,
    h: alongU ? out.size.c : out.size.r,
    grid: false,
    cards: out.nodes.map((p, i) => [group[i], alongU ? { u: p.r, v: p.c } : { u: p.c, v: p.r }]),
    edges: edgeIds.map((k, i) => [k, out.edges[i].map(uv)]),
  }
}

/** Cards tied to nothing, in a grid of shelves: at most `height` high when there is one, else shaped like the board. */
function gridBlock(singles: number[], input: ArrangeInput, height: number): Block {
  const sizes = singles.map(i => input.cards[i])
  const gap = input.layers.spacing
  const fits = height > 0 ? widths(sizes, gap).map(w => shelvesAt(sizes, gap, w)).find(p => p.h <= height) : undefined
  const placed = fits ?? shelves(sizes, gap, input.aspect)
  return { w: placed.w, h: placed.h, grid: true, cards: singles.map((i, k) => [i, placed.at[k]]), edges: [] }
}

type Shelved = { at: { u: number; v: number }[]; w: number; h: number }

/** Shelf widths worth trying: as wide as the widest rectangle, as the first two side by side, the first three … */
function widths(sizes: readonly { w: number; h: number }[], gap: number): number[] {
  const out = [Math.max(...sizes.map(x => x.w))]
  let run = -gap
  for (const x of sizes) out.push((run += x.w + gap))
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * Rectangles on shelves, left to right and wrapping down, at the shelf width
 * that shapes the whole most like `aspect` (as wide over as high): the one
 * that needs the least room on a screen of that shape.
 */
export function shelves(sizes: readonly { w: number; h: number }[], gap: number, aspect: number): Shelved {
  let best: Shelved | undefined
  for (const w of widths(sizes, gap)) {
    const placed = shelvesAt(sizes, gap, w)
    if (!best || Math.max(placed.w / aspect, placed.h) < Math.max(best.w / aspect, best.h) - 1e-6) best = placed
  }
  return best ?? { at: [], w: 0, h: 0 }
}

/** Rectangles on shelves at most `width` wide (or as wide as the widest). */
function shelvesAt(sizes: readonly { w: number; h: number }[], gap: number, width: number): Shelved {
  const at: { u: number; v: number }[] = []
  let [u, v, shelf, w] = [0, 0, 0, 0]
  for (const x of sizes) {
    if (u > 0 && u + x.w > width) {
      v += shelf + gap
      u = shelf = 0
    }
    at.push({ u, v })
    u += x.w + gap
    shelf = Math.max(shelf, x.h)
    w = Math.max(w, u - gap)
  }
  return { at, w, h: sizes.length ? v + shelf : 0 }
}

/** Connected groups of two or more (in order of their first member), and the loose ones. */
export function components(n: number, pairs: readonly [number, number][]): { groups: number[][]; singles: number[] } {
  const parent = [...Array(n).keys()]
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (const [a, b] of pairs) {
    const [x, y] = [find(a), find(b)]
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y)
  }
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const list = byRoot.get(r)
    if (list) list.push(i)
    else byRoot.set(r, [i])
  }
  const tied = new Set(pairs.flatMap(([a, b]) => (a === b ? [] : [a, b])))
  const groups = [...byRoot.values()].filter(g => g.length > 1 || tied.has(g[0]))
  // a card whose only connector is to itself is a group of one (its loop needs room)
  const selfOnly = [...byRoot.values()].filter(g => g.length === 1 && !tied.has(g[0]) && pairs.some(([a, b]) => a === g[0] && b === g[0]))
  const singles = [...byRoot.values()].filter(g => g.length === 1 && !tied.has(g[0]) && !selfOnly.includes(g)).map(g => g[0])
  return { groups: [...groups, ...selfOnly], singles }
}
