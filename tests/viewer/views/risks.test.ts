import { describe, expect, it } from 'vitest'
import { GraphIndex } from '../../../src/core/graph-index.ts'
import type { GraphNode } from '../../../src/core/model.ts'
import type { Violation } from '../../../src/core/rules.ts'
import { overview } from '../../../src/server/views.ts'
import { dependentCounts } from '../../../src/viewer/views/risks/dependents.ts'
import { MARGIN, RING_STEP, RING_TOP, boardRect, spanOf, cellIndex, gridToWorld, matrixGeometry, plinthHeight, rail, towerHeight, zoneOutline } from '../../../src/viewer/views/risks/layout.ts'
import { HIGH, riskModel, scale, stepRange, steps } from '../../../src/viewer/views/risks/model.ts'
import type { RiskInput } from '../../../src/viewer/views/risks/model.ts'
import { fileLabel } from '../../../src/viewer/views/risks/names.ts'
import { World, depGraph } from '../../../src/viewer/world.ts'
import { analyzeFixture } from '../../helpers/fixtures.ts'

/** A file node with metrics (and tags). */
const file = (path: string, metrics: Record<string, number>, tags: string[] = []): GraphNode => ({ id: `f:${path}`, kind: 'file', name: path.split('/').pop()!, path, metrics, tags })

/** id → the ids that depend on it, from [dependent, dependency] pairs over plain names. */
const dependentsOf = (pairs: [string, string][]) => {
  const m = new Map<string, string[]>()
  for (const [from, to] of pairs) m.set(to, [...(m.get(to) ?? []), from])
  return m
}

describe('risks: scales', () => {
  it('puts zero on step 1 and the rest at half, three quarters and nine tenths of the values above zero', () => {
    const values = [0, 0, ...Array.from({ length: 20 }, (_, i) => i + 1)] // 1 … 20
    const s = steps(values)
    expect(s).toEqual([10, 15, 18])
    expect(values.map(v => scale(v, s))).toEqual([1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 5, 5])
    expect([1, 2, 3, 4, 5].map(step => stepRange(step, s))).toEqual(['0', '1–10', '11–15', '16–18', '> 18'])
  })

  it('keeps equal values on one step, lets the largest reach the top, and copes with no values above zero', () => {
    const s = steps([5, 5, 5, 5, 9])
    expect(s).toEqual([5, 5, 5])
    expect(scale(5, s)).toBe(2)
    expect(scale(9, s)).toBe(5)
    expect(steps([400, 300, 200, 50])).toEqual([200, 300, 300])
    expect(steps([0, 0])).toEqual([0, 0, 0])
    expect(scale(0, [0, 0, 0])).toBe(1)
    expect(stepRange(3, [5, 5, 9])).toBe('5')
    expect(stepRange(5, [10_000, 20_000, 40_000])).toBe('> 40k')
  })
})

describe('risks: what depends on a file, directly or not', () => {
  it('counts every file above it once, never itself', () => {
    // c → b → a, d → a
    const counts = dependentCounts(['a', 'b', 'c', 'd'], dependentsOf([['b', 'a'], ['c', 'b'], ['d', 'a']]))
    expect(Object.fromEntries(counts)).toEqual({ a: 3, b: 1, c: 0, d: 0 })
  })

  it('treats an import cycle as one: its files depend on each other and share their dependents', () => {
    // x ⇄ y, z → x, w → z; a self-import changes nothing
    const counts = dependentCounts(['x', 'y', 'z', 'w'], dependentsOf([['x', 'y'], ['y', 'x'], ['z', 'x'], ['w', 'z'], ['w', 'w']]))
    expect(Object.fromEntries(counts)).toEqual({ x: 3, y: 3, z: 1, w: 0 })
  })

  it('leaves out ids it wasn’t given', () => {
    const counts = dependentCounts(['a'], dependentsOf([['test', 'a'], ['a', 'lib']]))
    expect(counts.get('a')).toBe(0)
  })

  it('stays fast at 10k files: a long chain and a wide fan', () => {
    const n = 10_000
    const ids = Array.from({ length: n }, (_, i) => `f${i}`)
    // a chain f9999 → … → f0, and every file also depends on f0 and f1
    const pairs: [string, string][] = []
    for (let i = 1; i < n; i++) pairs.push([ids[i], ids[i - 1]])
    for (let i = 2; i < n; i++) pairs.push([ids[i], ids[0]], [ids[i], ids[1]])
    const t0 = performance.now()
    const counts = dependentCounts(ids, dependentsOf(pairs))
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(counts.get('f0')).toBe(n - 1)
    expect(counts.get('f5000')).toBe(n - 5001)
    expect(counts.get('f9999')).toBe(0)
  })
})

