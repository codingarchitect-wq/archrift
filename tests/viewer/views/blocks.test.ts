import * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { GraphIndex } from '../../../src/core/graph-index.ts'
import type { Graph, GraphEdge, GraphNode } from '../../../src/core/model.ts'
import { overview } from '../../../src/server/views.ts'
import { autoLayers } from '../../../src/core/auto-layers.ts'
import { levelOneBlocks, topBlocks } from '../../../src/viewer/views/arc42-kit/blocks.ts'
import { LOLLIPOP, diagram } from '../../../src/viewer/views/blocks/diagram.ts'
import type { Diagram, DiagramEdge, DiagramNode } from '../../../src/viewer/views/blocks/diagram.ts'
import { MAX_LOOSE, buildModel, chainKey, focusOf, stubId } from '../../../src/viewer/views/blocks/model.ts'
import type { BlocksInput, BlocksModel } from '../../../src/viewer/views/blocks/model.ts'
import { DEFAULT_SCREEN, HOME, compose, framing, mainLinks, shownLinks, unitSize, worldOf } from '../../../src/viewer/views/blocks/scene.ts'
import { World, depGraph } from '../../../src/viewer/world.ts'
import { analyzeFixture } from '../../helpers/fixtures.ts'

/** What the view hands the model: tests hidden, every edge kind, layers derived from dependencies (the fixture configures none). */
function inputOf(world: World, selected: string | null = null): BlocksInput {
  const visible = new Set(world.graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test')).map(n => n.id))
  const g = depGraph(world, `test|${visible.size}`, [], world.graph.meta.targets[0], id => visible.has(id))
  const files = [...visible]
  const areas = [...new Set(files.map(f => world.areaOf.get(f)!))]
  const edges = [...g.out].flatMap(([a, t]) => t.filter(b => b.startsWith('f:')).map(b => ({ source: world.areaOf.get(a)!, target: world.areaOf.get(b)! })))
  const auto = autoLayers(areas, edges, id => world.node(id)?.path ?? id)
  return { world, visible, weight: g.weight, incoming: g.in, layers: { order: auto.order, layerOf: n => auto.layerOfArea.get(world.areaOf.get(n.id) ?? '') }, selected }
}

const names = (m: BlocksModel, level: number) => m.levels[level].units.map(u => u.id)
const linkIds = (m: BlocksModel, level: number) => {
  const l = m.levels[level]
  const id = (i: number) => (i < l.units.length ? l.units[i].id : `stub:${l.stubs[i - l.units.length].select}`)
  return l.links.map(x => `${id(x.from)} > ${id(x.to)}${x.up ? ' ^' : ''}`).sort()
}

describe('building blocks: the model', () => {
  let world: World
  beforeAll(async () => {
    world = new World(overview(new GraphIndex(await analyzeFixture('fullstack'))))
  })

  it('makes the top-level folders level 1, with their dependencies lifted and their provided interfaces', () => {
    const m = buildModel(inputOf(world))
    expect(m.levels).toHaveLength(1)
    expect(m.system.dir).toBe('d:src')
    expect(names(m, 0).sort()).toEqual(['d:prisma', 'd:src/app', 'd:src/client', 'd:src/lib', 'd:src/local', 'd:src/server', 'd:src/ui'])
    expect(linkIds(m, 0)).toEqual([
      'd:src/app > d:src/client',
      'd:src/app > d:src/lib',
      'd:src/app > d:src/ui',
      'd:src/client > d:src/server',
      'd:src/local > d:src/lib',
      'd:src/server > d:prisma',
      'd:src/ui > d:src/lib',
    ])
    const unit = (id: string) => m.levels[0].units.find(u => u.id === id)!
    // the server's files the client calls into; nothing uses the pages
    expect(unit('d:src/server').provided).toBe(3)
    expect(unit('d:src/app').provided).toBe(0)
    expect(unit('d:src/app').files).toHaveLength(4)
    expect(m.levels[0].title).toBe('Level 1 · fullstack')
  })

  it('opens the selected block into its white box: subfolders, its own files, and the neighbors at the edge', () => {
    const m = buildModel(inputOf(world, 'd:src/server'))
    expect(m.levels).toHaveLength(2)
    const wb = m.levels[1]
    expect(wb.title).toBe('Level 2 · server')
    expect(m.levels[0].units[wb.opened!].id).toBe('d:src/server')
    expect(wb.units.map(u => [u.id, u.kind, u.opens])).toEqual([
      ['d:src/server/routers', 'folder', true],
      ['f:src/server/trpc.ts', 'file', false],
    ])
    // the client uses the server: above; the server uses the Prisma schema: below
    expect(wb.stubs.map(s => [s.select, s.side])).toEqual([
      ['d:src/client', 'top'],
      ['d:prisma', 'bottom'],
    ])
    expect(wb.stubs[0].id).toBe(stubId('d:src/client', 2))
    expect(linkIds(m, 1)).toEqual([
      'd:src/server/routers > f:src/server/trpc.ts',
      'd:src/server/routers > stub:d:prisma',
      'stub:d:src/client > d:src/server/routers',
      'stub:d:src/client > f:src/server/trpc.ts',
    ])
  })

  it('goes one more level down along the selection’s folders, with the white box above’s blocks as neighbors', () => {
    const m = buildModel(inputOf(world, 'f:src/server/routers/accounts.ts'))
    expect(m.levels.map(l => l.title)).toEqual(['Level 1 · fullstack', 'Level 2 · server', 'Level 3 · routers'])
    expect(names(m, 2)).toEqual(['f:src/server/routers/accounts.ts', 'f:src/server/routers/index.ts'])
    // trpc.ts sits beside routers in the server's white box; the client and the schema are level-1 blocks
    expect(m.levels[2].stubs.map(s => s.select).sort()).toEqual(['d:prisma', 'd:src/client', 'f:src/server/trpc.ts'])
    // the focus: the opened blocks above, the file itself at the bottom
    expect(focusOf(m.levels, world, 'f:src/server/routers/accounts.ts')).toEqual([m.levels[1].opened, m.levels[2].opened, 0])
  })

  it('opens no white box for a file of its own (it has none) and none for what lies outside every block', () => {
    expect(buildModel(inputOf(world, 'f:src/server/trpc.ts')).levels).toHaveLength(2)
    expect(buildModel(inputOf(world, 'd:.')).levels).toHaveLength(1)
    expect(buildModel(inputOf(world, 'x:npm:nothing')).levels).toHaveLength(1)
  })

  it('keys the white boxes a selection opens, so selecting within them doesn’t rebuild the layout', () => {
    const top = topBlocks(world, n => !n.tags?.includes('test'))
    const key = (sel: string | null) => chainKey(world, top, sel)
    expect(key(null)).toBe('')
    expect(key('d:src/server')).toBe('d:src/server|')
    expect(key('f:src/server/trpc.ts')).toBe('d:src/server|')
    expect(key('d:src/server/routers')).toBe('d:src/server|d:src/server/routers')
    expect(key('f:src/server/routers/accounts.ts')).toBe('d:src/server|d:src/server/routers')
    expect(key('s:src/server/routers/accounts.ts#accountsRouter')).toBe('d:src/server|d:src/server/routers')
    expect(key('x:npm:nothing')).toBe('')
  })
})

describe('building blocks: the dependencies drawn, by the toolbar’s edges option', () => {
  let world: World
  beforeAll(async () => {
    world = new World(overview(new GraphIndex(await analyzeFixture('fullstack'))))
  })

  it('draws the main ones, all, the focused block’s, those breaking a rule, or none', () => {
    // the tRPC client importing from the server breaks a rule
    const violating = (a: string, b: string) => a === 'f:src/client/trpc.ts' && b.startsWith('f:src/server/')
    const m = buildModel({ ...inputOf(world), violating })
    const level = m.levels[0]
    const id = (i: number) => `${level.units[level.links[i].from].id} > ${level.units[level.links[i].to].id}`
    expect(shownLinks(level, 'all', undefined)).toHaveLength(level.links.length)
    expect(shownLinks(level, 'main', undefined)).toEqual(mainLinks(level))
    expect(shownLinks(level, 'none', undefined)).toEqual([])
    expect(shownLinks(level, 'violations', undefined).map(id)).toEqual(['d:src/client > d:src/server'])
    const client = level.units.findIndex(u => u.id === 'd:src/client')
    expect(shownLinks(level, 'selection', client).map(id).sort()).toEqual(['d:src/app > d:src/client', 'd:src/client > d:src/server'])
    expect(shownLinks(level, 'selection', undefined)).toEqual([])
    // the scene remembers what it draws
    expect(compose(m, 'violations').mode).toBe('violations')
    expect(compose(m, 'violations').boards[0].shown).toHaveLength(1)
  })
})

describe('building blocks: level 1 by the toolbar’s grouping', () => {
  let world: World
  beforeAll(async () => {
    world = new World(overview(new GraphIndex(await analyzeFixture('fullstack'))))
  })
  // two groups, as the toolbar's configured groups would be: the server side and the rest
  const sides = {
    groups: [
      { id: 'layer:client', label: 'client' },
      { id: 'layer:server', label: 'server' },
    ],
    groupOf: (f: string) => (/^f:(src\/server|prisma)\//.test(f) ? 'layer:server' : 'layer:client'),
  }
  const grouped = (selected: string | null, previous?: string) => buildModel({ ...inputOf(world, selected), grouping: sides, previous, by: 'configured group' })

  it('makes the groups the blocks of level 1, with the dependencies between them', () => {
    const m = grouped(null)
    expect(names(m, 0).sort()).toEqual(['layer:client', 'layer:server'])
    expect(m.levels[0].units.map(u => u.name).sort()).toEqual(['client', 'server'])
    expect(linkIds(m, 0)).toEqual(['layer:client > layer:server'])
    expect(m.levels[0].title).toBe('Level 1 · fullstack · by configured group')
  })

  it('opens a group into the folders its files are in, below the one they share', () => {
    const m = grouped('layer:client')
    expect(m.levels).toHaveLength(2)
    expect(names(m, 1).sort()).toEqual(['d:src/app', 'd:src/client', 'd:src/lib', 'd:src/local', 'd:src/ui'])
    // and a file of it opens the group, then its folder
    const deeper = grouped('f:src/client/service.ts')
    expect(deeper.levels.map(l => l.container)).toEqual(['d:src', 'layer:client', 'd:src/client'])
  })

  it('keeps the group open when a folder in its white box is selected, though other groups have files there too', () => {
    // src holds files of both groups: the one open before stays, else the one with most files there
    expect(grouped('d:src', 'layer:server').levels[1].container).toBe('layer:server')
    expect(grouped('d:src').levels[1].container).toBe('layer:client')
    const top = levelOneBlocks(world, n => inputOf(world).visible.has(n.id), sides)
    expect(chainKey(world, top, 'f:src/client/service.ts')).toBe('layer:client|d:src/client')
    expect(chainKey(world, top, 'layer:server')).toBe('layer:server|')
    // the server group shares only the root (src/server and prisma): src is the folder below it
    expect(chainKey(world, top, 'd:src', 'layer:server')).toBe('layer:server|d:src')
  })
})

describe('building blocks: grouping a folder’s many files', () => {
  /** A folder with `n` loose files in pairs that use each other (and one file alone), plus a user outside it. */
  function pairs(n: number): World {
    const nodes: GraphNode[] = [
      { id: 'd:.', kind: 'directory', name: 'app', path: '' },
      { id: 'd:src', kind: 'directory', name: 'src', path: 'src', parent: 'd:.' },
      { id: 'd:src/lib', kind: 'directory', name: 'lib', path: 'src/lib', parent: 'd:src' },
      { id: 'd:src/ui', kind: 'directory', name: 'ui', path: 'src/ui', parent: 'd:src' },
      { id: 'f:src/ui/page.ts', kind: 'file', name: 'page.ts', path: 'src/ui/page.ts', parent: 'd:src/ui', metrics: { loc: 10 } },
    ]
    const edges: GraphEdge[] = []
    for (let i = 0; i < n; i++) {
      nodes.push({ id: `f:src/lib/f${i}.ts`, kind: 'file', name: `f${i}.ts`, path: `src/lib/f${i}.ts`, parent: 'd:src/lib', metrics: { loc: 10 + i } })
      if (i % 2 && i < n - 1) edges.push({ source: `f:src/lib/f${i}.ts`, target: `f:src/lib/f${i - 1}.ts`, kind: 'calls', count: 3, targets: ['default'], confidence: 'exact' })
      // the page uses the first of each pair: the most used file names the group
      if (i % 2 === 0) edges.push({ source: 'f:src/ui/page.ts', target: `f:src/lib/f${i}.ts`, kind: 'calls', count: 1, targets: ['default'], confidence: 'exact' })
    }
    const graph: Graph = {
      meta: { name: 'app', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } },
      nodes,
      edges,
      sites: [],
    }
    return new World(graph)
  }

  it('shows a few files one by one', () => {
    const m = buildModel(inputOf(pairs(MAX_LOOSE), 'd:src/lib'))
    expect(m.levels[1].units.every(u => u.kind === 'file')).toBe(true)
    expect(m.levels[1].units).toHaveLength(MAX_LOOSE)
  })

  it('groups many files into the modules their dependencies form, named after the most used file, the rest together', () => {
    const world = pairs(21)
    const m = buildModel(inputOf(world, 'd:src/lib'))
    const units = m.levels[1].units
    // ten pairs: eight groups of two, then the last two pairs and the lone file together
    expect(units.filter(u => u.kind === 'group' && u.name !== 'other files')).toHaveLength(8)
    const rest = units.find(u => u.name === 'other files')!
    expect(rest.files).toHaveLength(5)
    expect(rest.note).toBe('5 files')
    const pair = units.find(u => u.files.includes('f:src/lib/f1.ts'))!
    expect(pair.files.sort()).toEqual(['f:src/lib/f0.ts', 'f:src/lib/f1.ts'])
    expect(pair.name).toBe('f0')
    expect(pair.select).toBe('f:src/lib/f0.ts')
    expect(pair.note).toBe('+1 files')
    expect(units.reduce((n, u) => n + u.files.length, 0)).toBe(21)
    // selecting a file of a group puts the group in focus
    expect(focusOf(m.levels, world, 'f:src/lib/f1.ts')[1]).toBe(units.indexOf(pair))
  })
})

describe('building blocks: a folder of files tied together only through a hub', () => {
  /** An index using `n` files that use nothing else: one module, which says nothing. */
  function hub(n: number): World {
    const nodes: GraphNode[] = [
      { id: 'd:.', kind: 'directory', name: 'app', path: '' },
      { id: 'd:src', kind: 'directory', name: 'src', path: 'src', parent: 'd:.' },
      { id: 'd:src/routers', kind: 'directory', name: 'routers', path: 'src/routers', parent: 'd:src' },
      { id: 'd:src/ui', kind: 'directory', name: 'ui', path: 'src/ui', parent: 'd:src' },
      { id: 'f:src/ui/page.ts', kind: 'file', name: 'page.ts', path: 'src/ui/page.ts', parent: 'd:src/ui', metrics: { loc: 10 } },
      { id: 'f:src/ui/other.ts', kind: 'file', name: 'other.ts', path: 'src/ui/other.ts', parent: 'd:src/ui', metrics: { loc: 10 } },
      { id: 'f:src/routers/index.ts', kind: 'file', name: 'index.ts', path: 'src/routers/index.ts', parent: 'd:src/routers', metrics: { loc: 10 } },
    ]
    // two pages use the index: the most used file
    const edges: GraphEdge[] = ['page', 'other'].map(p => ({ source: `f:src/ui/${p}.ts`, target: 'f:src/routers/index.ts', kind: 'calls' as const, count: 1, targets: ['default'], confidence: 'exact' as const }))
    for (let i = 0; i < n; i++) {
      nodes.push({ id: `f:src/routers/r${i}.ts`, kind: 'file', name: `r${i}.ts`, path: `src/routers/r${i}.ts`, parent: 'd:src/routers', metrics: { loc: 100 - i } })
      edges.push({ source: 'f:src/routers/index.ts', target: `f:src/routers/r${i}.ts`, kind: 'imports', count: 1, targets: ['default'], confidence: 'exact' })
    }
    const meta = { name: 'app', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } }
    return new World({ meta, nodes, edges, sites: [] })
  }

  it('shows the files one by one while there aren’t too many', () => {
    const units = buildModel(inputOf(hub(19), 'd:src/routers')).levels[1].units
    expect(units).toHaveLength(20)
    expect(units.every(u => u.kind === 'file')).toBe(true)
  })

  it('beyond that, the most used one by one and the rest together', () => {
    const units = buildModel(inputOf(hub(40), 'd:src/routers')).levels[1].units
    expect(units).toHaveLength(MAX_LOOSE)
    expect(units.filter(u => u.kind === 'file')).toHaveLength(MAX_LOOSE - 1)
    // the index, used by two pages, is among those shown one by one
    expect(units.filter(u => u.kind === 'file').map(u => u.id)).toContain('f:src/routers/index.ts')
    const rest = units.find(u => u.kind === 'group')!
    expect([rest.name, rest.files.length]).toEqual(['other files', 41 - (MAX_LOOSE - 1)])
  })
})

