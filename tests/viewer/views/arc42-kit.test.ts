import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Graph, GraphNode } from '../../../src/core/model.ts'
import { World } from '../../../src/viewer/world.ts'
import { groupName, layerOfBlock, levelOneBlocks, topBlocks } from '../../../src/viewer/views/arc42-kit/blocks.ts'
import { ON_BOARD, board } from '../../../src/viewer/views/arc42-kit/board.ts'
import { Flows } from '../../../src/viewer/views/arc42-kit/flows.ts'
import { categorical, inkOf, toneColor } from '../../../src/viewer/views/arc42-kit/ink.ts'
import { SECTIONS } from '../../../src/viewer/views/arc42-kit/sections.ts'
import { GROUND, Sketch, at, dashes, level, roundCorners, roundedRect, wall } from '../../../src/viewer/views/arc42-kit/sketch.ts'
import type { P2 } from '../../../src/viewer/views/arc42-kit/sketch.ts'

const DARK = { background: '#0e1117', ground: '#131820', district: '#202733', selection: '#ffffff', accent: '#58a6ff' }
const LIGHT = { background: '#eef1f5', ground: '#e3e7ec', district: '#cdd4dd', selection: '#1f2328', accent: '#0969da' }

const length = (points: readonly P2[]) => points.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0)

describe('arc42 kit: surfaces', () => {
  it('places (u, v) on the ground, on a level and on a wall facing the camera', () => {
    expect(at(GROUND, 2, 3, 1).toArray()).toEqual([2, 1, 3])
    expect(at(level(10), 2, 3).toArray()).toEqual([2, 10, 3])
    // a wall: v runs down from its top, lift comes toward the camera
    expect(at(wall(-5, 20), 2, 3, 1).toArray()).toEqual([2, 17, -4])
  })
})

describe('arc42 kit: shapes', () => {
  it('outlines a rounded rectangle counter-clockwise, within its bounds, with the same point count at any radius', () => {
    const rect = { u: 10, v: -4, w: 20, h: 8 }
    const round = roundedRect(rect, 3)
    const sharp = roundedRect(rect, 0)
    expect(round).toHaveLength(sharp.length)
    for (const [u, v] of round) {
      expect(u).toBeGreaterThanOrEqual(-1e-9)
      expect(u).toBeLessThanOrEqual(20 + 1e-9)
      expect(v).toBeGreaterThanOrEqual(-8 - 1e-9)
      expect(v).toBeLessThanOrEqual(1e-9)
    }
    // shoelace: positive area means counter-clockwise; a rounded one loses its corners
    const area = (pts: P2[]) => pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2
    expect(area(sharp)).toBeCloseTo(160)
    expect(area(round)).toBeCloseTo(160 - (4 - Math.PI) * 9, 0)
    // a radius larger than the box is clamped to half its shorter side
    expect(roundedRect({ u: 0, v: 0, w: 4, h: 2 }, 10).every(([u, v]) => Math.abs(u) <= 2 + 1e-9 && Math.abs(v) <= 1 + 1e-9)).toBe(true)
  })

  it('rounds a corner without leaving it, and leaves a straight line alone', () => {
    const corner: P2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ]
    const r = roundCorners(corner, 2)
    expect(r[0]).toEqual([0, 0])
    expect(r[r.length - 1]).toEqual([10, 10])
    expect(r.some(p => p[0] === 10 && p[1] === 0)).toBe(false)
    expect(length(r)).toBeLessThan(20)
    expect(roundCorners([[0, 0], [5, 0], [10, 0]], 2).every(p => p[1] === 0)).toBe(true)
  })

  it('cuts a line into dashes of the given length and gap, across its bends', () => {
    const line: P2[] = [
      [0, 0],
      [5, 0],
      [5, 5],
    ]
    const pieces = dashes(line, { on: 2, off: 1 })
    // 10 long: dashes at 0–2, 3–5, 6–8, 9–10
    expect(pieces.map(p => Math.round(length(p) * 100) / 100)).toEqual([2, 2, 2, 1])
    expect(pieces[1][0]).toEqual([3, 0])
    expect(pieces[1][pieces[1].length - 1]).toEqual([5, 0])
    expect(pieces[2][0][0]).toBeCloseTo(5)
    expect(pieces[2][0][1]).toBeCloseTo(1)
    expect(dashes(line, { on: 2, off: 0 })).toEqual([line])
  })
})

