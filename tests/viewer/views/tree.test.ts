import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../../../src/core/model.ts'
import type { Visibility } from '../../../src/viewer/controller.ts'
import type { Layout } from '../../../src/viewer/layouts/types.ts'
import type { SceneEngine } from '../../../src/viewer/scene/engine.ts'
import type { State } from '../../../src/viewer/store.ts'
import view from '../../../src/viewer/views/tree/index.ts'
import { Bark, remember } from '../../../src/viewer/views/tree/bark.ts'
import { growTree, leafRadius, shownTree } from '../../../src/viewer/views/tree/layout.ts'
import type { TreeGeometry, Vec3 } from '../../../src/viewer/views/tree/layout.ts'
import type { ViewContext } from '../../../src/viewer/views/types.ts'
import { World } from '../../../src/viewer/world.ts'
import { analyzeFixture } from '../../helpers/fixtures.ts'

const noTests = (n: GraphNode) => !n.tags?.includes('test')
const lookup = (nodes: readonly GraphNode[]) => {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return (id: string) => byId.get(id)
}
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** src/areaN/featureN/subN folders, `perFolder` files in each: 10,000 files are about 600 folders. */
function synthetic(files: number, perFolder = 17): GraphNode[] {
  const nodes: GraphNode[] = [{ id: 'd:.', kind: 'directory', name: 'root' }]
  const seen = new Set<string>()
  for (let i = 0; i < files; i++) {
    const folder = Math.floor(i / perFolder)
    const parts = ['src', `area${folder % 8}`, `feature${Math.floor(folder / 8) % 13}`, `sub${Math.floor(folder / 104)}`]
    let parent = 'd:.'
    for (let k = 1; k <= parts.length; k++) {
      const path = parts.slice(0, k).join('/')
      if (!seen.has(path)) {
        seen.add(path)
        nodes.push({ id: `d:${path}`, kind: 'directory', name: parts[k - 1], parent, path })
      }
      parent = `d:${path}`
    }
    const path = `${parts.join('/')}/m${i}.ts`
    nodes.push({ id: `f:${path}`, kind: 'file', name: `m${i}.ts`, parent, path, metrics: { loc: 20 + ((i * 7919) % 600) } })
  }
  return nodes
}

function everyNumber(tree: TreeGeometry, layout: Layout) {
  return [
    ...tree.branches.flatMap(b => [...b.base, ...b.bend, ...b.tip, b.crown]),
    ...[...tree.leaves.values()].flatMap(l => [...l.center, l.r]),
    ...[...layout.boxes.values()].flatMap(b => [b.x, b.y, b.z, b.w, b.h, b.d]),
    ...layout.home,
    ...layout.center,
    layout.size,
  ]
}

function leavesApart(tree: TreeGeometry) {
  const leaves = [...tree.leaves.values()]
  let overlaps = 0
  for (let i = 0; i < leaves.length; i++)
    for (let j = i + 1; j < leaves.length; j++) if (distance(leaves[i].center, leaves[j].center) < leaves[i].r + leaves[j].r - 1e-6) overlaps++
  return overlaps === 0
}

