import { describe, expect, it } from 'vitest'
import type { Graph, GraphEdge, GraphNode } from '../../src/core/model.ts'
import { reachDiff } from '../../src/core/reach.ts'

// A small app: pages are entry points; `uses` are runtime imports in every target unless the
// import names its targets (`src/lib/x.ts@desktop`) or is type-only (`type:src/lib/x.ts`);
// `x:npm:` and `x:node:` ids are packages.
interface Spec {
  path: string
  uses?: string[]
  entry?: boolean
  test?: boolean
}

const TARGETS = ['web', 'desktop']

function graph(specs: Spec[]): Graph {
  const files: GraphNode[] = specs.map(s => ({ id: `f:${s.path}`, kind: 'file', name: s.path.split('/').pop()!, path: s.path, tags: [...(s.entry ? ['entrypoint'] : []), ...(s.test ? ['test'] : [])] }))
  const edges: GraphEdge[] = specs.flatMap(s =>
    (s.uses ?? []).map(u => {
      const typeOnly = u.startsWith('type:')
      const [to, target] = u.replace(/^type:/, '').split('@')
      return { source: `f:${s.path}`, target: to.startsWith('x:') ? to : `f:${to}`, kind: 'imports' as const, subkind: typeOnly ? 'type-only' : 'static', count: 1, targets: target ? [target] : TARGETS, confidence: 'exact' as const }
    }),
  )
  const externals: GraphNode[] = [...new Set(edges.map(e => e.target).filter(t => t.startsWith('x:')))].map(id => ({ id, kind: 'external', name: id.split(':').pop()! }))
  return {
    meta: { name: 'app', generatedAt: '', tool: { name: 'archrift', version: 'test' }, analyzers: [], targets: TARGETS, counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } },
    nodes: [...files, ...externals],
    edges,
    sites: [],
  }
}

/** src/lib/heavy.ts and the five files it imports, which no page loads yet. */
const HEAVY: Spec[] = [{ path: 'src/lib/heavy.ts', uses: ['src/lib/h1.ts', 'src/lib/h2.ts', 'src/lib/h3.ts', 'src/lib/h4.ts', 'src/lib/h5.ts'] }, ...[1, 2, 3, 4, 5].map(i => ({ path: `src/lib/h${i}.ts` }))]
const HEAVY_FILES = ['src/lib/h1.ts', 'src/lib/h2.ts', 'src/lib/h3.ts', 'src/lib/h4.ts', 'src/lib/h5.ts', 'src/lib/heavy.ts']

// two pages load src/lib/format.ts; settings also loads src/lib/b.ts
const BASE: Spec[] = [
  { path: 'src/app/plans/page.tsx', entry: true, uses: ['src/lib/format.ts'] },
  { path: 'src/app/settings/page.tsx', entry: true, uses: ['src/lib/format.ts', 'src/lib/b.ts'] },
  { path: 'src/lib/format.ts' },
  { path: 'src/lib/b.ts' },
  ...HEAVY,
]
/** BASE with `path`'s imports replaced. */
const withUses = (specs: Spec[], path: string, uses: string[]): Spec[] => specs.map(s => (s.path === path ? { ...s, uses } : s))