describe('arc42 kit: a sketch', () => {
  const sketch = () => {
    const sk = new Sketch()
    const rect = { u: 0, v: 0, w: 20, h: 10 }
    board(sk, GROUND, { u: 0, v: 0, w: 60, h: 40 })
    sk.slab({ tone: 'cat:1', owner: 7 }, GROUND, rect, { r: 1, lift: ON_BOARD, height: 2, top: 'paper' })
    sk.ribbon({ tone: 'line', owner: 9 }, GROUND, [[12, 0], [25, 0]], { width: 0.5, lift: ON_BOARD + 0.02, head: 'end' })
    return sk.build()
  }

  it('picks the owner of what a ray meets first, and nothing beside it', () => {
    const d = sketch()
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 50, 0), new THREE.Vector3(0, -1, 0))
    expect(d.pick(ray)).toBe(7) // the slab, on top of the board
    ray.set(new THREE.Vector3(18, 50, 0), new THREE.Vector3(0, -1, 0))
    expect(d.pick(ray)).toBe(9) // the connector
    ray.set(new THREE.Vector3(-25, 50, 15), new THREE.Vector3(0, -1, 0))
    expect(d.pick(ray)).toBe(-1) // the board: drawn, but standing for nothing
    ray.set(new THREE.Vector3(100, 50, 0), new THREE.Vector3(0, -1, 0))
    expect(d.pick(ray)).toBeUndefined()
  })

  it('paints by tone and owner, and paints again without rebuilding', () => {
    const d = sketch()
    const ink = inkOf(DARK)
    const seen = new Set<string>()
    d.paint((tone, owner) => {
      seen.add(`${tone}@${owner}`)
      return owner === 7 ? new THREE.Color('#ff0000') : toneColor(ink, tone)
    })
    expect([...seen].sort()).toEqual(['board@-1', 'cat:1@7', 'edge@-1', 'line@9', 'paper@7'])
    const colors = (d.object.children[0] as THREE.Mesh).geometry.getAttribute('color')
    const red = Array.from({ length: colors.count }, (_, i) => colors.getX(i) === 1 && colors.getY(i) === 0).filter(Boolean).length
    expect(red).toBeGreaterThan(0)
    d.paint(() => new THREE.Color('#00ff00'))
    expect(colors.getY(0)).toBe(1)
    expect(d.stats().triangles).toBeGreaterThan(100)
    d.dispose()
  })
})

describe('arc42 kit: ink', () => {
  it('derives readable colors for both schemes', () => {
    const dark = inkOf(DARK)
    const light = inkOf(LIGHT)
    expect(dark.light).toBe(false)
    expect(light.light).toBe(true)
    // a board stands off the ground, and ink contrasts with paper
    expect(dark.board.equals(dark.ground)).toBe(false)
    expect(light.board.equals(light.ground)).toBe(false)
    const l = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }).l
    expect(Math.abs(l(dark.ink) - l(dark.paper))).toBeGreaterThan(0.5)
    expect(Math.abs(l(light.ink) - l(light.paper))).toBeGreaterThan(0.5)
    expect(inkOf(DARK)).toBe(dark) // cached per theme
  })

  it('resolves tones: names, categories and literal colors', () => {
    const ink = inkOf(LIGHT)
    expect(toneColor(ink, 'accent').getHexString()).toBe('0969da')
    expect(toneColor(ink, '#123456').getHexString()).toBe('123456')
    expect(toneColor(ink, 'cat:2').equals(categorical(2, ink))).toBe(true)
    expect(toneColor(ink, 'nonsense').equals(ink.line)).toBe(true)
    // pale categories darken on a light background
    expect(categorical(5, ink).getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThanOrEqual(0.5 + 1e-9)
  })
})