describe('the tree layout', async () => {
  const fixtures = [await analyzeFixture('plain-ts'), await analyzeFixture('fullstack')]

  it('makes every visible file a leaf and every folder holding one a fork', () => {
    for (const g of fixtures) {
      const tree = growTree({ nodes: g.nodes, rootId: 'd:.', isVisible: noTests })
      const { layout } = shownTree(tree, lookup(g.nodes), noTests)
      expect(layout).toMatchObject({ view: 'tree', shape: 'sphere', arcAnchor: 'center', ground: true, openFile: 'moons' })
      for (const f of g.nodes.filter(n => n.kind === 'file')) {
        if (!noTests(f)) {
          expect(layout.boxes.has(f.id)).toBe(false)
          continue
        }
        const b = layout.boxes.get(f.id)!
        expect(layout.placement.get(f.id)).toBe('building')
        expect([b.w, b.h, b.d]).toEqual(Array(3).fill(2 * leafRadius(f.metrics?.loc ?? 0)))
      }
      const holds = (dir: GraphNode) => g.nodes.some(f => f.kind === 'file' && noTests(f) && f.path?.startsWith(dir.path ? `${dir.path}/` : ''))
      for (const d of g.nodes.filter(n => n.kind === 'directory')) expect(layout.placement.get(d.id)).toBe(holds(d) ? 'cluster' : undefined)
    }
    expect(fixtures[1].nodes.find(n => n.id === 'd:tests')).toBeDefined() // only tests there: no branch
  })

  it('has no NaNs', () => {
    for (const g of fixtures) {
      const tree = growTree({ nodes: g.nodes, rootId: 'd:.', isVisible: () => true })
      const { layout } = shownTree(tree, lookup(g.nodes), () => true)
      expect(everyNumber(tree, layout).every(Number.isFinite)).toBe(true)
    }
    const empty = growTree({ nodes: fixtures[0].nodes, rootId: 'd:.', isVisible: n => n.kind !== 'file' })
    expect(everyNumber(empty, shownTree(empty, lookup(fixtures[0].nodes), () => true).layout).every(Number.isFinite)).toBe(true)
  })

  it('is deterministic', () => {
    const g = fixtures[1]
    const once = growTree({ nodes: g.nodes, rootId: 'd:.', isVisible: noTests })
    const again = growTree({ nodes: [...g.nodes].reverse(), rootId: 'd:.', isVisible: noTests })
    expect(again.branches).toEqual(once.branches)
    expect([...again.leaves].sort()).toEqual([...once.leaves].sort())
  })

  it('grows the trunk from the ground and every branch from its parent’s fork', () => {
    const tree = growTree({ nodes: fixtures[1].nodes, rootId: 'd:.', isVisible: noTests })
    const [trunk, ...rest] = tree.branches
    expect(trunk).toMatchObject({ id: 'd:.', parent: -1, depth: 0, base: [0, 0, 0] })
    expect(trunk.tip[1]).toBeGreaterThan(0)
    expect([trunk.tip[0], trunk.tip[2]]).toEqual([0, 0])
    for (const b of rest) {
      expect(b.base).toEqual(tree.branches[b.parent].tip)
      expect(b.depth).toBe(tree.branches[b.parent].depth + 1)
    }
    for (const leaf of tree.leaves.values()) expect(leaf.center[1] - leaf.r).toBeGreaterThanOrEqual(0)
  })

  it('hangs a folder’s leaves at its fork, and its sub-folders’ further out', () => {
    for (const nodes of [fixtures[1].nodes, synthetic(600, 9)]) {
      const tree = growTree({ nodes, rootId: 'd:.', isVisible: noTests })
      const under = (leaf: number, folder: number) => {
        for (let b = leaf; b >= 0; b = tree.branches[b].parent) if (b === folder) return true
        return false
      }
      tree.branches.forEach((fork, i) => {
        for (const leaf of tree.leaves.values()) {
          const d = distance(leaf.center, fork.tip)
          if (leaf.branch === i) expect(d + leaf.r).toBeLessThanOrEqual(fork.crown + 1e-9)
          else if (under(leaf.branch, i)) expect(d - leaf.r).toBeGreaterThanOrEqual(fork.crown)
        }
      })
    }
  })

  it('keeps every leaf clear of every other', () => {
    for (const nodes of [...fixtures.map(g => g.nodes), synthetic(1500), synthetic(400, 60)])
      expect(leavesApart(growTree({ nodes, rootId: 'd:.', isVisible: () => true }))).toBe(true)
  })

  it('grows 10,000 files in about 600 folders quickly, with every number finite', () => {
    const nodes = synthetic(10_000)
    const t0 = performance.now()
    const tree = growTree({ nodes, rootId: 'd:.', isVisible: () => true })
    const { layout } = shownTree(tree, lookup(nodes), () => true)
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(tree.leaves.size).toBe(10_000)
    expect(tree.branches.length).toBeGreaterThan(550)
    expect(everyNumber(tree, layout).every(Number.isFinite)).toBe(true)
  })
})

describe('the tree on the timeline', async () => {
  const g = await analyzeFixture('fullstack')
  // then: before src/lib (its only file) and with a smaller service.ts
  const then = g.nodes
    .filter(n => n.id !== 'f:src/lib/fake-libs.ts' && n.id !== 'd:src/lib')
    .map(n => (n.id === 'f:src/client/service.ts' ? { ...n, metrics: { ...n.metrics, loc: 2 } } : n))
  const tree = growTree({ nodes: g.nodes, rootId: 'd:.', isVisible: noTests })
  const now = shownTree(tree, lookup(g.nodes), noTests)
  const past = shownTree(tree, lookup(then), noTests)
  const middle = (layout: Layout, id: string) => {
    const b = layout.boxes.get(id)!
    return [b.x, b.y + b.h / 2, b.z]
  }

  it('shows only what existed then, where it stays', () => {
    expect(past.layout.boxes.has('f:src/lib/fake-libs.ts')).toBe(false)
    expect(past.layout.boxes.has('d:src/lib')).toBe(false)
    expect(past.shape.files[tree.branches.findIndex(b => b.id === 'd:src/lib')]).toBe(0)
    expect(past.shape.files[0]).toBe(now.shape.files[0] - 1)
    for (const id of past.layout.boxes.keys()) if (past.layout.placement.get(id) === 'building') expect(middle(past.layout, id)).toEqual(middle(now.layout, id))
    // a leaf as big as its file was then
    expect(past.layout.boxes.get('f:src/client/service.ts')!.w).toBe(2 * leafRadius(2))
    expect(now.layout.boxes.get('f:src/client/service.ts')!.w).toBeGreaterThan(2 * leafRadius(2))
  })

  it('lays out the union once and shows each point in time in it (the view plug-in)', () => {
    const union = g.nodes
    const context = (graph: GraphNode[]): ViewContext => {
      const world = new World({ ...g, nodes: graph })
      const visibility: Visibility = { key: 'no tests', isVisible: noTests, ids: new Set(graph.filter(n => n.kind === 'file' && noTests(n)).map(n => n.id)) }
      const s = { options: { timeline: true }, union, liveBase: null } as unknown as State
      return { s, world, visibility, theme: THEME } as unknown as ViewContext
    }
    const a = view.layout(context(then))!
    const b = view.layout(context(g.nodes))!
    expect(a.boxes.has('f:src/lib/fake-libs.ts')).toBe(false)
    expect(b.boxes.has('f:src/lib/fake-libs.ts')).toBe(true)
    expect(middle(a, 'f:src/app/page.tsx')).toEqual(middle(b, 'f:src/app/page.tsx'))
    expect(b.boxes.get('f:src/app/page.tsx')).toEqual(now.layout.boxes.get('f:src/app/page.tsx'))
  })

  it('hangs the hottest files as fruit', () => {
    const hot = g.nodes.map(n => (n.kind === 'file' ? { ...n, metrics: { ...n.metrics, hotspot: n.id.length } } : n))
    const { shape } = shownTree(tree, lookup(hot), noTests)
    const expected = hot
      .filter(n => n.kind === 'file' && noTests(n))
      .sort((x, y) => y.id.length - x.id.length || (x.id < y.id ? -1 : 1))
      .slice(0, 3)
      .map(n => n.id)
    expect(shape.fruit).toEqual(expected)
  })
})

