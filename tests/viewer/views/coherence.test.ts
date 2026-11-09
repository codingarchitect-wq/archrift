import { describe, expect, it } from 'vitest'
import type { ConcernMeta, Graph, GraphNode } from '../../../src/core/model.ts'
import { choice, pickConcern, publish, shownConcern } from '../../../src/viewer/views/coherence/choice.ts'
import { MIXED_COLOR, WAY_COLORS, coherenceFor, fileColor, strayHeat, wayColors } from '../../../src/viewer/views/coherence/model.ts'
import { World } from '../../../src/viewer/world.ts'

const DATES: ConcernMeta = {
  id: 'jvm.dates',
  label: 'Dates',
  stack: 'JVM',
  about: 'date and time values',
  paradigms: [
    { id: 'java-time', label: 'java.time' },
    { id: 'util-date', label: 'java.util.Date', legacy: true },
  ],
}

/** Files by path with their tags; directories made up; edges between paths. */
function graphOf(files: [path: string, ...tags: string[]][], edges: [string, string][] = []): Graph {
  const nodes = new Map<string, GraphNode>([['d:.', { id: 'd:.', kind: 'directory', name: 'root', path: '' }]])
  for (const [path, ...tags] of files) {
    const parts = path.split('/')
    let parent = 'd:.'
    for (let i = 1; i < parts.length; i++) {
      const dir = `d:${parts.slice(0, i).join('/')}`
      if (!nodes.has(dir)) nodes.set(dir, { id: dir, kind: 'directory', name: parts[i - 1], parent, path: parts.slice(0, i).join('/') })
      parent = dir
    }
    nodes.set(`f:${path}`, { id: `f:${path}`, kind: 'file', name: parts.at(-1)!, parent, path, tags, metrics: { loc: 10 } })
  }
  return {
    meta: { name: 'x', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], concerns: files.some(([, ...t]) => t.length) ? [DATES] : [], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } },
    nodes: [...nodes.values()],
    edges: edges.map(([s, t]) => ({ source: `f:${s}`, target: `f:${t}`, kind: 'imports', count: 1, targets: ['default'], confidence: 'exact' })),
    sites: [],
  }
}

const TIME = 'paradigm:jvm.dates=java-time'
const DATE = 'paradigm:jvm.dates=util-date'

describe('coherence view: blocks, colors and the report', () => {
  // two services under services/, one mixing date APIs; a plain file doing none of it
  const graph = graphOf(
    [
      ['services/orders/A.kt', TIME],
      ['services/orders/B.kt', TIME],
      ['services/orders/C.kt', DATE],
      ['services/orders/D.kt', TIME, DATE],
      ['services/billing/E.kt', TIME],
      ['services/billing/F.kt'],
    ],
    [
      ['services/orders/A.kt', 'services/orders/C.kt'],
      ['services/orders/B.kt', 'services/orders/D.kt'],
    ],
  )
  const world = new World(graph)

  it('takes folders where the production code splits as blocks, and measures over every file', () => {
    const c = coherenceFor(world, null)
    expect(c.blocks.kind).toBe('folder')
    const dates = c.model.byId.get('jvm.dates')!
    expect(dates.blocks.map(b => [b.block, b.paradigms])).toEqual([
      ['services/orders', ['java-time', 'util-date']],
      ['services/billing', ['java-time']],
    ])
    expect(dates.transitions).toEqual([['f:services/orders/A.kt', 'f:services/orders/C.kt']])
    // computed once per graph and grouping
    expect(coherenceFor(world, null)).toBe(c)
  })

  it('takes the toolbar’s groups when chosen, and the config’s groups otherwise', () => {
    const grouping = { key: 'g', groups: [{ id: 'module:0', label: 'all' }], groupOf: () => 'module:0' }
    const g = coherenceFor(world, grouping)
    expect(g.blocks.kind).toBe('group')
    expect(g.blocks.name('module:0')).toBe('module 1 · all') // as the other views name a detected module
    expect(g.model.byId.get('jvm.dates')!.blocks).toHaveLength(1)
    const tagged = new World(graphOf([['a/X.kt', TIME, 'group:shop'], ['b/Y.kt', DATE, 'group:shop']]))
    const t = coherenceFor(tagged, null)
    expect(t.blocks.kind).toBe('group')
    expect(t.model.byId.get('jvm.dates')!.blocks).toEqual([{ block: 'shop', files: 2, paradigms: ['java-time', 'util-date'] }])
  })

  it('colors a file by its way (main way first), several ways magenta, none not at all', () => {
    const c = coherenceFor(world, null)
    const dates = c.model.byId.get('jvm.dates')!
    expect(wayColors(dates)).toEqual(new Map([['java-time', WAY_COLORS[0]], ['util-date', WAY_COLORS[1]]]))
    expect(fileColor(c, dates, 'f:services/orders/A.kt')).toBe(WAY_COLORS[0])
    expect(fileColor(c, dates, 'f:services/orders/C.kt')).toBe(WAY_COLORS[1])
    expect(fileColor(c, dates, 'f:services/orders/D.kt')).toBe(MIXED_COLOR)
    expect(fileColor(c, dates, 'f:services/billing/F.kt')).toBeUndefined()
    // all jobs: how many jobs a file strays in
    expect(fileColor(c, undefined, 'f:services/orders/A.kt')).toBe(strayHeat(0))
    expect(fileColor(c, undefined, 'f:services/orders/C.kt')).toBe(strayHeat(1))
    expect(strayHeat(5)).toBe(strayHeat(3))
  })

  it('tells a graph analyzed before coherence was measured from one where no file does a job', () => {
    const none = graphOf([['a/X.kt']])
    expect(coherenceFor(new World(none), null).measured).toBe(true)
    const { concerns: _, ...older } = none.meta
    const old = coherenceFor(new World({ ...none, meta: older }), null)
    expect(old.measured).toBe(false)
    publish(old)
    expect(choice.getState().report).toMatchObject({ measured: false, concerns: [] })
  })

  it('publishes the report its toolbar and key read, and remembers the job picked', () => {
    const c = coherenceFor(world, null)
    publish(c)
    const report = choice.getState().report!
    expect(report.measured).toBe(true)
    expect(report.totals).toMatchObject({ concerns: 1, decoherent: 1, strays: 2 })
    expect(report.concerns[0]).toMatchObject({
      id: 'jvm.dates',
      title: 'JVM · Dates',
      kind: 'mixed',
      transitions: 1,
      migration: { from: 'java.util.Date', to: 'java.time', left: 2 },
      mixing: [{ block: 'services/orders', ways: ['java.time', 'java.util.Date'] }],
      strayFiles: [
        { id: 'f:services/orders/C.kt', path: 'services/orders/C.kt', ways: ['java.util.Date'] },
        { id: 'f:services/orders/D.kt', path: 'services/orders/D.kt', ways: ['java.time', 'java.util.Date'] },
      ],
    })
    expect(report.concerns[0].ways.map(w => [w.label, w.files, w.legacy])).toEqual([
      ['java.time', 4, false],
      ['java.util.Date', 2, true],
    ])
    expect(shownConcern(c)).toBeUndefined()
    pickConcern('jvm.dates')
    expect(shownConcern(c)?.concern.id).toBe('jvm.dates')
    pickConcern(null)
    expect(choice.getState().picked).toBeNull()
  })
})
