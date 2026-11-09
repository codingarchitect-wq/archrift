import { describe, expect, it } from 'vitest'
import { GraphIndex } from '../../../src/core/graph-index.ts'
import type { GraphNode } from '../../../src/core/model.ts'
import { overview } from '../../../src/server/views.ts'
import {
  CELL,
  KIND,
  columnAnchorId,
  comparePaths,
  fileText,
  folderDepth,
  matrixLayout,
  matrixModel,
  rank,
  rowY,
  wallFor,
} from '../../../src/viewer/views/matrix/model.ts'
import type { MatrixInput } from '../../../src/viewer/views/matrix/model.ts'
import { selectionOf } from '../../../src/viewer/views/matrix/selection.ts'
import { World, depGraph } from '../../../src/viewer/world.ts'
import { analyzeFixture } from '../../helpers/fixtures.ts'

const file = (path: string, tags: string[] = [], metrics: Record<string, number> = {}): GraphNode => ({
  id: `f:${path}`,
  kind: 'file',
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  tags,
  metrics: { loc: 10, ...metrics },
})
const layerOf = (n: GraphNode) => n.tags?.find(t => t.startsWith('layer:'))?.slice(6)
const weights = (pairs: [string, string, number?][]) => {
  const w = new Map<string, Map<string, number>>()
  for (const [a, b, n = 1] of pairs) w.set(`f:${a}`, (w.get(`f:${a}`) ?? new Map()).set(`f:${b}`, n))
  return w
}
const LAYERS = { order: ['ui', 'domain', 'base'], layerOf }

// a small app: ui over domain over base, one file in no layer, and a package
const nodes: GraphNode[] = [
  file('src/lib/b.ts', ['layer:base'], { fanIn: 3 }),
  file('src/ui/z.ts', ['layer:ui']),
  file('src-x/q.ts'),
  file('src/ui/sub/k.ts', ['layer:ui']),
  file('src/domain/x.ts', ['layer:domain'], { fanIn: 1 }),
  file('src/ui/a.ts', ['layer:ui']),
  { id: 'x:npm:react', kind: 'external', name: 'react' },
]
const input: MatrixInput = {
  nodes,
  weight: weights([
    ['src/ui/a.ts', 'src/domain/x.ts', 3],
    ['src/ui/a.ts', 'src/lib/b.ts'],
    ['src/domain/x.ts', 'src/lib/b.ts', 2],
    ['src/lib/b.ts', 'src/ui/z.ts'], // base → ui: up
    ['src/ui/z.ts', 'src/ui/a.ts'], // backwards inside a layer: not up
    ['src/domain/x.ts', 'src-x/q.ts'], // into no layer: never up
    ['src-x/q.ts', 'src/ui/a.ts'],
  ]),
  layers: LAYERS,
}

describe('the matrix order', () => {
  it('goes by layer (top first, none last), then folder in tree order, then name; packages last', () => {
    const m = matrixModel(input)
    expect(m.units.map(u => u.path)).toEqual(['src/ui/a.ts', 'src/ui/z.ts', 'src/ui/sub/k.ts', 'src/domain/x.ts', 'src/lib/b.ts', 'src-x/q.ts', 'react'])
    expect(m.blocks.map(b => [b.label, b.start, b.end])).toEqual([
      ['ui', 0, 3],
      ['domain', 3, 4],
      ['base', 4, 5],
      ['no layer', 5, 6],
      ['packages', 6, 7],
    ])
  })

  it('compares folders segment by segment', () => {
    expect(comparePaths('src', 'src/lib')).toBeLessThan(0)
    expect(comparePaths('src/lib', 'src-x')).toBeLessThan(0) // '-' sorts before '/', but src/… belongs to src
    expect(comparePaths('src/b', 'src/a/z')).toBeGreaterThan(0)
    expect(comparePaths('', 'src')).toBeLessThan(0)
  })

  it('puts a chosen grouping first, so modules sit on the diagonal as blocks', () => {
    const group: Record<string, string> = { 'f:src/lib/b.ts': 'm1', 'f:src/ui/a.ts': 'm1', 'f:src/domain/x.ts': 'm0' }
    const m = matrixModel({
      ...input,
      grouping: {
        groups: [
          { id: 'm0', label: 'first' },
          { id: 'm1', label: 'second' },
        ],
        groupOf: f => group[f],
      },
    })
    expect(m.units.map(u => u.path)).toEqual(['src/domain/x.ts', 'src/ui/a.ts', 'src/lib/b.ts', 'src/ui/z.ts', 'src/ui/sub/k.ts', 'src-x/q.ts', 'react'])
    expect(m.blocks.map(b => b.label)).toEqual(['first', 'second', 'ungrouped', 'packages'])
  })

  it('tells files of the same name apart by their folders, and shortens long names', () => {
    const m = matrixModel({ nodes: [file('app/page.tsx'), file('app/shop/page.tsx'), file('lib/page.tsx')], weight: new Map(), layers: LAYERS })
    expect(m.units.map(u => u.name)).toEqual(['app/page.tsx', 'shop/page.tsx', 'lib/page.tsx'])
    expect(fileText('local-order-stores.projections.ts')).toBe('local-order-stores.pro….ts')
  })

  it('is deterministic, whatever order the nodes and dependencies come in', () => {
    const shuffled: MatrixInput = { ...input, nodes: [...nodes].reverse(), weight: new Map([...input.weight].reverse()) }
    const a = matrixModel(input)
    const b = matrixModel(shuffled)
    expect(b.units.map(u => u.id)).toEqual(a.units.map(u => u.id))
    expect(b.cells).toEqual(a.cells)
    expect(matrixLayout(b, 'matrix').boxes).toEqual(matrixLayout(a, 'matrix').boxes)
  })
})