describe('arc42 kit: flows', () => {
  it('spreads dots along each path and moves them with time', () => {
    const flows = new Flows(
      [
        { points: [[0, 0, 0], [30, 0, 0]], tone: 'accent', spacing: 6 },
        { points: [[0, 0, 0], [0, 12, 0]], tone: 'line', spacing: 6, owner: 3 },
      ],
      { still: false },
    )
    expect(flows.stats()).toEqual({ flows: 2, dots: 7 })
    const x = () => {
      const m = new THREE.Matrix4()
      flows.object.getMatrixAt(0, m)
      return new THREE.Vector3().setFromMatrixPosition(m).x
    }
    expect(x()).toBeCloseTo(0)
    expect(flows.animate(500)).toBe(true)
    expect(x()).toBeCloseTo(6) // 12 units a second
    const still = new Flows([{ points: [[0, 0, 0], [30, 0, 0]], tone: 'accent' }], { still: true })
    expect(still.animate(500)).toBe(false)
    flows.dispose()
    still.dispose()
  })
})

describe('arc42 kit: sections', () => {
  it('orders the sections by chapter, after the other views', () => {
    const list = Object.values(SECTIONS)
    expect(list.map(s => s.number)).toEqual([3, 5, 6, 8, 11])
    expect(list.map(s => s.order)).toEqual([...list.map(s => s.order)].sort((a, b) => a - b))
    for (const s of list) expect(s.order).toBeGreaterThan(50) // after Transit
  })
})

describe('arc42 kit: top-level building blocks', () => {
  /** A file-level graph from file paths (directories made up), with lines of code per file. */
  const worldOf = (paths: [string, number, ...string[]][]) => {
    const nodes = new Map<string, GraphNode>([['d:.', { id: 'd:.', kind: 'directory', name: 'app', path: '' }]])
    for (const [path, loc, ...tags] of paths) {
      const parts = path.split('/')
      let parent = 'd:.'
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (!nodes.has(`d:${dir}`)) nodes.set(`d:${dir}`, { id: `d:${dir}`, kind: 'directory', name: parts[i - 1], path: dir, parent })
        parent = `d:${dir}`
      }
      nodes.set(`f:${path}`, { id: `f:${path}`, kind: 'file', name: parts[parts.length - 1], path, parent, tags, metrics: { loc } })
    }
    const graph: Graph = { meta: { name: 'app', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } }, nodes: [...nodes.values()], edges: [], sites: [] }
    return new World(graph)
  }
  const notTests = (n: GraphNode) => !n.tags?.includes('test')

  it('goes down through the folder holding the code to where it splits, keeping what lay beside the way', () => {
    const world = worldOf([
      ['src/app/page.tsx', 50],
      ['src/app/layout.tsx', 20],
      ['src/lib/db.ts', 100],
      ['src/lib/money.ts', 40],
      ['src/lib/sub/x.ts', 10],
      ['src/lib/c.ts', 0],
      ['src/lib/d.ts', 0],
      ['src/ui/Button.tsx', 30],
      ['src/main.ts', 5],
      ['prisma/seed.ts', 15],
      ['next.config.ts', 8],
      ['tests/a.test.ts', 99, 'test'],
      ['tests/b.test.ts', 99, 'test'],
    ])
    const top = topBlocks(world, notTests)
    expect(top.system).toBe('d:src')
    expect(top.blocks.map(b => [b.id, b.name, b.files.length, b.loose])).toEqual([
      ['d:src/lib', 'lib', 5, false],
      ['d:src/app', 'app', 2, false],
      ['d:src/ui', 'ui', 1, false],
      ['d:prisma', 'prisma', 1, false],
      ['d:.', 'app (own files)', 1, true],
      ['d:src', 'src (own files)', 1, true],
    ])
    expect(top.blocks[0].loc).toBe(150)
    expect(top.blockOf.get('f:src/lib/sub/x.ts')).toBe('d:src/lib')
    expect(top.blockOf.get('f:src/main.ts')).toBe('d:src')
    expect(top.blockOf.get('f:next.config.ts')).toBe('d:.')
    expect(top.blockOf.has('f:tests/a.test.ts')).toBe(false)
  })

  it('stays at the root when no folder holds nearly everything, and with tests shown they count', () => {
    const world = worldOf([
      ['src/a/x.ts', 1],
      ['src/b/y.ts', 1],
      ['tests/a.test.ts', 1, 'test'],
      ['tests/b.test.ts', 1, 'test'],
    ])
    expect(topBlocks(world, notTests).system).toBe('d:src')
    expect(topBlocks(world, () => true).system).toBe('d:.')
    expect(topBlocks(world, () => true).blocks.map(b => b.id)).toEqual(['d:src', 'd:tests'])
  })

  it('names the layer most of a block’s files are in', () => {
    const world = worldOf([
      ['src/lib/a.ts', 1, 'layer:lib'],
      ['src/lib/b.ts', 1, 'layer:lib'],
      ['src/lib/c.ts', 1, 'layer:app'],
      ['src/ui/d.ts', 1],
      ['src/x/e.ts', 1, 'layer:lib'],
      ['src/x/f.ts', 1, 'layer:app'],
    ])
    const layerOf = (n: GraphNode) => n.tags?.find(t => t.startsWith('layer:'))?.slice(6)
    const top = topBlocks(world, () => true)
    const of = (id: string) => layerOfBlock(top.blocks.find(b => b.id === id)!, world, layerOf, ['app', 'lib'])
    expect(of('d:src/lib')).toBe('lib')
    expect(of('d:src/ui')).toBeUndefined()
    expect(of('d:src/x')).toBe('app') // a tie goes to the higher layer
  })
})