const THEME = { background: '#0e1117', ground: '#141922', district: '#232a35', selection: '#ffffff', accent: '#58a6ff' }

describe('the bark', async () => {
  const g = await analyzeFixture('fullstack')
  const tree = growTree({ nodes: g.nodes, rootId: 'd:.', isVisible: noTests })
  const shown = (nodes: readonly GraphNode[]) => {
    const { layout, shape } = shownTree(tree, lookup(nodes), noTests)
    remember(layout, shape)
    return layout
  }
  const ctx = { s: { selected: null, details: {} }, theme: THEME } as unknown as ViewContext
  /** A bark on a stand-in engine that draws boxes where the layout has them, grown. */
  const barkFor = (layout: Layout) => {
    let current = layout
    const engine = { boxOf: (id: string) => current.boxes.get(id), busy: () => false, requestRender: () => {} } as unknown as SceneEngine
    const bark = new Bark(engine)
    const show = (next: Layout) => {
      current = next
      bark.update(ctx, next)
      bark.animate(performance.now() + 10_000)
    }
    show(layout)
    return { bark, show }
  }
  const ray = (from: Vec3, to: Vec3) => {
    const origin = new THREE.Vector3(...from)
    return new THREE.Raycaster(origin, new THREE.Vector3(...to).sub(origin).normalize())
  }

  it('draws a branch per folder there, and picks one as its folder', () => {
    const layout = shown(g.nodes)
    const { bark } = barkFor(layout)
    const forks = [...layout.placement.values()].filter(p => p === 'cluster').length
    expect(bark.stats()).toMatchObject({ branches: forks })
    const trunk = tree.branches[0]
    const middle: Vec3 = [0, trunk.tip[1] / 2, 0]
    expect(bark.pick(ray([40, middle[1], 0], middle))).toEqual({ id: 'd:.', kind: 'cluster' })
    bark.dispose()
  })

  it('leaves a leaf in front of a branch to the engine', () => {
    const layout = shown(g.nodes)
    const { bark } = barkFor(layout)
    // through a leaf to the fork it hangs at
    const [id, leaf] = [...tree.leaves].find(([, l]) => l.branch > 0)!
    const fork = tree.branches[leaf.branch].tip
    const away = new THREE.Vector3(...leaf.center).sub(new THREE.Vector3(...fork)).normalize().multiplyScalar(30)
    const r = ray([leaf.center[0] + away.x, leaf.center[1] + away.y, leaf.center[2] + away.z], fork)
    expect(r.intersectObject(bark.object, true).length).toBeGreaterThan(0)
    expect(layout.boxes.has(id)).toBe(true)
    expect(bark.pick(r)).toBeUndefined()
    bark.dispose()
  })

  it('withers the branches of folders that aren’t there', () => {
    const { bark, show } = barkFor(shown(g.nodes))
    const before = bark.stats().branches
    const lib = tree.branches.find(b => b.id === 'd:src/lib')!
    const middle = new THREE.Vector3(...lib.bend.map((v, i) => (lib.base[i] + 2 * v + lib.tip[i]) / 4)) // the curve's midpoint
    // from just beside it
    const side = new THREE.Vector3(...lib.tip).sub(new THREE.Vector3(...lib.base)).cross(new THREE.Vector3(0, 1, 0)).normalize()
    const across = ray(middle.clone().addScaledVector(side, 3).toArray(), middle.toArray())
    expect(bark.pick(across)?.id).toBe('d:src/lib')
    show(shown(g.nodes.filter(n => n.id !== 'f:src/lib/fake-libs.ts')))
    expect(bark.stats().branches).toBe(before - 1)
    expect(bark.pick(across)?.id).not.toBe('d:src/lib')
    bark.dispose()
  })
})