describe('the cells', () => {
  const m = matrixModel(input)
  const cell = (from: string, to: string) => m.cells[m.cellAt.get(m.index.get(`f:${from}`)! * m.units.length + m.index.get(`f:${to}`)!)!]

  it('light up where the row depends on the column, weighted by references', () => {
    expect(m.cells).toHaveLength(7)
    expect(cell('src/ui/a.ts', 'src/domain/x.ts')).toMatchObject({ weight: 3, kind: KIND.uses, up: false })
    expect(m.maxWeight).toBe(3)
    expect(m.uses[m.index.get('f:src/ui/a.ts')!].sort()).toEqual([3, 4])
    expect(m.usedBy[m.index.get('f:src/lib/b.ts')!].sort()).toEqual([0, 3])
  })

  it('point up when the column’s layer is above the row’s: left of the diagonal, never within a layer or without one', () => {
    const up = cell('src/lib/b.ts', 'src/ui/z.ts')
    expect(up).toMatchObject({ kind: KIND.up, up: true })
    expect(up.col).toBeLessThan(up.row)
    expect(cell('src/ui/z.ts', 'src/ui/a.ts').up).toBe(false)
    expect(cell('src/domain/x.ts', 'src-x/q.ts').up).toBe(false)
    expect(cell('src-x/q.ts', 'src/ui/a.ts').up).toBe(false)
    expect(m.counts.up).toBe(1)
    // everything that follows the layering is right of the diagonal
    for (const c of m.cells) if (!c.up && m.units[c.row].layer !== undefined && m.units[c.col].layer !== undefined && m.units[c.row].layer !== m.units[c.col].layer) expect(c.col).toBeGreaterThan(c.row)
  })

  it('show import cycles and broken rules (in the shown target), rules first', () => {
    const marked = matrixModel({
      ...input,
      cycles: [['f:src/ui/a.ts', 'f:src/ui/z.ts', 'f:src-x/q.ts']],
      violations: [
        { rule: 'no-base-to-ui', severity: 'error', from: 'f:src/lib/b.ts', to: 'f:src/ui/z.ts', targets: ['web'] },
        { rule: 'soft', severity: 'warn', from: 'f:src/ui/a.ts', to: 'f:src/lib/b.ts', targets: ['web'] },
        { rule: 'desktop-only', severity: 'error', from: 'f:src/ui/a.ts', to: 'f:src/domain/x.ts', targets: ['desktop'] },
        { rule: 'reach', severity: 'error', from: 'f:src-x/q.ts', to: 'f:src/lib/b.ts', path: ['f:src-x/q.ts', 'f:src/ui/a.ts', 'f:src/lib/b.ts'], targets: ['web'] },
      ],
      target: 'web',
    })
    const at = (from: string, to: string) => marked.cells[marked.cellAt.get(marked.index.get(`f:${from}`)! * marked.units.length + marked.index.get(`f:${to}`)!)!]
    expect(at('src/ui/z.ts', 'src/ui/a.ts')).toMatchObject({ kind: KIND.cycle, cycle: true })
    expect(at('src/lib/b.ts', 'src/ui/z.ts')).toMatchObject({ kind: KIND.violation, up: true, rules: ['no-base-to-ui'] })
    // the warning and the path's error on the same pair: the error wins
    expect(at('src/ui/a.ts', 'src/lib/b.ts')).toMatchObject({ kind: KIND.violation, rules: ['reach', 'soft'] })
    expect(at('src-x/q.ts', 'src/ui/a.ts')).toMatchObject({ kind: KIND.violation, cycle: true, rules: ['reach'] })
    expect(at('src/ui/a.ts', 'src/domain/x.ts').kind).toBe(KIND.uses) // another target's violation
    expect(marked.counts).toEqual({ up: 1, cycle: 2, warning: 0, violation: 3 })
  })
})