describe('risks: the register', () => {
  const input = (over: Partial<RiskInput> = {}): RiskInput => ({
    files: [
      file('src/core.ts', { churn: 400, commits: 30, complexity: 60, fanOut: 2, testReach: 5 }, ['in-cycle']),
      file('src/api.ts', { churn: 300, commits: 20, complexity: 10, fanOut: 3, testReach: 0 }),
      file('src/page.ts', { churn: 200, commits: 10, complexity: 4, fanOut: 5, testReach: 2 }),
      file('src/util.ts', { churn: 0, commits: 1, complexity: 2, fanOut: 0, testReach: 9 }),
      file('src/twin.ts', { churn: 50, commits: 6, complexity: 3, fanOut: 1, testReach: 1 }),
    ],
    // page → api → core → util; twin → util
    dependents: dependentsOf([['f:src/page.ts', 'f:src/api.ts'], ['f:src/api.ts', 'f:src/core.ts'], ['f:src/core.ts', 'f:src/util.ts'], ['f:src/twin.ts', 'f:src/util.ts']]),
    history: true,
    cycles: [],
    violations: [],
    ...over,
  })

  it('rates likelihood by churn and impact by everything that depends on a file', () => {
    const m = riskModel(input())
    expect(m.measure).toBe('churn')
    const by = (p: string) => m.byId.get(`f:src/${p}`)!
    expect(by('util.ts')).toMatchObject({ change: 0, likelihood: 1, dependents: 4 })
    expect(by('core.ts')).toMatchObject({ change: 400, dependents: 2 })
    expect(by('core.ts').likelihood).toBe(5)
    expect(by('page.ts').impact).toBe(1)
    for (const f of m.files) expect(f.risk).toBe(f.likelihood * f.impact)
  })

  it('ranks by risk, then by how far into its cell, then by debt, then by id, numbering from 1', () => {
    const m = riskModel(input())
    expect(m.files.map(f => f.rank)).toEqual([1, 2, 3, 4, 5])
    for (let i = 1; i < m.files.length; i++) expect(m.files[i - 1].risk).toBeGreaterThanOrEqual(m.files[i].risk)
    expect(m.files[0].id).toBe('f:src/core.ts')
    // the same input in another order ranks the same
    const shuffled = riskModel(input({ files: [...input().files].reverse() }))
    expect(shuffled.files.map(f => f.id)).toEqual(m.files.map(f => f.id))
    // ties fall back to the id
    const twins = riskModel(input({ files: [file('src/b.ts', { churn: 5 }), file('src/a.ts', { churn: 5 })], dependents: new Map() }))
    expect(twins.files.map(f => f.id)).toEqual(['f:src/a.ts', 'f:src/b.ts'])
  })

  it('finds the debt each file carries', () => {
    const violations: Violation[] = [
      { rule: 'down', severity: 'warn', message: '', from: 'f:src/page.ts', to: 'f:src/api.ts', targets: ['default'] },
      { rule: 'seam', severity: 'error', message: '', from: 'f:src/api.ts', to: 'f:src/core.ts', targets: ['default'], path: ['f:src/api.ts', 'f:src/core.ts'] },
    ]
    const coChanges = (id: string) =>
      id === 'f:src/twin.ts'
        ? [
            { other: 'f:src/page.ts', commits: 5, confidence: 0.6, depends: false },
            { other: 'f:tests/x.test.ts', commits: 9, confidence: 1, depends: false },
          ]
        : id === 'f:src/api.ts'
          ? [{ other: 'f:src/page.ts', commits: 9, confidence: 0.9, depends: true }]
          : id === 'f:src/util.ts'
            ? [{ other: 'f:src/core.ts', commits: 4, confidence: 0.9, depends: false }]
            : []
    const m = riskModel(input({ violations, coChanges, cycles: [['f:src/util.ts', 'f:src/twin.ts']] }))
    const debts = Object.fromEntries(m.files.map(f => [f.id.slice(6), f.debts]))
    expect(debts).toEqual({
      // a cycle by tag; complex: top 5 % and at least 20
      'core.ts': ['cycle', 'rule', 'complex'],
      // no test reaches it
      'api.ts': ['rule', 'untested'],
      'page.ts': ['rule'],
      // a cycle from meta.cycles; coupling with a rated file only, 5+ commits at 50 %+
      'twin.ts': ['cycle', 'coupling'],
      'util.ts': ['cycle'],
    })
    expect(m.byId.get('f:src/api.ts')!.ruleError).toBe(true)
    expect(m.byId.get('f:src/page.ts')!.ruleError).toBe(false)
    expect(m.debtCounts).toEqual({ cycle: 3, rule: 3, coupling: 1, untested: 1, complex: 1 })
  })

  it('says nothing about tests where none were measured', () => {
    const files = input().files.map(f => {
      const { testReach: _, ...metrics } = f.metrics!
      return { ...f, metrics }
    })
    expect(riskModel(input({ files })).debtCounts.untested).toBe(0)
  })

  it('without history, rates likelihood by complexity × fan-out; with history but no churn, by commits', () => {
    const proxy = riskModel(input({ history: false }))
    expect(proxy.measure).toBe('proxy')
    expect(proxy.byId.get('f:src/core.ts')!.change).toBe(120)
    const commits = riskModel(input({ files: input().files.map(f => ({ ...f, metrics: { ...f.metrics, churn: 0 } })) }))
    expect(commits.measure).toBe('commits')
    expect(commits.byId.get('f:src/core.ts')!.change).toBe(30)
  })
})