describe('arc42 kit: top-level blocks by the toolbar’s grouping', () => {
  const worldOf = (paths: string[]) => {
    const nodes = new Map<string, GraphNode>([['d:.', { id: 'd:.', kind: 'directory', name: 'app', path: '' }]])
    for (const path of paths) {
      const parts = path.split('/')
      let parent = 'd:.'
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (!nodes.has(`d:${dir}`)) nodes.set(`d:${dir}`, { id: `d:${dir}`, kind: 'directory', name: parts[i - 1], path: dir, parent })
        parent = `d:${dir}`
      }
      nodes.set(`f:${path}`, { id: `f:${path}`, kind: 'file', name: parts[parts.length - 1], path, parent, metrics: { loc: 10 } })
    }
    const graph: Graph = { meta: { name: 'app', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } }, nodes: [...nodes.values()], edges: [], sites: [] }
    return new World(graph)
  }

  it('makes the groups the blocks, each at home in the deepest folder its files share', () => {
    const world = worldOf(['src/ui/a.ts', 'src/ui/b.ts', 'src/lib/c.ts', 'src/lib/deep/d.ts', 'src/lib/deep/e.ts', 'src/main.ts'])
    const grouping = {
      groups: [
        { id: 'module:0', label: 'src/lib · 3 files' },
        { id: 'module:1', label: 'src/ui · 3 files (67% there)' },
        { id: 'module:2', label: 'src · 0 files' },
      ],
      groupOf: (f: string) => (f.includes('/lib/') ? 'module:0' : 'module:1'),
    }
    const top = levelOneBlocks(world, () => true, grouping)
    expect(top.system).toBe('d:src') // where the folders split, as without grouping
    expect(top.blocks.map(b => [b.id, b.name, b.files.length, b.home, b.group])).toEqual([
      ['module:0', 'module 1 · lib', 3, 'd:src/lib', true],
      ['module:1', 'module 2 · ui', 3, 'd:src', true], // a group without files is no block
    ])
    expect(top.blockOf.get('f:src/main.ts')).toBe('module:1')
    // by folder, a block's home is the folder itself
    expect(levelOneBlocks(world, () => true, null).blocks.every(b => !b.group && b.home === b.id)).toBe(true)
  })

  it('names a group shortly: a layer or configured group by itself, a module by number and folder', () => {
    expect(groupName({ id: 'layer:server', label: 'level 2: src/server' })).toBe('server')
    expect(groupName({ id: 'module:5', label: 'src/lib/guide · 9 files (80% there)' })).toBe('module 6 · guide')
  })
})
