import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../src/analyzer/config.ts'
import { analyze } from '../../src/analyzer/analyze.ts'
import type { GraphNode } from '../../src/core/model.ts'
import { autoLayers } from '../../src/core/auto-layers.ts'
import { PLATFORM_H } from '../../src/viewer/layouts/city.ts'
import { moonsFor } from '../../src/viewer/layouts/floors.ts'
import { galaxyLayout, simulateGalaxy } from '../../src/viewer/layouts/galaxy.ts'
import { groupedLayout } from '../../src/viewer/layouts/grouped.ts'
import { UNASSIGNED, baseId, layersLayout, planeId } from '../../src/viewer/layouts/layers.ts'
import { FIXTURES } from '../helpers/fixtures.ts'

const layered = await analyze({
  root: `${FIXTURES}/plain-ts`,
  cacheDir: false,
  config: ConfigSchema.parse({
    layers: [
      { name: 'app', match: ['src/app.ts', 'src/index.ts'] },
      { name: 'domain', match: 'src/shapes.ts' },
      { name: 'base', match: ['src/util.ts', 'src/types.ts'] },
    ],
    groups: [{ name: 'geometry', match: ['src/shapes.ts', 'src/types.ts'] }],
  }),
})
const layerOf = (n: GraphNode) => n.tags?.find(t => t.startsWith('layer:'))?.slice(6)

describe('configured layers', () => {
  it('tag each file with the first layer matching it, in configured order', () => {
    expect(layered.meta.layers).toEqual(['app', 'domain', 'base'])
    const tag = (id: string) => layerOf(layered.nodes.find(n => n.id === id)!)
    expect([tag('f:src/app.ts'), tag('f:src/shapes.ts'), tag('f:src/util.ts'), tag('f:src/lazy.ts')]).toEqual(['app', 'domain', 'base', undefined])
  })

  it('tag configured groups the same way', () => {
    expect(layered.meta.groups).toEqual(['geometry'])
    expect(layered.nodes.find(n => n.id === 'f:src/types.ts')!.tags).toContain('group:geometry')
    expect(layered.nodes.find(n => n.id === 'f:src/app.ts')!.tags ?? []).not.toContain('group:geometry')
  })
})

describe('layersLayout', () => {
  const layout = layersLayout({
    nodes: layered.nodes,
    rootId: 'd:.',
    isVisible: n => !n.tags?.includes('test'),
    order: layered.meta.layers!,
    layerOf,
  })

  it('stacks one plane per layer, top layer highest, files without a layer last', () => {
    const planes = ['app', 'domain', 'base', UNASSIGNED].map(l => layout.boxes.get(planeId(l))!)
    expect(planes.every(Boolean)).toBe(true)
    for (let i = 1; i < planes.length; i++) expect(planes[i].y).toBeLessThan(planes[i - 1].y)
  })

  it('puts every file on its layer’s plane and records the index of configured layers', () => {
    const plane = layout.boxes.get(planeId('domain'))!
    const shapes = layout.boxes.get('f:src/shapes.ts')!
    expect(shapes.y).toBeCloseTo(plane.y + plane.h + PLATFORM_H) // on d:src's platform, on the plane
    expect(Math.abs(shapes.x - plane.x)).toBeLessThan(plane.w / 2)
    expect(layout.layerIndex!.get('f:src/app.ts')).toBe(0)
    expect(layout.layerIndex!.get('f:src/util.ts')).toBe(2)
    // a file in no layer is placed (on the unassigned plane) but has no index: nothing of its points up
    expect(layout.boxes.has('f:src/lazy.ts')).toBe(true)
    expect(layout.layerIndex!.has('f:src/lazy.ts')).toBe(false)
  })

  it('splits a directory across planes, keeping its own id where most of its files are', () => {
    const fragments = [...layout.boxes.keys()].filter(id => baseId(id) === 'd:src')
    expect(fragments).toContain('d:src') // the unlayered files are the majority
    expect(fragments.length).toBe(4)
    expect(fragments.every(id => layout.placement.get(id) === 'district')).toBe(true)
  })
})

