import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Graph, GraphEdge, GraphNode } from '../../src/core/model.ts'
import { MAX_QUESTIONS, bridgesOf, codeGraph, entryPaths, interleave, questionsOf } from '../../src/core/questions.ts'
import type { Question } from '../../src/core/questions.ts'

const file = (p: string, more: Partial<GraphNode> = {}): GraphNode => ({ id: `f:${p}`, kind: 'file', name: path.basename(p), path: p, ...more })
const link = (a: string, b: string, more: Partial<GraphEdge> = {}): GraphEdge => ({ source: `f:${a}`, target: `f:${b}`, kind: 'imports', subkind: 'static', count: 1, targets: ['default'], confidence: 'exact', ...more })
const coChange = (a: string, b: string, count: number, weight = 1): GraphEdge => link(a, b, { kind: 'co-changes', subkind: undefined, count, weight, confidence: 'inferred' })
const graphOf = (nodes: GraphNode[], edges: GraphEdge[], meta: Partial<Graph['meta']> = {}) => ({ meta: { name: 'x', cycles: [], ...meta }, nodes, edges, sites: [] }) as unknown as Graph

/** Blocks by the first two folders: `src/ui/a.tsx` → `src/ui`. */
const blockOf = (p: string) => p.split('/').slice(0, 2).join('/')
const notVendored = () => false