describe('aggregation', () => {
  // 40 folders of 50 files: 2,000 files, each using two files in the next folder and one in its own
  const many: GraphNode[] = []
  const pairs: [string, string, number?][] = []
  for (let f = 0; f < 40; f++)
    for (let i = 0; i < 50; i++) {
      const path = `src/area${f % 4}/part${f}/m${i}.ts`
      many.push(file(path, [`layer:${f < 20 ? 'ui' : 'base'}`], { churn: f === 7 ? 500 : f }))
      pairs.push([path, `src/area${(f + 1) % 4}/part${(f + 1) % 40}/m${i}.ts`, 2], [path, `src/area${f % 4}/part${f}/m${(i + 1) % 50}.ts`])
    }

  it('turns rows into folders above the threshold, as deep as stays under the limit', () => {
    const m = matrixModel({ nodes: many, weight: weights(pairs), layers: LAYERS })
    expect(m.depth).toBe(3)
    expect(m.units).toHaveLength(40)
    expect(m.units.every(u => u.kind === 'folder' && u.id.startsWith('d:src/area') && u.files.length === 50)).toBe(true)
    const tight = matrixModel({ nodes: many, weight: weights(pairs), layers: LAYERS, maxFolders: 10 })
    expect(tight.depth).toBe(2)
    expect(tight.units.map(u => u.id)).toEqual(['d:src/area0', 'd:src/area1', 'd:src/area2', 'd:src/area3'])
  })

  it('sums the references between folders, and counts those inside one on the diagonal', () => {
    const m = matrixModel({ nodes: many, weight: weights(pairs), layers: LAYERS })
    expect(m.cells).toHaveLength(40)
    const row = m.index.get('d:src/area0/part0')!
    const col = m.index.get('d:src/area1/part1')!
    expect(m.cells[m.cellAt.get(row * 40 + col)!].weight).toBe(100)
    expect(m.inside[row]).toBe(50)
    expect(m.rowOf('f:src/area0/part0/m7.ts')).toBe(row)
    // the folder's layer is its files'; the last folder uses the first, which is in a layer above
    const last = m.index.get('d:src/area3/part39')!
    expect(m.cells[m.cellAt.get(last * 40 + m.index.get('d:src/area0/part0')!)!].up).toBe(true)
  })

  it('stays with files below the threshold', () => {
    expect(matrixModel({ nodes: many.slice(0, 1400), weight: weights(pairs), layers: LAYERS }).depth).toBeNull()
  })

  it('finds the deepest folder level under a limit', () => {
    const dirs = ['a/b/c', 'a/b/d', 'a/e', 'f']
    expect(folderDepth(dirs, 4)).toBe(3)
    expect(folderDepth(dirs, 3)).toBe(2)
    expect(folderDepth(dirs, 2)).toBe(1)
    expect(folderDepth(dirs, 1)).toBe(0)
  })

  it('stays fast at 10,000 files', () => {
    // 8 areas × 45 features (360 folders) × 11 parts
    const bigPath = (i: number) => `src/a${i % 8}/b${Math.floor(i / 8) % 45}/c${i % 11}/m${i}.ts`
    const big: GraphNode[] = []
    const bigPairs: [string, string, number?][] = []
    for (let i = 0; i < 10_000; i++) {
      big.push(file(bigPath(i), [`layer:${['ui', 'domain', 'base'][i % 3]}`], { fanIn: i % 17 }))
      for (let k = 1; k <= 5; k++) bigPairs.push([bigPath(i), bigPath((i * 7 + k) % 10_000)])
    }
    const t0 = performance.now()
    const m = matrixModel({ nodes: big, weight: weights(bigPairs), layers: LAYERS })
    const layout = matrixLayout(m, 'matrix')
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(m.depth).toBe(3)
    expect(m.units).toHaveLength(360)
    expect(layout.boxes.size).toBeLessThan(1200)
  })
})