describe('risks: the matrix', () => {
  const many = (n: number) =>
    riskModel({
      files: Array.from({ length: n }, (_, i) => file(`src/f${String(i).padStart(3, '0')}.ts`, { churn: i % 7 === 0 ? 0 : i * 3, complexity: (i * 13) % 50 })),
      dependents: dependentsOf(Array.from({ length: n - 1 }, (_, i) => [`f:src/f${String(i + 1).padStart(3, '0')}.ts`, `f:src/f${String(Math.floor(i / 3)).padStart(3, '0')}.ts`] as [string, string])),
      history: true,
      cycles: [],
      violations: [],
    })

  it('lays out 25 equal cells, likelihood left to right, impact from the front to the back', () => {
    const g = matrixGeometry(many(120))
    expect(g.cells).toHaveLength(25)
    const at = (l: number, i: number) => g.cells[cellIndex(l, i)]
    expect(at(2, 1).x).toBeGreaterThan(at(1, 1).x)
    expect(at(1, 2).z).toBeLessThan(at(1, 1).z) // impact grows away from the camera
    expect(new Set(g.cells.map(c => c.size)).size).toBe(1)
    expect(g.cells.reduce((n, c) => n + c.files.length, 0)).toBe(120)
    // plinths rise toward the hot corner
    expect(at(5, 5).plinth).toBeGreaterThan(at(3, 3).plinth)
    expect(at(3, 3).plinth).toBeGreaterThan(at(1, 1).plinth)
    expect(plinthHeight(1)).toBeCloseTo(0.3)
    expect(plinthHeight(25, 15)).toBeCloseTo(plinthHeight(25) / 2) // in proportion to the cells
  })

  it('stands every file inside its own cell, on its plinth, the tallest at the back', () => {
    const model = many(120)
    const g = matrixGeometry(model)
    for (const c of g.cells) {
      for (const id of c.files) {
        const b = g.towers.get(id)!
        expect(Math.abs(b.x - c.x) + b.w / 2).toBeLessThanOrEqual(c.size / 2)
        expect(Math.abs(b.z - c.z) + b.d / 2).toBeLessThanOrEqual(c.size / 2)
        expect(b.y).toBeCloseTo(c.top)
        const f = model.byId.get(id)!
        expect([f.likelihood, f.impact]).toEqual([c.likelihood, c.impact])
      }
      const zs = c.files.map(id => g.towers.get(id)!)
      for (let i = 1; i < zs.length; i++) if (zs[i].z > zs[i - 1].z + 1e-9) expect(zs[i].h).toBeLessThanOrEqual(zs[i - 1].h + 1e-9)
    }
    // deterministic
    expect([...matrixGeometry(model).towers]).toEqual([...g.towers])
  })

  it('makes a tower tall enough for its rings', () => {
    const plain = towerHeight({ complexity: 0, debts: [] })
    const ringed = towerHeight({ complexity: 0, debts: ['cycle', 'rule', 'coupling'] })
    expect(ringed).toBeGreaterThanOrEqual(RING_TOP + 3 * RING_STEP)
    expect(ringed).toBeGreaterThan(plain)
    expect(towerHeight({ complexity: 10_000, debts: [] })).toBeLessThanOrEqual(9)
  })

  it('outlines the high-risk corner as a staircase', () => {
    expect(zoneOutline(HIGH)).toEqual([
      [2, 5],
      [5, 5],
      [5, 2],
      [4, 2],
      [4, 3],
      [3, 3],
      [3, 4],
      [2, 4],
    ])
    expect(zoneOutline(25)).toEqual([
      [4, 5],
      [5, 5],
      [5, 4],
      [4, 4],
    ])
    expect(zoneOutline(1)).toEqual([
      [0, 5],
      [5, 5],
      [5, 0],
      [0, 0],
    ])
    expect(zoneOutline(26)).toEqual([])
    const g = matrixGeometry(many(30))
    const [x, z] = gridToWorld(g, 0, 0)
    expect(x).toBeLessThan(g.left)
    expect(z).toBeGreaterThan(g.front)
  })

  it('names the highest risks on a rail right of the matrix, highest first from the back', () => {
    const model = many(120)
    const g = matrixGeometry(model)
    const stops = rail(model, g, 10, id => `#${id}`, 200)
    expect(stops.map(s => s.id)).toEqual(model.files.slice(0, 10).map(f => f.id))
    for (let i = 0; i < stops.length; i++) {
      expect(stops[i].at[0]).toBeGreaterThan(g.right)
      expect(stops[i].label[0]).toBeGreaterThan(stops[i].at[0])
      if (i) expect(stops[i].at[2]).toBeGreaterThan(stops[i - 1].at[2])
      const b = g.towers.get(stops[i].id)!
      expect(stops[i].leader[0]).toEqual([b.x, b.y + b.h, b.z])
    }
    expect(stops[stops.length - 1].at[2]).toBeLessThan(g.front)
    const rect = boardRect(g)
    expect(rect.u + rect.w / 2).toBeCloseTo(g.right + MARGIN.right * spanOf(g))
  })
})