describe('what a change’s imports bring into the entry points', () => {
  it('pins every file one new import brings in on that import, with each page that now loads them', () => {
    const head = withUses(BASE, 'src/lib/format.ts', ['src/lib/heavy.ts'])
    expect(reachDiff(graph(BASE), graph(head), ['src/lib/format.ts'])).toEqual({
      added: [{ from: 'src/lib/format.ts', to: 'src/lib/heavy.ts', files: HEAVY_FILES, packages: [], entries: ['src/app/plans/page.tsx', 'src/app/settings/page.tsx'], targets: ['desktop', 'web'] }],
      removed: [],
    })
  })

  it('blames the import nearest to a file, not an unrelated new one on the way from the page', () => {
    // plans now loads b.ts too (one ordinary file), and b.ts, which settings already loaded, now imports heavy
    const head = withUses(withUses(BASE, 'src/app/plans/page.tsx', ['src/lib/format.ts', 'src/lib/b.ts']), 'src/lib/b.ts', ['src/lib/heavy.ts'])
    const { added } = reachDiff(graph(BASE), graph(head), ['src/app/plans/page.tsx', 'src/lib/b.ts'])
    expect(added.map(c => [c.from, c.to, c.files, c.entries])).toEqual([['src/lib/b.ts', 'src/lib/heavy.ts', HEAVY_FILES, ['src/app/plans/page.tsx', 'src/app/settings/page.tsx']]])
  })

  it('leaves out files the change touched, and names the new file’s import that brings the rest', () => {
    const head = [...withUses(BASE, 'src/app/plans/page.tsx', ['src/lib/format.ts', 'src/lib/new.ts']), { path: 'src/lib/new.ts', uses: ['src/lib/heavy.ts'] }]
    const [change, ...rest] = reachDiff(graph(BASE), graph(head), ['src/app/plans/page.tsx', 'src/lib/new.ts', 'src/lib/h1.ts']).added
    expect(rest).toEqual([]) // the page's import of new.ts brings only new.ts, which the change wrote
    expect(change).toMatchObject({ from: 'src/lib/new.ts', to: 'src/lib/heavy.ts', entries: ['src/app/plans/page.tsx'] })
    expect(change.files).toEqual(HEAVY_FILES.filter(f => f !== 'src/lib/h1.ts'))
  })

  it('counts an entry point only where it gains something counted', () => {
    // settings loaded h1–h5 already; format.ts now imports heavy, which the change touched: settings gains nothing counted
    const base = withUses(BASE, 'src/app/settings/page.tsx', ['src/lib/format.ts', 'src/lib/b.ts', ...HEAVY_FILES.filter(f => f !== 'src/lib/heavy.ts')])
    const head = withUses(base, 'src/lib/format.ts', ['src/lib/heavy.ts'])
    expect(reachDiff(graph(base), graph(head), ['src/lib/format.ts', 'src/lib/heavy.ts']).added.map(c => [c.files.length, c.entries])).toEqual([[5, ['src/app/plans/page.tsx']]])
  })

  it('counts a package the target didn’t load at all, however few files come with it; not one another page loaded already', () => {
    const base = withUses(BASE, 'src/lib/b.ts', ['x:npm:date-fns'])
    const head = withUses(base, 'src/lib/format.ts', ['x:npm:date-fns', 'x:npm:dayjs', 'x:node:fs'])
    const pages = ['src/app/plans/page.tsx', 'src/app/settings/page.tsx']
    expect(reachDiff(graph(base), graph(head), ['src/lib/format.ts']).added).toEqual([
      { from: 'src/lib/format.ts', to: 'dayjs', files: [], packages: ['dayjs'], entries: pages, targets: ['desktop', 'web'] },
      { from: 'src/lib/format.ts', to: 'node:fs', files: [], packages: ['node:fs'], entries: pages, targets: ['desktop', 'web'] },
    ])
  })

  it('leaves out an import bringing in fewer files than the minimum, and no package', () => {
    const head = withUses(BASE, 'src/lib/format.ts', ['src/lib/h1.ts'])
    expect(reachDiff(graph(BASE), graph(head), ['src/lib/format.ts']).added).toEqual([])
    expect(reachDiff(graph(BASE), graph(head), ['src/lib/format.ts'], 1).added.map(c => c.files)).toEqual([['src/lib/h1.ts']])
  })

  it('follows runtime imports of one build target: a type-only import brings nothing, a desktop-only one only into desktop', () => {
    const typeOnly = withUses(BASE, 'src/lib/format.ts', ['type:src/lib/heavy.ts'])
    expect(reachDiff(graph(BASE), graph(typeOnly), ['src/lib/format.ts']).added).toEqual([])
    const desktop = withUses(BASE, 'src/lib/format.ts', ['src/lib/heavy.ts@desktop'])
    expect(reachDiff(graph(BASE), graph(desktop), ['src/lib/format.ts']).added.map(c => c.targets)).toEqual([['desktop']])
  })

  it('says nothing about a new page (all it loads is new) or a test', () => {
    const head = [...BASE, { path: 'src/app/new/page.tsx', entry: true, uses: ['src/lib/heavy.ts'] }, { path: 'tests/heavy.test.ts', entry: true, test: true, uses: ['src/lib/heavy.ts'] }]
    expect(reachDiff(graph(BASE), graph(head), ['src/app/new/page.tsx', 'tests/heavy.test.ts'])).toEqual({ added: [], removed: [] })
  })

  it('finds an import that is gone, with what the pages no longer load', () => {
    const before = withUses(BASE, 'src/lib/format.ts', ['src/lib/heavy.ts'])
    expect(reachDiff(graph(before), graph(BASE), ['src/lib/format.ts'])).toEqual({
      added: [],
      removed: [{ from: 'src/lib/format.ts', to: 'src/lib/heavy.ts', files: HEAVY_FILES, packages: [], entries: ['src/app/plans/page.tsx', 'src/app/settings/page.tsx'], targets: ['desktop', 'web'] }],
    })
  })
})