describe('groupedLayout', () => {
  it('puts each group’s files in folder districts inside the group, root files included', () => {
    const nodes: GraphNode[] = [
      { id: 'd:.', kind: 'directory', name: 'root' },
      { id: 'd:a', kind: 'directory', name: 'a', parent: 'd:.', path: 'a' },
      { id: 'f:top.ts', kind: 'file', name: 'top.ts', parent: 'd:.', path: 'top.ts', metrics: { loc: 50 } },
      { id: 'f:a/x.ts', kind: 'file', name: 'x.ts', parent: 'd:a', path: 'a/x.ts', metrics: { loc: 50 } },
      { id: 'f:a/y.ts', kind: 'file', name: 'y.ts', parent: 'd:a', path: 'a/y.ts', metrics: { loc: 50 } },
    ]
    const group: Record<string, string> = { 'f:top.ts': 'g1', 'f:a/x.ts': 'g1', 'f:a/y.ts': 'g2' }
    const layout = groupedLayout({
      nodes,
      rootId: 'd:.',
      isVisible: () => true,
      groups: [
        { id: 'g1', label: 'first' },
        { id: 'g2', label: 'second' },
      ],
      groupOf: f => group[f.id],
    })
    const inside = (id: string, outer: string) => {
      const a = layout.boxes.get(id)!
      const b = layout.boxes.get(outer)!
      return Math.abs(a.x - b.x) <= (b.w - a.w) / 2 + 1e-6 && Math.abs(a.z - b.z) <= (b.d - a.d) / 2 + 1e-6
    }
    expect(layout.names!.get('g1')).toBe('first')
    expect(inside('f:top.ts', 'g1')).toBe(true)
    expect(inside('f:a/y.ts', 'g2')).toBe(true)
    // folder a is split: its own id where x lives (tie → first group), a fragment in g2
    expect(layout.boxes.has('d:a')).toBe(true)
    expect(baseId([...layout.boxes.keys()].find(id => id.startsWith('d:a\u0000'))!)).toBe('d:a')
    expect(layout.boxes.has('d:.')).toBe(true) // the root, not a folder inside a group
  })
})

describe('autoLayers', () => {
  it('orders areas by longest dependency path, cycles sharing a level', () => {
    // ui → features → core, features ↔ helpers (cycle), scripts alone
    const edges = [
      { source: 'ui', target: 'features' },
      { source: 'features', target: 'core' },
      { source: 'features', target: 'helpers' },
      { source: 'helpers', target: 'features' },
      { source: 'ui', target: 'core' },
    ]
    const auto = autoLayers(['ui', 'features', 'helpers', 'core', 'scripts'], edges, id => id)
    expect(auto.order).toEqual(['level 1', 'level 2', 'level 3'])
    expect(auto.layerOfArea.get('ui')).toBe('level 1')
    expect(auto.layerOfArea.get('features')).toBe('level 2')
    expect(auto.layerOfArea.get('helpers')).toBe('level 2')
    expect(auto.layerOfArea.get('core')).toBe('level 3')
    expect(auto.layerOfArea.get('scripts')).toBe('level 3') // depends on nothing: the bottom
    expect(auto.labels.get('level 2')).toBe('level 2: features, helpers')
  })
})