describe('risks: names', () => {
  it('keeps the folder where the name alone says little', () => {
    expect(fileLabel({ name: 'local-order-store.ts', path: 'src/lib/local-order-store.ts' })).toBe('local-order-store')
    expect(fileLabel({ name: 'index.ts', path: 'src/types/index.ts' })).toBe('types/index')
    expect(fileLabel({ name: 'page.tsx', path: 'src/app/accounts/page.tsx' })).toBe('accounts/page')
    expect(fileLabel({ name: 'index.ts' })).toBe('index')
  })
})

describe('risks: on a fixture without history', () => {
  it('rates every source file, by complexity × fan-out, impact through the real dependencies', async () => {
    const world = new World(overview(new GraphIndex(await analyzeFixture('fullstack'))))
    const files = world.graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test') && !n.tags?.includes('asset'))
    const ids = new Set(files.map(f => f.id))
    const g = depGraph(world, 'risks-test', [], 'default', id => ids.has(id))
    const m = riskModel({ files, dependents: g.in, history: false, cycles: world.graph.meta.cycles, violations: world.graph.meta.violations ?? [] })
    expect(m.measure).toBe('proxy')
    expect(m.files).toHaveLength(files.length)
    // the Prisma schema is what everything ends up at
    const schema = m.byId.get('f:prisma/schema.prisma')!
    expect(schema.dependents).toBeGreaterThan(0)
    // an API route nothing links to; a page another page links to (navigates)
    expect(m.byId.get('f:src/app/api/health/route.ts')!.dependents).toBe(0)
    expect(m.byId.get('f:src/app/(shop)/accounts/page.tsx')!.dependents).toBe(1)
    expect(m.debtCounts.coupling).toBe(0)
    const geometry = matrixGeometry(m)
    expect(geometry.towers.size).toBe(files.length)
  })
})
