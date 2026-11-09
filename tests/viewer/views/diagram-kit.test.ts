import { describe, expect, it } from 'vitest'
import { arrange, components, shelves } from '../../../src/viewer/views/diagram-kit/arrange.ts'
import { CARD, allot, rowMiddle, shapeCard, shownRows } from '../../../src/viewer/views/diagram-kit/card.ts'
import type { CardContent } from '../../../src/viewer/views/diagram-kit/card.ts'
import { inOrder, layered } from '../../../src/viewer/views/diagram-kit/layered.ts'
import type { LayerOptions } from '../../../src/viewer/views/diagram-kit/layered.ts'
import { fitText, textWidth } from '../../../src/viewer/views/diagram-kit/metrics.ts'
import { distanceField } from '../../../src/viewer/views/diagram-kit/sdf.ts'

const OPTIONS: LayerOptions = { gap: 6, spacing: 3, track: 1, cap: 1000, align: 'start' }

type Box = { u: number; v: number; w: number; h: number }
const overlap = (a: Box, b: Box) => a.u < b.u + b.w && b.u < a.u + a.w && a.v < b.v + b.h && b.v < a.v + a.h

/** Every segment of a polyline runs along one axis. */
const orthogonal = (line: [number, number][]) => line.slice(1).every((p, i) => Math.abs(p[0] - line[i][0]) < 1e-6 || Math.abs(p[1] - line[i][1]) < 1e-6)

/** Whether a segment passes through a box's inside (touching its side is fine). */
function crosses(a: [number, number], b: [number, number], box: Box): boolean {
  const [u0, u1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
  const [v0, v1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  return u0 < box.u + box.w - 1e-6 && u1 > box.u + 1e-6 && v0 < box.v + box.h - 1e-6 && v1 > box.v + 1e-6
}

describe('placing in order', () => {
  it('keeps each position at least its gap after the one before, as near to the wanted ones as that allows', () => {
    expect(inOrder([0, 10, 20], [5, 5])).toEqual([0, 10, 20])
    // two want the same place: they share the difference
    expect(inOrder([10, 10], [4])).toEqual([8, 12])
    expect(inOrder([30, 0, 0], [2, 2])).toEqual([8, 10, 12])
  })
})

describe('the layered layout', () => {
  // a parent with two children, a grandchild, and the grandchild's reference to the parent across a rank
  const nodes = [
    { r: 10, c: 6 },
    { r: 8, c: 4 },
    { r: 8, c: 5 },
    { r: 12, c: 4 },
  ]
  const edges = [
    { from: 1, to: 0 },
    { from: 2, to: 0 },
    { from: 3, to: 1 },
    { from: 3, to: 0 },
  ]
  const before: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 3],
    [0, 3],
  ]

  it('puts each card a rank after those it follows, connectors through the gaps on tracks of their own', () => {
    const out = layered(nodes, edges, before, OPTIONS)
    expect(out.nodes.map(n => n.rank)).toEqual([0, 1, 1, 2])
    // ranks run along r: each one starts after the one before and its gap
    expect(out.nodes[1].r).toBeGreaterThanOrEqual(10 + OPTIONS.gap)
    expect(out.nodes[3].r).toBeGreaterThan(out.nodes[1].r + 8)
    const boxes = out.nodes.map((n, i) => ({ u: n.r, v: n.c, w: nodes[i].r, h: nodes[i].c }))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${i} ${j}`).toBe(false)
    out.edges.forEach((line, k) => {
      expect(orthogonal(line), `edge ${k}`).toBe(true)
      // it starts on its child's start side and ends on its parent's end side
      expect(line[0][0]).toBeCloseTo(out.nodes[edges[k].from].r)
      expect(line[line.length - 1][0]).toBeCloseTo(out.nodes[edges[k].to].r + nodes[edges[k].to].r)
      // and passes through no card on the way
      for (let i = 1; i < line.length; i++) for (const box of boxes) expect(crosses(line[i - 1], line[i], box), `edge ${k} through a card`).toBe(false)
    })
    expect(layered(nodes, edges, before, OPTIONS)).toEqual(out)
  })

  it('wraps a rank longer than its cap into the next, and breaks cycles', () => {
    const many = Array.from({ length: 6 }, () => ({ r: 4, c: 4 }))
    const wrapped = layered(many, [], [], { ...OPTIONS, cap: 15 })
    expect(wrapped.nodes.map(n => n.rank)).toEqual([0, 0, 1, 1, 2, 2])
    const loop = layered(nodes.slice(0, 2), [{ from: 0, to: 1 }, { from: 1, to: 0 }], [[0, 1], [1, 0]], OPTIONS)
    expect(loop.nodes.map(n => n.rank)).toEqual([0, 1])
    expect(loop.edges.every(orthogonal)).toBe(true)
  })

  it('routes a connector between cards of one rank, and a card’s reference to itself, through the gap after them', () => {
    const out = layered(nodes.slice(0, 2), [{ from: 0, to: 1 }, { from: 0, to: 0, fromAt: 1, toAt: 4 }], [], OPTIONS)
    expect(out.nodes.map(n => n.rank)).toEqual([0, 0])
    const [between, self] = out.edges
    expect(between).toHaveLength(4)
    expect(between[1][0]).toBeGreaterThan(10)
    expect(self.map(p => p[1])).toEqual([out.nodes[0].c + 1, out.nodes[0].c + 1, out.nodes[0].c + 4, out.nodes[0].c + 4])
    expect(out.size.r).toBeGreaterThan(10)
  })
})

describe('arranging a board', () => {
  it('lays out tied cards in groups, the loose ones in a grid after them, nothing overlapping', () => {
    const cards = [
      { w: 10, h: 8 },
      { w: 10, h: 6 },
      { w: 6, h: 4 },
      { w: 6, h: 4 },
      { w: 8, h: 8 },
      { w: 9, h: 5 },
    ]
    expect(components(6, [[1, 0], [5, 4]])).toEqual({ groups: [[0, 1], [4, 5]], singles: [2, 3] })
    const out = arrange({ cards, edges: [{ from: 1, to: 0, fromAt: 2, toAt: 1 }, { from: 5, to: 4 }], before: [[0, 1], [4, 5]], axis: 'u', layers: OPTIONS, aspect: 1.6, gap: 8 })
    const boxes = out.cards.map((p, i) => ({ ...p, ...cards[i] }))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${i} ${j}`).toBe(false)
    // parents left of their children; the attach offsets are rows down the cards
    expect(out.cards[1].u).toBeGreaterThan(out.cards[0].u + 10)
    expect(out.edges[0][0]).toEqual([out.cards[1].u, out.cards[1].v + 2])
    expect(out.edges[0][out.edges[0].length - 1]).toEqual([out.cards[0].u + 10, out.cards[0].v + 1])
    // with the rank axis along v, bases sit above their subtypes
    const down = arrange({ cards, edges: [{ from: 1, to: 0 }], before: [[0, 1]], axis: 'v', layers: OPTIONS, aspect: 1.6, gap: 8 })
    expect(down.cards[1].v).toBeGreaterThanOrEqual(down.cards[0].v + 8 + OPTIONS.gap)
    expect(out.w).toBeGreaterThan(0)
  })

  it('packs shelves about as wide as the shape asks', () => {
    const { at, w, h } = shelves(Array.from({ length: 9 }, () => ({ w: 10, h: 10 })), 2, 1)
    expect(at.slice(0, 4).map(p => p.u)).toEqual([0, 12, 24, 0])
    expect([w, h]).toEqual([34, 34])
  })
})