describe('galaxy', () => {
  // two groups of ten, densely linked inside, one link between them
  const nodes = [...Array(20).keys()].map(i => ({ id: `n${i}`, group: i < 10 ? 'a' : 'b' }))
  const links = nodes.flatMap((n, i) => nodes.filter((m, j) => j > i && m.group === n.group && (i + j) % 3 === 0).map(m => ({ source: n.id, target: m.id })))
  links.push({ source: 'n0', target: 'n10' })

  it('is deterministic', () => {
    expect(simulateGalaxy({ nodes, links, ticks: 120 })).toEqual(simulateGalaxy({ nodes, links, ticks: 120 }))
  })

  it('keeps each group together', () => {
    const p = simulateGalaxy({ nodes, links, ticks: 200 })
    const dist = (a: string, b: string) => Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1], p[a][2] - p[b][2])
    const mean = (pairs: [string, string][]) => pairs.reduce((s, [a, b]) => s + dist(a, b), 0) / pairs.length
    const within: [string, string][] = []
    const across: [string, string][] = []
    for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) ((i < 10) === (j < 10) ? within : across).push([`n${i}`, `n${j}`])
    expect(mean(within)).toBeLessThan(mean(across) * 0.8)
  })

  it('starts from previous positions when it has them', () => {
    const first = simulateGalaxy({ nodes, links, ticks: 200 })
    const again = simulateGalaxy({ nodes, links, previous: first })
    const moved = Math.max(...nodes.map(n => Math.hypot(first[n.id][0] - again[n.id][0], first[n.id][1] - again[n.id][1], first[n.id][2] - again[n.id][2])))
    expect(moved).toBeLessThan(15)
  })

  it('builds large galaxies directory first, keeping directories and groups together', () => {
    // 4 directories of 8 in 2 groups; coarseAbove forces the two-pass path
    const big = [...Array(32).keys()].map(i => ({ id: `f${i}`, group: i < 16 ? 'a' : 'b', dir: `d${Math.floor(i / 8)}` }))
    const bigLinks = big.flatMap((n, i) => (i % 8 < 7 ? [{ source: n.id, target: big[i + 1].id }] : []))
    const p = simulateGalaxy({ nodes: big, links: bigLinks, coarseAbove: 10 })
    expect(Object.keys(p)).toHaveLength(32)
    expect(simulateGalaxy({ nodes: big, links: bigLinks, coarseAbove: 10 })).toEqual(p)
    const centroid = (ids: string[]) => [0, 1, 2].map(k => ids.reduce((a, id) => a + p[id][k], 0) / ids.length)
    const spreadOf = (ids: string[]) => {
      const c = centroid(ids)
      return ids.reduce((a, id) => a + Math.hypot(p[id][0] - c[0], p[id][1] - c[1], p[id][2] - c[2]), 0) / ids.length
    }
    const dirIds = (d: number) => big.filter(n => n.dir === `d${d}`).map(n => n.id)
    const [c0, c1, c2] = [0, 1, 2].map(d => centroid(dirIds(d)))
    // each directory is tighter than the distance to the next, and its own group is nearer than the other
    expect(spreadOf(dirIds(0))).toBeLessThan(Math.hypot(c0[0] - c1[0], c0[1] - c1[1], c0[2] - c1[2]))
    expect(Math.hypot(c0[0] - c1[0], c0[1] - c1[1], c0[2] - c1[2])).toBeLessThan(Math.hypot(c0[0] - c2[0], c0[1] - c2[1], c0[2] - c2[2]))
  })

  it('turns positions into stars and directory extents', () => {
    const graphNodes: GraphNode[] = [
      { id: 'd:.', kind: 'directory', name: 'root' },
      { id: 'd:src', kind: 'directory', name: 'src', parent: 'd:.' },
      { id: 'f:src/a.ts', kind: 'file', name: 'a.ts', parent: 'd:src', metrics: { loc: 100 } },
      { id: 'f:src/b.ts', kind: 'file', name: 'b.ts', parent: 'd:src', metrics: { loc: 4 } },
    ]
    const layout = galaxyLayout({ 'f:src/a.ts': [10, 0, 0], 'f:src/b.ts': [-10, 5, 0] }, graphNodes)
    const a = layout.boxes.get('f:src/a.ts')!
    expect(a.w).toBe(a.h)
    expect(a.y + a.h / 2).toBeCloseTo(0) // centered on its position
    expect(a.w).toBeGreaterThan(layout.boxes.get('f:src/b.ts')!.w)
    const src = layout.boxes.get('d:src')!
    expect(layout.placement.get('d:src')).toBe('cluster')
    expect(src.x - src.w / 2).toBeLessThanOrEqual(-10)
    expect(src.x + src.w / 2).toBeGreaterThanOrEqual(10)
    expect(layout.shape).toBe('sphere')
  })

  it('rings a star with its symbols as moons', () => {
    const star = { x: 0, y: -5, z: 0, w: 10, h: 10, d: 10 }
    const syms: GraphNode[] = ['a', 'b', 'c'].map((n, i) => ({ id: n, kind: 'symbol', name: n, range: [i + 1, 1, i + 2, 1], metrics: { loc: 9 } }))
    const { floors } = moonsFor(star, syms)
    expect(floors.map(f => f.id)).toEqual(['a', 'b', 'c'])
    for (const f of floors) expect(Math.hypot(f.box.x, f.box.z)).toBeGreaterThan(star.w / 2)
  })
})
