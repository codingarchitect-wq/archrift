import { describe, expect, it } from 'vitest'
import { coherenceModel } from '../../../src/core/coherence.ts'
import type { ConcernMeta, GraphNode } from '../../../src/core/model.ts'
import { ALONE, CELL, arrangeClouds, boundsOf, placeIn, simulateCloud } from '../../../src/viewer/views/coherence/cloud.ts'
import type { CloudInput, Point } from '../../../src/viewer/views/coherence/cloud.ts'
import { cloudConcerns } from '../../../src/viewer/views/coherence/clouds.ts'
import { groupColor } from '../../../src/viewer/views/coherence/model.ts'
import type { Coherence } from '../../../src/viewer/views/coherence/model.ts'
import { AREA_PALETTE } from '../../../src/viewer/colors.ts'

/** Two blocks of 30 files, each file linked to the next in its block, and one link between the blocks. */
function twoBlocks(): CloudInput {
  const nodes: CloudInput['nodes'] = []
  const links: CloudInput['links'] = []
  for (const block of ['a', 'b'])
    for (let i = 0; i < 30; i++) {
      nodes.push({ id: `${block}${i}`, block, loc: 10 + i })
      if (i) links.push({ source: `${block}${i - 1}`, target: `${block}${i}` })
    }
  links.push({ source: 'a0', target: 'b0' })
  return { nodes, links }
}

const centroid = (ps: Point[]): Point => [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length]
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])

describe('cloud layout', () => {
  it('places every file, the same way every time', () => {
    const input = twoBlocks()
    const a = simulateCloud(input)
    expect(Object.keys(a)).toHaveLength(60)
    expect(simulateCloud(input)).toEqual(a)
  })

  it('gathers each block into a lobe of its own', () => {
    const p = simulateCloud(twoBlocks())
    const of = (block: string) => Object.entries(p).filter(([id]) => id.startsWith(block)).map(([, q]) => q)
    const [ca, cb] = [centroid(of('a')), centroid(of('b'))]
    const spread = (ps: Point[], c: Point) => ps.reduce((s, q) => s + dist(q, c), 0) / ps.length
    // the lobes lie further apart than their files lie from their own middle
    expect(dist(ca, cb)).toBeGreaterThan(spread(of('a'), ca) + spread(of('b'), cb))
  })

  it('starts from where the files were, and stays near there', () => {
    const input = twoBlocks()
    const first = simulateCloud(input)
    const again = simulateCloud({ ...input, previous: first })
    const moved = Object.keys(first).reduce((s, id) => s + dist(first[id], again[id]), 0) / 60
    const b = boundsOf(Object.values(first))
    expect(moved).toBeLessThan((b.maxX - b.minX) * 0.1)
  })
})

describe('clouds side by side', () => {
  const b = { minX: -50, minY: -20, maxX: 50, maxY: 20 }

  it('gives one cloud the whole stage, and several a grid at most 6 wide', () => {
    const one = arrangeClouds(1, b)
    expect(one.cells).toHaveLength(1)
    expect(one.cells[0].scale).toBeCloseTo(ALONE / 100)
    const seven = arrangeClouds(7, b)
    expect(seven.cells[0].scale).toBeCloseTo(CELL / 100)
    const columns = new Set(seven.cells.map(c => c.x)).size
    expect(columns).toBe(4)
    expect(new Set(seven.cells.map(c => c.z)).size).toBe(2)
    expect(arrangeClouds(30, b).cells.filter(c => c.z === arrangeClouds(30, b).cells[0].z)).toHaveLength(6)
    // reading order: left to right, then down; captions under their cloud
    expect(seven.cells[1].x).toBeGreaterThan(seven.cells[0].x)
    expect(seven.cells[4].z).toBeGreaterThan(seven.cells[0].z)
    for (const c of seven.cells) expect(c.caption[1]).toBeGreaterThan(c.z + (b.maxY - b.minY) * c.scale * 0.5)
  })

  it('maps the layout into a cell around its middle, the same file to the same place in every cloud', () => {
    const { cells } = arrangeClouds(2, b)
    expect(placeIn(cells[0], b, [0, 0])).toEqual([cells[0].x, cells[0].z])
    const [x0, z0] = placeIn(cells[0], b, [50, 20])
    const [x1, z1] = placeIn(cells[1], b, [50, 20])
    expect([x1 - cells[1].x, z1 - cells[1].z]).toEqual([x0 - cells[0].x, z0 - cells[0].z])
  })
})

describe('which jobs get a cloud', () => {
  const concern = (id: string, ...ways: string[]): ConcernMeta => ({ id, label: id, stack: 'JVM', about: '', ...(id.startsWith('test') ? { tests: true } : {}), paradigms: ways.map(w => ({ id: w, label: w })) })
  const file = (path: string, ...ways: string[]): GraphNode => ({ id: `f:${path}`, kind: 'file', name: path, path, tags: ways.map(w => `paradigm:${w}`) })
  const files = [
    file('a.kt', 'dates=time', 'json=jackson'),
    file('b.kt', 'dates=date', 'json=jackson'),
    file('CTest.kt', 'test.mocks=mockk'),
    file('DTest.kt', 'test.mocks=mockito'),
    file('e.kt', 'json=jackson'),
  ]
  const model = coherenceModel({ files, concerns: [concern('dates', 'time', 'date'), concern('json', 'jackson'), concern('test.mocks', 'mockk', 'mockito')], links: [] })
  const c = { model, blocks: { kind: 'folder', of: () => 'x', name: (b: string) => b }, measured: true } as Coherence

  it('is the job picked, or else those done several ways', () => {
    expect(cloudConcerns(c, model.byId.get('json')).map(x => x.concern.id)).toEqual(['json'])
    expect(cloudConcerns(c, undefined).map(x => x.concern.id).sort()).toEqual(['dates', 'test.mocks'])
  })

  it('leaves out a job no file shown does (the tests’, with the tests hidden)', () => {
    const production = (id: string) => !id.includes('Test')
    expect(cloudConcerns(c, undefined, production).map(x => x.concern.id)).toEqual(['dates'])
    // no job done several ways among what's shown: every job shown gets a cloud
    expect(cloudConcerns(c, undefined, id => id === 'f:e.kt').map(x => x.concern.id)).toEqual(['json'])
  })
})

describe('group colors', () => {
  it('takes the area palette first, then hues of their own', () => {
    expect(AREA_PALETTE.map((_, i) => groupColor(i))).toEqual(AREA_PALETTE)
    const more = Array.from({ length: 20 }, (_, i) => groupColor(AREA_PALETTE.length + i))
    expect(more.every(c => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
    expect(new Set(more).size).toBe(20)
  })
})