describe('the rain', () => {
  it('follows recent churn by rank, else fan-in', () => {
    const churned = matrixModel({ nodes: [file('a.ts', [], { churn: 0, fanIn: 9 }), file('b.ts', [], { churn: 40 }), file('c.ts', [], { churn: 400 })], weight: new Map(), layers: LAYERS })
    expect(churned.metric).toBe('churn')
    expect(churned.units.map(u => u.activity)).toEqual([0, 2 / 3, 1])
    expect(matrixModel(input).metric).toBe('fanIn')
    expect(rank([0, 5, 5, 10])).toEqual([0, 0.5, 0.5, 1])
  })
})

describe('the wall', () => {
  const m = matrixModel(input)
  const layout = matrixLayout(m, 'matrix')
  const w = wallFor(m)

  it('gives every row a box at its strip, left of the matrix, rows top to bottom', () => {
    expect(layout).toMatchObject({ view: 'matrix', arcs: 'none', openFile: 'none', ground: false })
    const strips = m.units.map(u => layout.boxes.get(u.id)!)
    expect(m.units.map(u => layout.placement.get(u.id))).toEqual([...Array(6).fill('building'), 'external'])
    for (let i = 0; i < strips.length; i++) {
      expect(strips[i].x + strips[i].w / 2).toBeLessThan(0)
      expect(strips[i].y + strips[i].h / 2).toBeCloseTo(rowY(w, i))
      if (i) expect(strips[i].y).toBeLessThan(strips[i - 1].y)
    }
    expect(rowY(w, 0)).toBeCloseTo(w.side - CELL / 2)
  })

  it('anchors column labels above the matrix, and looks straight at it', () => {
    const anchor = layout.boxes.get(columnAnchorId('f:src/lib/b.ts'))!
    expect(layout.placement.get(columnAnchorId('f:src/lib/b.ts'))).toBe('cluster')
    expect(anchor.x).toBeCloseTo((m.index.get('f:src/lib/b.ts')! + 0.5) * CELL)
    expect(anchor.y).toBeGreaterThan(w.side)
    expect(layout.home[0]).toBe(0)
    expect(layout.home[1]).toBe(0)
    expect(layout.center[2]).toBe(0)
  })
})

describe('on a fixture', async () => {
  const world = new World(overview(new GraphIndex(await analyzeFixture('plain-ts'))))
  const visible = new Set(world.graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test')).map(n => n.id))
  const graph = depGraph(world, 'matrix-test', [], world.graph.meta.targets[0], id => visible.has(id))
  const m = matrixModel({
    nodes: [...visible].map(id => world.node(id)!),
    weight: graph.weight,
    layers: { order: [], layerOf: () => undefined },
    cycles: world.graph.meta.cycles,
  })

  it('has a cell per visible file-to-file dependency, and marks the import cycle', () => {
    let pairs = 0
    for (const targets of graph.weight.values()) pairs += targets.size
    expect(m.cells).toHaveLength(pairs)
    expect(m.units).toHaveLength(visible.size)
    const a = m.index.get('f:src/cycle-a.ts')!
    const b = m.index.get('f:src/cycle-b.ts')!
    expect(m.cells[m.cellAt.get(a * m.units.length + b)!].kind).toBe(KIND.cycle)
    expect(m.cells[m.cellAt.get(b * m.units.length + a)!].kind).toBe(KIND.cycle)
  })

  it('selects a row with its neighbors, a cycle as a set of rows', () => {
    const row = m.index.get('f:src/util.ts')!
    const sel = selectionOf({ selected: 's:src/util.ts#clamp' }, world, m)!
    expect(sel.row).toBe(row)
    expect([...sel.related].sort()).toEqual([row, ...m.uses[row], ...m.usedBy[row]].sort())
    const cycle = world.graph.meta.cycles.findIndex(c => c.includes('f:src/cycle-a.ts'))
    expect(selectionOf({ selected: `cycle:${cycle}` }, world, m)).toEqual({ related: new Set([m.index.get('f:src/cycle-a.ts'), m.index.get('f:src/cycle-b.ts')]) })
    expect(selectionOf({ selected: 'd:src' }, world, m)!.related.size).toBe(visible.size)
    expect(selectionOf({ selected: null }, world, m)).toBeNull()
  })
})