describe('building blocks: the diagram', () => {
  /** A layered graph: rows of nodes of several sizes, edges down, up, along a row and across several rows. */
  const nodes: DiagramNode[] = [
    { w: 20, h: 9, row: 0, rank: 0, lollipop: true },
    { w: 12, h: 7, row: 0, rank: 1, lollipop: true },
    { w: 30, h: 14, row: 1, rank: 0, lollipop: true },
    { w: 14, h: 7, row: 2, rank: 0, lollipop: true },
    { w: 14, h: 7, row: 2, rank: 1, lollipop: true },
    { w: 26, h: 12, row: 3, rank: 0, lollipop: true },
    { w: 12, h: 7, row: 3, rank: 1, lollipop: true },
    { w: 14, h: 5, row: 4, rank: 0, lollipop: false },
  ]
  const edges: DiagramEdge[] = [
    { from: 0, to: 2, weight: 50 },
    { from: 0, to: 5, weight: 20 }, // across two rows
    { from: 1, to: 0, weight: 3 }, // along a row
    { from: 2, to: 3, weight: 9 },
    { from: 2, to: 5, weight: 40 },
    { from: 3, to: 2, weight: 2 }, // up
    { from: 4, to: 5, weight: 7 },
    { from: 5, to: 0, weight: 1 }, // up across rows
    { from: 6, to: 7, weight: 4 }, // into a node without a lollipop
    { from: 7, to: 1, weight: 1 },
  ]
  let d: Diagram
  beforeAll(() => {
    d = diagram(nodes, edges, { header: 10, minWidth: 60 })
  })

  it('places every node in its row, rows top to bottom, inside the board', () => {
    const rowOf = (i: number) => d.rows.findIndex(r => d.boxes[i].v > r.top && d.boxes[i].v < r.bottom)
    expect(nodes.map((_, i) => rowOf(i))).toEqual([0, 0, 1, 2, 2, 3, 3, 4])
    for (const b of d.boxes) {
      expect(b.u - b.w / 2).toBeGreaterThan(0)
      expect(b.u + b.w / 2).toBeLessThan(d.width)
      expect(b.v - b.h / 2).toBeGreaterThan(10)
      expect(b.v + b.h / 2).toBeLessThan(d.height)
    }
  })

  it('routes every connector orthogonally, from its source’s side to its target', () => {
    expect(d.wires).toHaveLength(edges.length)
    for (const w of d.wires) {
      const e = edges[w.edge]
      for (let k = 1; k < w.points.length; k++) {
        const [a, b] = [w.points[k - 1], w.points[k]]
        expect(Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6, `edge ${w.edge} segment ${k}`).toBe(true)
      }
      const [from, to] = [d.boxes[e.from], d.boxes[e.to]]
      const start = w.points[0]
      expect(Math.abs(start[1] - (from.v - from.h / 2)) < 1e-6 || Math.abs(start[1] - (from.v + from.h / 2)) < 1e-6).toBe(true)
      expect(Math.abs(start[0] - from.u)).toBeLessThanOrEqual(from.w / 2)
      const tip = w.points[w.points.length - 1]
      if (w.end === 'lollipop') {
        const ring = d.lollipops[e.to]!
        expect(tip[0]).toBeCloseTo(ring[0])
        expect(tip[1]).toBeCloseTo(ring[1] - LOLLIPOP.r - LOLLIPOP.ring / 2)
      } else expect(tip[1]).toBeCloseTo(w.end === 'bottom' ? to.v + to.h / 2 : to.v - to.h / 2)
    }
    // up: into the target's bottom; down or along a row: its lollipop; no lollipop: its top
    expect(d.wires.map(w => w.end)).toEqual(['lollipop', 'lollipop', 'lollipop', 'lollipop', 'lollipop', 'bottom', 'lollipop', 'bottom', 'top', 'bottom'])
  })

  it('never runs a connector through a block', () => {
    const crosses = (a: readonly [number, number], b: readonly [number, number], box: Diagram['boxes'][number]) => {
      // the segment against the box shrunk a hair (touching a side where a connector starts or ends is fine)
      const [l, r, t, bt] = [box.u - box.w / 2 + 0.01, box.u + box.w / 2 - 0.01, box.v - box.h / 2 + 0.01, box.v + box.h / 2 - 0.01]
      const [u0, u1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
      const [v0, v1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
      return u1 > l && u0 < r && v1 > t && v0 < bt
    }
    for (const w of d.wires)
      for (let k = 1; k < w.points.length; k++)
        d.boxes.forEach((box, i) => expect(crosses(w.points[k - 1], w.points[k], box), `edge ${w.edge} segment ${k} through node ${i}`).toBe(false))
  })

  it('keeps runs in a channel apart, except those merging into one lollipop', () => {
    const runs = d.wires.flatMap(w =>
      w.points.slice(1).flatMap((p, k) => {
        const a = w.points[k]
        return Math.abs(a[1] - p[1]) < 1e-6 && Math.abs(a[0] - p[0]) > 1e-6 ? [{ edge: w.edge, v: a[1], lo: Math.min(a[0], p[0]), hi: Math.max(a[0], p[0]) }] : []
      }),
    )
    for (const x of runs)
      for (const y of runs) {
        if (x === y || x.edge === y.edge || Math.abs(x.v - y.v) > 1e-6) continue
        const sameTarget = edges[x.edge].to === edges[y.edge].to
        if (!sameTarget) expect(x.hi < y.lo || y.hi < x.lo, `edges ${x.edge} and ${y.edge} share a stretch`).toBe(true)
      }
  })

  it('is deterministic', () => {
    expect(diagram(nodes, edges, { header: 10, minWidth: 60 })).toEqual(d)
  })
})

describe('building blocks: the scene', () => {
  let world: World
  beforeAll(async () => {
    world = new World(overview(new GraphIndex(await analyzeFixture('fullstack'))))
  })

  it('keeps the main links: each block’s strongest, the heavy ones and those pointing up', () => {
    const level = {
      depth: 1,
      container: 'd:.',
      title: '',
      units: ['a', 'b', 'c', 'd'].map(id => ({ id, select: id, name: id, kind: 'folder' as const, files: [], loc: 0, provided: 0, opens: false })),
      links: [
        { from: 0, to: 1, weight: 1000, pairs: 1, up: false },
        { from: 0, to: 2, weight: 1, pairs: 1, up: false },
        { from: 0, to: 3, weight: 2, pairs: 1, up: false },
        { from: 1, to: 2, weight: 50, pairs: 1, up: false },
        { from: 2, to: 0, weight: 1, pairs: 1, up: true },
        { from: 3, to: 2, weight: 3, pairs: 1, up: false },
      ],
      stubs: [],
      moreStubs: 0,
      unitOf: new Map(),
    }
    // a>c (1) is nobody's strongest and light; everything else stays
    expect(mainLinks(level)).toEqual([0, 2, 3, 4, 5])
  })

  it('floats each white box above and behind the board it opens from', () => {
    const scene = compose(buildModel(inputOf(world, 'f:src/server/routers/accounts.ts')), 'main')
    expect(scene.boards).toHaveLength(3)
    for (let k = 1; k < 3; k++) {
      const [a, b] = [scene.boards[k - 1], scene.boards[k]]
      expect(b.y).toBeGreaterThan(a.y + 10)
      expect(b.z + b.d / 2).toBeLessThan(a.z + a.d / 2)
    }
    // a unit's place in the world is on its board
    const b = scene.boards[0]
    const [x, y, z] = worldOf(b, b.diagram.boxes[0].u, b.diagram.boxes[0].v)
    expect(Math.abs(x - b.x)).toBeLessThanOrEqual(b.w / 2)
    expect(Math.abs(z - b.z)).toBeLessThanOrEqual(b.d / 2)
    expect(y).toBe(b.y)
  })

  it('frames the boards so every corner is in the part of the window the panels leave free', () => {
    const scene = compose(buildModel(inputOf(world, 'f:src/server/routers/accounts.ts')), 'all')
    const screen = { ...DEFAULT_SCREEN, right: 0.26 }
    const frame = framing(scene.boards, screen)
    const camera = new THREE.PerspectiveCamera(50, screen.aspect, 0.5, 1e5)
    const length = Math.hypot(...HOME)
    camera.position.set(...frame.center).addScaledVector(new THREE.Vector3(...HOME).divideScalar(length), frame.size * length)
    camera.lookAt(...frame.center)
    camera.updateMatrixWorld()
    for (const b of scene.boards)
      for (const [dx, dz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const p = new THREE.Vector3(b.x + (dx * b.w) / 2, b.y, b.z + (dz * b.d) / 2).project(camera)
        expect(p.x).toBeGreaterThanOrEqual(-1)
        expect(p.x).toBeLessThanOrEqual(1 - 2 * screen.right + 1e-3)
        expect(p.y).toBeGreaterThanOrEqual(-1 + 2 * screen.bottom - 1e-3)
        expect(p.y).toBeLessThanOrEqual(1 - 2 * screen.top + 1e-3)
      }
  })

  it('sizes a block by its code, never narrower than its name', () => {
    const unit = (name: string, loc: number) => ({ id: name, select: name, name, kind: 'folder' as const, files: [], loc, provided: 0, opens: true })
    expect(unitSize(unit('lib', 40_000)).w).toBeGreaterThan(unitSize(unit('lib', 400)).w)
    expect(unitSize(unit('a-very-long-folder-name', 1)).w).toBeGreaterThanOrEqual('a-very-long-folder-name'.length)
    expect(unitSize(unit('x', 1_000_000)).h).toBeLessThanOrEqual(15)
  })
})