/** The questions about a graph whose production files are its files without the `test` tag. */
function ask(g: Graph, isVendored: (p: string) => boolean = notVendored): Question[] {
  const code = codeGraph(g, g.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test')), blockOf)
  return questionsOf({ graph: g, code, bridges: bridgesOf(code, isVendored), isVendored })
}
const ofType = (qs: Question[], type: Question['type']) => qs.filter(q => q.type === type)

// two screens use a hub that uses two data files; inside data, x and three more files go through mid to two leaves
const DATA = ['x', 'y', 'd1', 'd2', 'd3', 'mid', 'leaf', 'leaf2'].map(x => `src/data/${x}.ts`)
const chain = () =>
  graphOf(
    ['src/ui/a.tsx', 'src/ui/b.tsx', 'src/core/hub.ts', ...DATA].map(p => file(p)),
    [
      link('src/ui/a.tsx', 'src/core/hub.ts'),
      link('src/ui/b.tsx', 'src/core/hub.ts'),
      link('src/core/hub.ts', 'src/data/x.ts'),
      link('src/core/hub.ts', 'src/data/y.ts'),
      ...['x', 'd1', 'd2', 'd3'].map(x => link(`src/data/${x}.ts`, 'src/data/mid.ts')),
      link('src/data/mid.ts', 'src/data/leaf.ts'),
      link('src/data/leaf.ts', 'src/data/leaf2.ts'),
    ],
  )

describe('bridges', () => {
  it('are the files most shortest paths run through that connect two other blocks, with their blocks above and below', () => {
    const g = chain()
    const code = codeGraph(g, g.nodes, blockOf)
    // hub: a, b → x, y, mid, leaf, leaf2: 10 pairs of 10 × 9. mid (14 pairs) and x (9) are inside data, with one other block around them at most
    expect(bridgesOf(code, notVendored)).toEqual([
      { path: 'src/core/hub.ts', block: 'src/core', score: 0.111, fanIn: 2, fanOut: 2, above: [{ block: 'src/ui', files: 2 }], below: [{ block: 'src/data', files: 2 }] },
    ])
    expect(bridgesOf(code, p => p === 'src/core/hub.ts')).toEqual([])
  })

  it('ask why one ties its blocks together', () => {
    expect(ofType(ask(chain()), 'bridge')).toEqual([
      {
        type: 'bridge',
        question: 'Why does `src/core/hub.ts` connect `src/ui` to `src/data`?',
        why: '11 % of the shortest dependency paths between two other files run through it (betweenness 0.111); 2 files use it, it uses 2',
        files: ['src/core/hub.ts'],
      },
    ])
  })

  it('leave navigations out: a link to a page is not a dependency on its code', () => {
    const g = chain()
    g.nodes.push(file('src/app/page.tsx', { tags: ['route:/'] }))
    g.edges.push(link('src/data/leaf2.ts', 'src/app/page.tsx', { kind: 'navigates', subkind: '/', confidence: 'inferred' }))
    const code = codeGraph(g, g.nodes, blockOf)
    expect(code.in.get('f:src/app/page.tsx')).toBeUndefined()
    expect(bridgesOf(code, notVendored).map(b => b.path)).toEqual(['src/core/hub.ts'])
  })

  it('are none without blocks to connect', () => {
    const g = graphOf([file('src/a/x.ts'), file('src/a/y.ts'), file('src/a/z.ts')], [link('src/a/x.ts', 'src/a/y.ts'), link('src/a/y.ts', 'src/a/z.ts')])
    expect(bridgesOf(codeGraph(g, g.nodes, blockOf), notVendored)).toEqual([])
    expect(ofType(ask(g), 'bridge')).toEqual([])
  })
})

describe('hidden coupling', () => {
  const files = ['src/a/one.ts', 'src/a/two.ts', 'src/b/three.ts', 'src/b/four.ts', 'src/c/five.ts'].map(p => file(p))

  it('asks about files that change together with no dependency between them, the strongest first', () => {
    const g = graphOf(files, [coChange('src/a/one.ts', 'src/b/three.ts', 4, 0.5), coChange('src/a/two.ts', 'src/c/five.ts', 6, 1)])
    expect(ofType(ask(g), 'hidden coupling')).toEqual([
      {
        type: 'hidden coupling',
        question: 'Why do `src/a/two.ts` and `src/c/five.ts` change together (6 commits) without depending on each other?',
        why: '6 commits changed both, 100 % of those of the one that changes less; neither depends on the other, not even through 2 other files',
        files: ['src/a/two.ts', 'src/c/five.ts'],
      },
      expect.objectContaining({ files: ['src/a/one.ts', 'src/b/three.ts'] }),
    ])
  })

  it('stays quiet when one reaches the other within three steps, either way, or without history', () => {
    const chained = [link('src/b/three.ts', 'src/b/four.ts'), link('src/b/four.ts', 'src/c/five.ts'), link('src/c/five.ts', 'src/a/one.ts')]
    expect(ofType(ask(graphOf(files, [...chained, coChange('src/a/one.ts', 'src/b/three.ts', 9)])), 'hidden coupling')).toEqual([])
    expect(ofType(ask(graphOf(files, chained)), 'hidden coupling')).toEqual([])
    // four steps away is out of sight
    const longer = [link('src/a/two.ts', 'src/b/three.ts'), ...chained]
    expect(ofType(ask(graphOf(files, [...longer, coChange('src/a/two.ts', 'src/a/one.ts', 3)])), 'hidden coupling')).toHaveLength(1)
  })

  it('asks once about files changing with their namesakes in another folder (translations)', () => {
    const twins = ['guide/de/plans.ts', 'guide/en/plans.ts', 'guide/de/home.ts', 'guide/en/home.ts', 'src/a/one.ts', 'src/b/three.ts'].map(p => file(p))
    const g = graphOf(twins, [coChange('guide/de/plans.ts', 'guide/en/plans.ts', 9), coChange('src/a/one.ts', 'src/b/three.ts', 5), coChange('guide/en/home.ts', 'guide/de/home.ts', 4)])
    expect(ofType(ask(g), 'hidden coupling')).toEqual([
      {
        type: 'hidden coupling',
        question: 'Why do files in `guide/de` change together with their namesakes in `guide/en` (2 pairs) without depending on them?',
        why: '`plans.ts` 9 commits, `home.ts` 4 commits; none depends on its namesake, not even through 2 other files',
        files: ['guide/de/plans.ts', 'guide/en/plans.ts', 'guide/en/home.ts', 'guide/de/home.ts'],
      },
      expect.objectContaining({ files: ['src/a/one.ts', 'src/b/three.ts'] }),
    ])
  })
})

describe('risky hubs', () => {
  const hubGraph = (hotspot: number) =>
    graphOf(
      [file('src/lib/core.ts', { metrics: { hotspot, commits: 40, churn: 300, complexity: 25 } }), ...['a', 'b', 'c'].map(x => file(`src/ui/${x}.tsx`, { metrics: { hotspot: 5 } }))],
      ['a', 'b', 'c'].map(x => link(`src/ui/${x}.tsx`, 'src/lib/core.ts')),
      { history: { head: 'h', commits: 50, authors: 2, since: 0, until: 1, windowDays: 90 } },
    )

  it('asks whether a much-used file that keeps changing has a settled interface', () => {
    expect(ofType(ask(hubGraph(7500)), 'risky hub')).toEqual([
      {
        type: 'risky hub',
        question: '`src/lib/core.ts` is used by 3 files and changed in 40 commits: is its interface settled?',
        why: 'among the 20 most used production files and the 20 hotspots: 300 lines changed in the last 90 days, complexity 25',
        files: ['src/lib/core.ts'],
      },
    ])
  })

  it('stays quiet for a much-used file that doesn’t change', () => {
    expect(ofType(ask(hubGraph(0)), 'risky hub')).toEqual([])
  })
})

describe('unused files', () => {
  const used = ['src/lib/used.ts']
  const g = () =>
    graphOf(
      [
        file('src/main.tsx', { tags: ['entrypoint'] }),
        file('src/lib/used.ts'),
        file('src/lib/orphan.ts', { metrics: { loc: 40 } }),
        file('src/lib/tested.ts', { metrics: { loc: 10 } }),
        file('src/lib/orphan.test.ts', { tags: ['test'] }),
        file('src/app/settings/page.tsx', { tags: ['route:/settings'] }),
        file('src/app/api/health/route.ts', { tags: ['api:/api/health'] }),
        file('src/app/layout.tsx', { tags: ['layout:/'] }),
        file('src/types/env.d.ts', { tags: ['declaration'] }),
        file('vite.config.ts'),
        file('src/web/OrderController.kt'),
        { id: 's:src/web/OrderController.kt#OrderController', kind: 'symbol', subkind: 'class', name: 'OrderController', parent: 'f:src/web/OrderController.kt', path: 'src/web/OrderController.kt', tags: ['spring', 'entrypoint'] },
        file('cmd/tool/main.go'),
        { id: 's:cmd/tool/main.go#main', kind: 'symbol', subkind: 'function', name: 'main', parent: 'f:cmd/tool/main.go', path: 'cmd/tool/main.go' },
        file('src/components/ui/unused-kit.tsx'),
      ],
      [link('src/main.tsx', used[0]), link('src/lib/orphan.test.ts', 'src/lib/tested.ts')],
    )

  it('asks about production files nothing depends on, the largest first, and says when only tests do', () => {
    expect(ofType(ask(g(), p => p.startsWith('src/components/ui/')), 'unused file')).toEqual([
      { type: 'unused file', question: 'Is `src/lib/orphan.ts` still used? Nothing depends on it.', why: '40 lines; no production file imports or calls it, and no framework, page or script loads it', files: ['src/lib/orphan.ts'] },
      {
        type: 'unused file',
        question: 'Is `src/lib/tested.ts` still used? Only tests depend on it.',
        why: '10 lines; no production file imports or calls it (only 1 test file), and no framework, page or script loads it',
        files: ['src/lib/tested.ts'],
      },
    ])
  })

  it('never counts entry points, routes, declarations, config files, framework-called code, tests or copied-in code', () => {
    expect([...entryPaths(g())].sort()).toEqual(['cmd/tool/main.go', 'src/app/api/health/route.ts', 'src/app/layout.tsx', 'src/app/settings/page.tsx', 'src/main.tsx', 'src/types/env.d.ts', 'src/web/OrderController.kt'])
    const files = ofType(ask(g(), p => p.startsWith('src/components/ui/')), 'unused file').flatMap(q => q.files)
    expect(files).toEqual(['src/lib/orphan.ts', 'src/lib/tested.ts'])
  })

  it('stays quiet when everything is used', () => {
    const all = graphOf([file('src/main.tsx', { tags: ['entrypoint'] }), file('src/lib/used.ts')], [link('src/main.tsx', 'src/lib/used.ts')])
    expect(ofType(ask(all), 'unused file')).toEqual([])
  })
})

describe('split blocks', () => {
  /** Three files each importing the other two. */
  const triangle = (dir: string, name: string) => {
    const ps = [1, 2, 3].map(i => `${dir}/${name}${i}.ts`)
    return { nodes: ps.map(p => file(p)), edges: ps.flatMap(a => ps.filter(b => b !== a).map(b => link(a, b))) }
  }
  const blockWith = (groups: number) => {
    const parts = Array.from({ length: groups }, (_, i) => triangle('src/lib', 'abc'[i]))
    // a pair beside them is too small to count
    const pair = [file('src/lib/p1.ts'), file('src/lib/p2.ts')]
    return graphOf([...parts.flatMap(p => p.nodes), ...pair], [...parts.flatMap(p => p.edges), link('src/lib/p1.ts', 'src/lib/p2.ts')])
  }

  it('asks whether a block whose files fall into three modules of three or more is one block', () => {
    expect(ofType(ask(blockWith(3)), 'split block')).toEqual([
      {
        type: 'split block',
        question: 'Is `src/lib` one block or 3?',
        why: 'the dependencies split its 11 files into 3 groups of 3 or more that use each other more than the rest: 3 around `src/lib/a1.ts`, 3 around `src/lib/b1.ts`, 3 around `src/lib/c1.ts`',
        files: ['src/lib/a1.ts', 'src/lib/b1.ts', 'src/lib/c1.ts'],
      },
    ])
  })

  it('stays quiet for two', () => {
    expect(ofType(ask(blockWith(2)), 'split block')).toEqual([])
  })
})

describe('inferred links', () => {
  const nodes = ['src/web/client.ts', 'src/web/screen.tsx', 'src/api/handler.ts', 'src/app/page.tsx'].map(p => file(p))

  it('asks whether a link guessed from names across blocks is right, the ones nothing else backs first, navigations last', () => {
    const g = graphOf(nodes, [
      link('src/web/screen.tsx', 'src/app/page.tsx', { kind: 'navigates', subkind: '/orders', confidence: 'inferred' }),
      link('src/web/client.ts', 'src/api/handler.ts', { kind: 'http-call', subkind: 'POST', confidence: 'inferred' }),
    ])
    expect(ofType(ask(g), 'inferred link')).toEqual([
      {
        type: 'inferred link',
        question: 'Is the inferred link `src/web/client.ts` → `src/api/handler.ts` (http-call) right?',
        why: 'an HTTP call (POST) matched to its handler by the URL; no other dependency links `src/web` to `src/api`',
        files: ['src/web/client.ts', 'src/api/handler.ts'],
      },
      expect.objectContaining({ question: 'Is the inferred link `src/web/screen.tsx` → `src/app/page.tsx` (navigates) right?', why: 'a link to /orders matched to the page that serves it; no other dependency links `src/web` to `src/app`' }),
    ])
    g.edges.push(link('src/web/screen.tsx', 'src/api/handler.ts'))
    expect(ofType(ask(g), 'inferred link')[0].why).toBe('an HTTP call (POST) matched to its handler by the URL; it links `src/web` to `src/api`')
  })

  it('stays quiet for exact links, links inside a block and co-changes', () => {
    const g = graphOf(nodes, [
      link('src/web/client.ts', 'src/api/handler.ts'),
      link('src/web/client.ts', 'src/web/screen.tsx', { kind: 'navigates', confidence: 'inferred' }),
      coChange('src/web/client.ts', 'src/app/page.tsx', 5),
    ])
    expect(ofType(ask(g), 'inferred link')).toEqual([])
  })
})

describe('the questions together', () => {
  it('take turns by type, keep each type’s order, and stop at the cap', () => {
    expect(interleave([['a1', 'a2', 'a3'], [], ['c1'], ['d1', 'd2']], 7)).toEqual(['a1', 'c1', 'd1', 'a2', 'd2', 'a3'])
    expect(interleave([['a1', 'a2', 'a3'], [], ['c1'], ['d1', 'd2']], 4)).toEqual(['a1', 'c1', 'd1', 'a2'])
    expect(interleave([], 7)).toEqual([])
  })

  it('are at most seven, no type crowding out the rest, the same each time', () => {
    // five files nothing uses, five pairs changing together, a split block and a guessed link
    const orphans = [1, 2, 3, 4, 5].map(i => file(`src/old/o${i}.ts`, { metrics: { loc: 10 * i } }))
    const pairs = [1, 2, 3, 4, 5].map(i => [file(`src/p/x${i}.ts`), file(`src/q/y${i}.ts`)])
    const g = graphOf(
      [file('src/main.ts', { tags: ['entrypoint'] }), ...orphans, ...pairs.flat()],
      [...pairs.flatMap(([x, y], i) => [link('src/main.ts', x.path!), link('src/main.ts', y.path!), coChange(x.path!, y.path!, 10 - i)]), link('src/p/x1.ts', 'src/q/y5.ts', { kind: 'http-call', confidence: 'inferred' })],
    )
    const qs = ask(g)
    expect(qs).toHaveLength(MAX_QUESTIONS)
    expect(qs.map(q => q.type)).toEqual(['hidden coupling', 'unused file', 'inferred link', 'hidden coupling', 'unused file', 'hidden coupling', 'unused file'])
    expect(qs.filter(q => q.type === 'unused file').map(q => q.files[0])).toEqual(['src/old/o5.ts', 'src/old/o4.ts', 'src/old/o3.ts'])
    expect(ask(g)).toEqual(qs)
  })
})