describe('cards', () => {
  const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, detail: 'string' }))
  const card = (sections: CardContent['sections']): CardContent => ({ id: 'x', title: 'Account', sections, align: 'left', detail: 'right' })

  it('share their rows between compartments, each long one ending in "+N more"', () => {
    expect(allot([3, 4], 12)).toEqual([3, 4])
    expect(allot([20, 3], 12)).toEqual([9, 3])
    expect(allot([20, 30], 12)).toEqual([6, 6])
    expect(allot([0, 40], 12)).toEqual([0, 12])
    expect(shownRows(rows(5, 'c'), 3).map(r => r.more ?? r.name)).toEqual(['c0', 'c1', 3])
    const shape = shapeCard(card([rows(20, 'p'), rows(3, 'm')]), { rows: 12, minW: 10, maxW: 30 })
    expect(shape.sections.map(s => s.rows.length)).toEqual([9, 3])
    expect(shape.sections[0].rows[8].more).toBe(12)
    // opened, it shows everything
    expect(shapeCard(card([rows(20, 'p'), rows(3, 'm')]), { rows: 12, minW: 10, maxW: 30 }, true).sections.map(s => s.rows.length)).toEqual([20, 3])
    expect(shape.h).toBeCloseTo(CARD.band + 12 * CARD.row + 4 * CARD.inset)
    expect(rowMiddle(shape, 1, 0)).toBeCloseTo(shape.sections[1].v + CARD.inset + CARD.row / 2)
    expect(rowMiddle(shape, 0, 8)).toBeUndefined()
  })

  it('are as wide as their widest row within the limits', () => {
    const narrow = shapeCard(card([[{ name: 'id' }]]), { rows: 12, minW: 10, maxW: 30 })
    expect(narrow.w).toBe(10)
    const wide = shapeCard(card([[{ name: 'aVeryLongColumnNameIndeed', detail: 'VARCHAR(255)', key: true }]]), { rows: 12, minW: 10, maxW: 30 })
    expect(wide.w).toBeGreaterThan(20)
    expect(wide.marks).toBe(CARD.markW)
    expect(textWidth('mmm', 'mono', 1)).toBeCloseTo(1.8)
    expect(fitText('createInvestment(data: CreateInvestmentInput)', 'mono', 1, 10)).toBe('createInvestmen…')
  })
})

describe('distance fields', () => {
  it('are 128 on the outline, rising inside and falling outside', () => {
    const w = 24
    const alpha = new Uint8Array(w * w)
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) alpha[y * w + x] = 255
    const field = distanceField(alpha, w, w, 6)
    const at = (x: number, y: number) => field[y * w + x]
    expect(at(12, 12)).toBeGreaterThan(200)
    expect(at(1, 1)).toBe(0)
    expect(at(8, 12)).toBeGreaterThan(128)
    expect(at(7, 12)).toBeLessThan(128)
    expect(Math.abs(at(8, 12) + at(7, 12) - 256)).toBeLessThan(8)
  })
})
