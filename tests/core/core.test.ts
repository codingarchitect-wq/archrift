import { describe, expect, it } from 'vitest'
import { directoryLevel, fileLevel, liftEdges } from '../../src/core/aggregate.ts'
import { betweenness, cycles, fanInOut, louvain, reach, shortestPaths } from '../../src/core/algorithms.ts'
import { globToRegExp, matcher } from '../../src/core/glob.ts'
import { GraphIndex } from '../../src/core/graph-index.ts'
import { packageName } from '../../src/core/ids.ts'
import type { Graph } from '../../src/core/model.ts'
import { decodeGraph, encodeGraph } from '../../src/core/serialize.ts'
import { analyzeFixture } from '../helpers/fixtures.ts'

describe('glob', () => {
  const m = (glob: string, path: string) => globToRegExp(glob).test(path)

  it('matches ** across segments and * within one', () => {
    expect(m('src/app/**/page.tsx', 'src/app/page.tsx')).toBe(true)
    expect(m('src/app/**/page.tsx', 'src/app/(dashboard)/accounts/page.tsx')).toBe(true)
    expect(m('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(m('**/node_modules/**', 'a/node_modules/x/y.js')).toBe(true)
  })

  it('treats a slash-less pattern as a basename match anywhere', () => {
    expect(m('*.config.{ts,mjs}', 'next.config.ts')).toBe(true)
    expect(m('*.config.{ts,mjs}', 'tools/vite.config.mjs')).toBe(true)
    expect(m('*.config.{ts,mjs}', 'next.config.js')).toBe(false)
  })

  it('matches everything below a directory pattern', () => {
    expect(m('src/generated', 'src/generated/prisma/client.ts')).toBe(true)
    expect(matcher(['tests/**', '**/*.test.ts'])('src/a.test.ts')).toBe(true)
  })

  it('escapes regex characters in paths', () => {
    expect(m('src/app/(dashboard)/page.tsx', 'src/app/(dashboard)/page.tsx')).toBe(true)
    expect(m('a.b', 'aXb')).toBe(false)
  })
})

describe('ids', () => {
  it('takes the package name from a bare specifier', () => {
    expect(packageName('@trpc/server/adapters')).toBe('@trpc/server')
    expect(packageName('lodash/fp')).toBe('lodash')
  })
})

describe('cycles', () => {
  it('finds strongly connected components and self-loops, largest first', () => {
    const adj = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a', 'd']],
      ['d', ['e']],
      ['e', ['d']],
      ['f', ['f']],
      ['g', ['a']],
    ])
    expect(cycles(['a', 'b', 'c', 'd', 'e', 'f', 'g'], adj)).toEqual([['a', 'b', 'c'], ['d', 'e'], ['f']])
  })

  it('handles long chains without recursion', () => {
    const n = 50_000
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`)
    const adj = new Map(nodes.map((id, i) => [id, [nodes[(i + 1) % n]]]))
    expect(cycles(nodes, adj)[0]).toHaveLength(n)
  })
})

describe('fanInOut', () => {
  it('counts distinct neighbours and ignores self-loops', () => {
    const f = fanInOut([
      { source: 'a', target: 'b' },
      { source: 'a', target: 'b' },
      { source: 'c', target: 'b' },
      { source: 'b', target: 'b' },
    ])
    expect([f.fanIn('b'), f.fanOut('a'), f.fanOut('b')]).toEqual([2, 1, 0])
  })
})

describe('aggregation', async () => {
  const g = await analyzeFixture('plain-ts')
  const index = new GraphIndex(g)

  it('lifts symbol edges to files, summing counts and dropping self-loops', () => {
    const lifted = liftEdges(index, fileLevel(index), e => e.kind === 'calls')
    const appToUtil = lifted.find(e => e.source === 'f:src/app.ts' && e.target === 'f:src/util.ts')
    expect(appToUtil).toMatchObject({ kind: 'calls', count: 3, edges: 3 }) // clamp, parse, round
    expect(lifted.some(e => e.source === e.target)).toBe(false)
  })

  it('lifts to directories at a depth, leaving shallower files alone', () => {
    const lifted = liftEdges(index, directoryLevel(index, 1))
    expect(lifted.some(e => e.source === 'd:tests' && e.target === 'd:src')).toBe(true)
    expect(lifted.every(e => e.source !== 'd:src' || e.target !== 'd:src')).toBe(true)
  })

  it('walks containment', () => {
    expect(index.fileOf('s:src/shapes.ts#Circle.area')?.id).toBe('f:src/shapes.ts')
    expect(index.ancestors('s:src/shapes.ts#Circle.area').map(n => n.id)).toEqual([
      's:src/shapes.ts#Circle',
      'f:src/shapes.ts',
      'd:src',
      'd:.',
    ])
  })
})

describe('serialization', () => {
  it('round-trips a graph, sites included', async () => {
    const g = await analyzeFixture('suffix-targets')
    const { graph, sites } = encodeGraph(g)
    const back = decodeGraph(JSON.parse(JSON.stringify(graph)), JSON.parse(JSON.stringify(sites)))
    expect(back).toEqual(g)
  })

  it('stores each string once', async () => {
    const g = await analyzeFixture('plain-ts')
    const { graph } = encodeGraph(g)
    expect(new Set(graph.strings).size).toBe(graph.strings.length)
  })

  it('rejects unknown schema versions and dangling edges', () => {
    const empty: Graph = {
      meta: {
        name: 'x',
        generatedAt: '',
        tool: { name: 'archrift', version: '0' },
        analyzers: [],
        targets: ['default'],
        counts: {},
        timings: {},
        cycles: [],
        diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 },
      },
      nodes: [],
      edges: [],
      sites: [],
    }
    const { graph } = encodeGraph(empty)
    expect(() => decodeGraph({ ...graph, schemaVersion: 99 })).toThrow(/schema 99/)
    expect(() =>
      encodeGraph({ ...empty, edges: [{ source: 'a', target: 'b', kind: 'calls', count: 1, targets: [], confidence: 'exact' }] }),
    ).toThrow(/unknown node/)
  })
})

describe('reach', () => {
  const adj = new Map([
    ['a', ['b', 'c']],
    ['b', ['d']],
    ['c', ['d']],
    ['d', ['e']],
  ])
  it('finds everything reachable, with depth and the edge that found it', () => {
    const r = reach(adj, ['a'])
    expect([...r.keys()]).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(r.get('d')).toEqual({ depth: 2, via: 'b' })
  })
  it('stops at a depth', () => {
    expect([...reach(adj, ['a'], 1).keys()]).toEqual(['a', 'b', 'c'])
  })
})

describe('shortestPaths', () => {
  it('lists every shortest path, up to a limit', () => {
    const adj = new Map([
      ['a', ['b', 'c', 'x']],
      ['b', ['d']],
      ['c', ['d']],
      ['x', ['y']],
      ['y', ['d']],
    ])
    expect(shortestPaths(adj, 'a', 'd')).toEqual([
      ['a', 'b', 'd'],
      ['a', 'c', 'd'],
    ])
    expect(shortestPaths(adj, 'a', 'd', 1)).toHaveLength(1)
    expect(shortestPaths(adj, 'd', 'a')).toEqual([])
  })
})

describe('louvain', () => {
  // two dense cliques joined by one edge
  const clique = (p: string) => ['1', '2', '3', '4', '5'].map(i => p + i)
  const edgesOf = (ns: string[]) => ns.flatMap((a, i) => ns.slice(i + 1).map(b => ({ source: a, target: b })))
  const nodes = [...clique('a'), ...clique('b')]
  const edges = [...edgesOf(clique('a')), ...edgesOf(clique('b')), { source: 'a1', target: 'b1' }]

  it('separates dense groups', () => {
    const c = louvain(nodes, edges)
    expect(new Set(clique('a').map(n => c.get(n))).size).toBe(1)
    expect(new Set(clique('b').map(n => c.get(n))).size).toBe(1)
    expect(c.get('a1')).not.toBe(c.get('b1'))
  })

  it('is deterministic and numbers communities largest first', () => {
    const extra = [...nodes, 'lonely']
    const c = louvain(extra, edges)
    expect(louvain(extra, edges)).toEqual(c)
    expect(c.get('lonely')).toBe(2)
  })
})

describe('betweenness', () => {
  /** Adjacency from `a>b` (one way) and `a-b` (both ways) links. */
  const graph = (...links: string[]) => {
    const adj = new Map<string, string[]>()
    const add = (x: string, y: string) => adj.set(x, [...(adj.get(x) ?? []), y])
    for (const l of links) {
      const [x, y] = l.split(/[>-]/)
      add(x, y)
      if (l.includes('-')) add(y, x)
      if (!adj.has(y)) adj.set(y, [])
    }
    return adj
  }
  const scores = (adj: Map<string, string[]>, sampleAbove?: number) => Object.fromEntries(betweenness([...adj.keys()], adj, sampleAbove))

  it('counts the pairs whose shortest paths run through a node, on a path', () => {
    expect(scores(graph('a>b', 'b>c', 'c>d'))).toEqual({ a: 0, b: 2, c: 2, d: 0 })
  })

  it('gives a star’s center every pair of leaves', () => {
    expect(scores(graph('hub-l1', 'hub-l2', 'hub-l3', 'hub-l4'))).toEqual({ hub: 12, l1: 0, l2: 0, l3: 0, l4: 0 })
  })

  it('finds the two ends of a bridge between two cliques', () => {
    expect(scores(graph('a-b', 'b-c', 'a-c', 'c-d', 'd-e', 'e-f', 'd-f'))).toEqual({ a: 0, b: 0, c: 12, d: 12, e: 0, f: 0 })
  })

  it('shares a pair between its shortest paths', () => {
    expect(scores(graph('a>b', 'a>c', 'b>d', 'c>d'))).toEqual({ a: 0, b: 0.5, c: 0.5, d: 0 })
  })

  it('ignores self-loops, repeated links and targets outside the nodes', () => {
    const adj = new Map([['a', ['a', 'b', 'b', 'zz']], ['b', ['c']], ['c', []]])
    expect(Object.fromEntries(betweenness(['c', 'b', 'a'], adj))).toEqual({ a: 0, b: 1, c: 0 })
  })

  it('above the limit walks every k-th source in sorted order and scales the sums, the same each time', () => {
    const path = graph('a>b', 'b>c', 'c>d', 'd>e', 'e>f')
    // exact: b 4, c 6, d 6, e 4; from a, c and e only (k = 2), times 6 / 3
    expect(scores(path)).toEqual({ a: 0, b: 4, c: 6, d: 6, e: 4, f: 0 })
    expect(scores(path, 3)).toEqual({ a: 0, b: 8, c: 6, d: 8, e: 4, f: 0 })
    expect(scores(path, 3)).toEqual(scores(new Map([...path].reverse()), 3))
  })
})
