import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../../src/core/model.ts'
import { PLATFORM_H, cityLayout, squarify } from '../../src/viewer/layouts/city.ts'
import { FLOOR_GAP, FLOOR_MIN, floorsFor } from '../../src/viewer/layouts/floors.ts'
import type { Box } from '../../src/viewer/layouts/types.ts'
import { analyzeFixture } from '../helpers/fixtures.ts'

const inside = (b: Box, outer: Box) =>
  b.x - b.w / 2 >= outer.x - outer.w / 2 - 1e-6 &&
  b.x + b.w / 2 <= outer.x + outer.w / 2 + 1e-6 &&
  b.z - b.d / 2 >= outer.z - outer.d / 2 - 1e-6 &&
  b.z + b.d / 2 <= outer.z + outer.d / 2 + 1e-6

const overlap = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 1e-6

describe('squarify', () => {
  it('fills the rectangle with areas proportional to the weights', () => {
    const rect = { x: 0, z: 0, w: 100, d: 60 }
    const weights = [6, 6, 4, 3, 2, 2, 1]
    const cells = squarify(weights, weights.map((_, i) => `k${i}`), rect)
    const total = weights.reduce((a, b) => a + b, 0)
    cells.forEach((c, i) => expect(c.w * c.d).toBeCloseTo((rect.w * rect.d * weights[i]) / total, 6))
    expect(cells.reduce((a, c) => a + c.w * c.d, 0)).toBeCloseTo(rect.w * rect.d, 6)
  })
})

describe('cityLayout', async () => {
  const g = await analyzeFixture('plain-ts')
  const all = cityLayout({ nodes: g.nodes, rootId: 'd:.', isVisible: () => true })

  it('places every visible file as a building inside its directory district', () => {
    for (const n of g.nodes.filter(x => x.kind === 'file')) {
      const b = all.boxes.get(n.id)!
      expect(all.placement.get(n.id)).toBe('building')
      const district = all.boxes.get(n.parent!)!
      expect(inside(b, district)).toBe(true)
      expect(b.y).toBeCloseTo(district.y + PLATFORM_H)
    }
  })

  it('never overlaps siblings', () => {
    const byParent = new Map<string, GraphNode[]>()
    for (const n of g.nodes) if (n.parent && all.boxes.has(n.id)) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n])
    for (const siblings of byParent.values())
      for (let i = 0; i < siblings.length; i++)
        for (let j = i + 1; j < siblings.length; j++) expect(overlap(all.boxes.get(siblings[i].id)!, all.boxes.get(siblings[j].id)!)).toBe(false)
  })

  it('is deterministic', () => {
    const again = cityLayout({ nodes: [...g.nodes].reverse(), rootId: 'd:.', isVisible: () => true })
    expect([...again.boxes].sort()).toEqual([...all.boxes].sort())
  })

  it('leaves hidden files and emptied directories out', () => {
    const noTests = cityLayout({ nodes: g.nodes, rootId: 'd:.', isVisible: n => !n.tags?.includes('test') })
    expect(noTests.boxes.has('f:tests/shapes.test.ts')).toBe(false)
    expect(noTests.boxes.has('d:tests')).toBe(false)
    expect(noTests.boxes.has('f:src/app.ts')).toBe(true)
  })

  it('lines externals up outside the city', async () => {
    const js = await analyzeFixture('js-only')
    const l = cityLayout({ nodes: js.nodes, rootId: 'd:.', isVisible: () => true })
    const ext = l.boxes.get('x:npm:chalk')!
    expect(l.placement.get('x:npm:chalk')).toBe('external')
    expect(ext.z - ext.d / 2).toBeGreaterThan(l.size / 2)
  })
})

describe('floorsFor', () => {
  const building: Box = { x: 10, y: 2, z: -4, w: 8, d: 6, h: 10 }
  const sym = (id: string, line: number, loc: number, kind: GraphNode['kind'] = 'symbol'): GraphNode => ({
    id,
    kind,
    name: id,
    range: [line, 1, line + loc, 1],
    metrics: { loc },
  })

  it('stacks top-level symbols in source order, sized by LOC, filling the building', () => {
    const { building: b, floors } = floorsFor(building, [sym('b', 20, 30), sym('a', 1, 10), sym('m', 5, 3, 'member')])
    expect(floors.map(f => f.id)).toEqual(['a', 'b'])
    expect(floors[0].box.y).toBe(building.y)
    expect(floors[1].box.h).toBeGreaterThan(floors[0].box.h)
    const top = floors[1].box.y + floors[1].box.h + FLOOR_GAP
    expect(top).toBeCloseTo(b.y + b.h)
    expect(b.h).toBe(building.h)
  })

  it('grows the building so every floor stays clickable', () => {
    const many = Array.from({ length: 20 }, (_, i) => sym(`s${i}`, i + 1, 1))
    const { building: b, floors } = floorsFor(building, many)
    expect(b.h).toBeCloseTo(20 * (FLOOR_MIN + FLOOR_GAP))
    expect(Math.min(...floors.map(f => f.box.h))).toBeGreaterThanOrEqual(FLOOR_MIN - 1e-9)
  })
})
