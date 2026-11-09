import { describe, expect, it } from 'vitest'
import { diffArchitecture } from '../../src/core/diff.ts'
import type { Graph } from '../../src/core/model.ts'
import { evaluateRules } from '../../src/core/rules.ts'
import { appGraph, blockOf, coherenceOfApp } from '../helpers/query-graph.ts'
import type { AppFile } from '../helpers/query-graph.ts'

// before: pages call the server through tRPC but c.tsx fetches; the old reports use Moment.js
const BASE: AppFile[] = [
  { path: 'src/app/a.tsx', ways: ['js.http=trpc'], uses: ['src/lib/api.ts'] },
  { path: 'src/app/b.tsx', ways: ['js.http=trpc'] },
  { path: 'src/app/c.tsx', ways: ['js.http=fetch'] },
  { path: 'src/lib/api.ts', uses: ['src/server/db.ts'] },
  { path: 'src/lib/dates.ts', ways: ['js.dates=date-fns'] },
  { path: 'src/server/db.ts' },
  { path: 'src/old/r1.ts', ways: ['js.dates=moment'] },
  { path: 'src/old/r2.ts', ways: ['js.dates=moment'] },
  { path: 'src/old/r3.ts', ways: ['js.dates=moment'] },
]

// after: c.tsx moved to tRPC; a new page d.tsx calls with axios and goes to the database; the
// database imports the client back (a cycle); r1 left Moment.js for date-fns
const HEAD: AppFile[] = [
  ...BASE.filter(f => !['src/app/c.tsx', 'src/server/db.ts', 'src/old/r1.ts'].includes(f.path)),
  { path: 'src/app/c.tsx', ways: ['js.http=trpc'] },
  { path: 'src/app/d.tsx', ways: ['js.http=axios'], uses: ['src/server/db.ts'] },
  { path: 'src/server/db.ts', uses: ['src/lib/api.ts'] },
  { path: 'src/old/r1.ts', ways: ['js.dates=date-fns'] },
]

const rules = [
  { name: 'no-app-to-server', forbid: { from: 'src/app/**', to: 'src/server/**' } },
  { name: 'no-cycles', cycles: 'forbid' as const },
]

function diff(touched?: string[]) {
  const [base, head] = [appGraph(BASE, rules), appGraph(HEAD, rules)]
  return diffArchitecture({ base: { graph: base, coherence: coherenceOfApp(base) }, head: { graph: head, coherence: coherenceOfApp(head) }, blockOf, touched })
}

describe('what a change does to the architecture', () => {
  const d = diff(['src/app/c.tsx', 'src/app/d.tsx', 'src/server/db.ts', 'src/old/r1.ts'])

  it('finds the rules it breaks and the import cycles it makes', () => {
    expect(d.rules.added.map(v => [v.rule, v.from, v.to])).toEqual([
      ['no-app-to-server', 'f:src/app/d.tsx', 'f:src/server/db.ts'],
      ['no-cycles', 'f:src/lib/api.ts', 'f:src/server/db.ts'],
    ])
    expect(d.rules.fixed).toEqual([])
    expect(d.cycles.added).toEqual([['f:src/lib/api.ts', 'f:src/server/db.ts']])
    expect(d.files).toEqual({ added: ['src/app/d.tsx'], removed: [] })
  })

  it('finds a new way, the file that now differs from its block, and the one back in line', () => {
    const http = d.jobs.find(j => j.id === 'js.http')!
    expect(http.newWays).toEqual(['axios'])
    expect(http.goneWays).toEqual(['fetch'])
    expect(http.deviations).toEqual([{ path: 'src/app/d.tsx', ways: ['axios'], block: 'src/app', blockWay: 'tRPC client', examples: ['src/app/a.tsx', 'src/app/b.tsx'], touched: true }])
    expect(http.resolved).toEqual(['src/app/c.tsx'])
    expect(http.before).toMatchObject({ kind: 'mixed', ways: ['tRPC client', 'fetch'] })
    expect(http.after).toMatchObject({ kind: 'mixed', ways: ['tRPC client', 'axios'] })
  })

  it('counts a move off a legacy way as progress, not as a file differing from its block', () => {
    const dates = d.jobs.find(j => j.id === 'js.dates')!
    expect(dates.deviations).toEqual([])
    expect(dates.progress).toEqual([{ path: 'src/old/r1.ts', from: ['Moment.js'], to: ['date-fns'] }])
    // a file with something to look at comes first
    expect(d.jobs.map(j => j.id)).toEqual(['js.http', 'js.dates'])
  })

  it('finds the blocks that start depending on each other', () => {
    expect(d.blocks.added).toEqual([
      { from: 'src/app', to: 'src/server', via: ['src/app/d.tsx', 'src/server/db.ts'] },
      { from: 'src/server', to: 'src/lib', via: ['src/server/db.ts', 'src/lib/api.ts'] },
    ])
    expect(d.blocks.removed).toEqual([])
  })

  it('has nothing to say about a change that keeps the architecture', () => {
    const base = appGraph(BASE, rules)
    const same = diffArchitecture({ base: { graph: base, coherence: coherenceOfApp(base) }, head: { graph: base, coherence: coherenceOfApp(base) }, blockOf })
    expect(same).toEqual({ files: { added: [], removed: [] }, rules: { added: [], grew: [], fixed: [], unmatched: [] }, cycles: { added: [], fixed: [] }, jobs: [], blocks: { added: [], removed: [] }, reach: { added: [], removed: [] }, docs: [] })
  })

  it('names a rule the change leaves matching nothing, once', () => {
    const rules = [{ name: 'old-stays-old', forbid: { from: 'src/old/**', to: 'src/app/**' } }]
    const moved = BASE.map(f => ({ ...f, path: f.path.replace('src/old/', 'src/legacy/') }))
    const sides = (a: AppFile[], b: AppFile[]) => {
      const [base, head] = [appGraph(a, rules), appGraph(b, rules)]
      return diffArchitecture({ base: { graph: base, coherence: coherenceOfApp(base) }, head: { graph: head, coherence: coherenceOfApp(head) }, blockOf })
    }
    expect(sides(BASE, moved).rules.unmatched).toEqual([{ rule: 'old-stays-old', severity: 'error', parts: ['from src/old/** matches no file'] }])
    expect(sides(moved, moved).rules.unmatched).toEqual([])
  })

  it('reports a limit broken by the change, not the ones broken before', () => {
    const rules = [{ name: 'small-pages', severity: 'warn' as const, limit: { files: 'src/app/**', max: { loc: 5 } } }]
    const [base, head] = [appGraph(BASE, rules), appGraph(HEAD, rules)]
    const d = diffArchitecture({ base: { graph: base, coherence: coherenceOfApp(base) }, head: { graph: head, coherence: coherenceOfApp(head) }, blockOf })
    expect(d.rules.added.map(v => v.message)).toEqual(['src/app/d.tsx: loc 10, more than 5'])
    expect(d.rules.fixed).toEqual([])
  })

  it('counts only touched files as new when it knows them (a generated file is not the change’s)', () => {
    expect(diff([]).files.added).toEqual([])
    expect(diff().files.added).toEqual(['src/app/d.tsx'])
  })
})

describe('limits broken further', () => {
  const rules = [{ name: 'small-functions', severity: 'warn' as const, limit: { functions: 'src/**', max: { complexity: 9 } } }]
  // src/lib/api.ts with functions of these complexities
  const withFunctions = (complexities: Record<string, number>): Graph => {
    const g = appGraph(BASE, rules)
    for (const [name, complexity] of Object.entries(complexities))
      g.nodes.push({ id: `s:src/lib/api.ts#${name}`, kind: 'symbol', subkind: 'function', name, parent: 'f:src/lib/api.ts', path: 'src/lib/api.ts', range: [1, 1, 30, 1], metrics: { complexity } })
    g.meta.violations = evaluateRules(g, rules)
    return g
  }
  const sides = (base: Graph, head: Graph) => diffArchitecture({ base: { graph: base, coherence: coherenceOfApp(base) }, head: { graph: head, coherence: coherenceOfApp(head) }, blockOf })

  it('reports a function already over its limit that grows, with both measures; not one that stays or shrinks', () => {
    const d = sides(withFunctions({ load: 12, save: 30, parse: 15, small: 3 }), withFunctions({ load: 14, save: 30, parse: 11, small: 10 }))
    expect(d.rules.added.map(v => v.measure!.symbol)).toEqual(['s:src/lib/api.ts#small'])
    expect(d.rules.grew.map(g => [g.after.measure!.symbol, g.before.measure!.value, g.after.measure!.value])).toEqual([['s:src/lib/api.ts#load', 12, 14]])
    expect(d.rules.fixed).toEqual([])
  })

  it('counts a minimum broken further the other way: the measure falls', () => {
    const atLeast = [{ name: 'tested', severity: 'warn' as const, limit: { files: 'src/lib/**', min: { testReach: 3 } } }]
    const reach = (n: number) => {
      const g = appGraph(BASE, atLeast)
      for (const f of g.nodes) if (f.path === 'src/lib/api.ts') f.metrics = { ...f.metrics, testReach: n }
      g.meta.violations = evaluateRules(g, atLeast)
      return g
    }
    expect(sides(reach(2), reach(1)).rules.grew.map(g => [g.before.measure!.value, g.after.measure!.value])).toEqual([[2, 1]])
    expect(sides(reach(1), reach(2)).rules.grew).toEqual([])
  })
})

describe('documents kept current', () => {
  // the base: docs/data.md (kept current) names src/old/r2.ts and api.ts's `connect`; the head drops r2.ts and changes connect's signature
  const symbol = (sig: string) => ({ id: 's:src/lib/api.ts#connect', kind: 'symbol' as const, subkind: 'function', name: 'connect', path: 'src/lib/api.ts', parent: 'f:src/lib/api.ts', exported: true, signature: sig })
  const withDocs = (g: Graph, sig: string, mentions: string[], dangling: string[] = []): Graph => {
    g.nodes.push(symbol(sig))
    g.meta.docs = {
      docs: [
        { path: 'docs/data.md', title: 'Data', current: true, mentions: mentions.map((node, i) => ({ node, line: i + 1, section: 'Storage', count: 1 })), ...(dangling.length ? { dangling: dangling.map(text => ({ text, line: 9 })) } : {}) },
        { path: 'docs/historical/x.md', title: 'Old', mentions: [{ node: 'f:src/lib/api.ts', line: 1, count: 1 }] },
      ],
      ids: [],
    }
    return g
  }

  it('names the places that name code the change removes, or whose exports or signature change', () => {
    const base = withDocs(appGraph(BASE, rules), '(): void', ['f:src/old/r2.ts', 's:src/lib/api.ts#connect', 'f:src/lib/dates.ts'])
    const head = withDocs(appGraph(BASE.filter(f => f.path !== 'src/old/r2.ts'), rules), '(url: string): void', ['s:src/lib/api.ts#connect', 'f:src/lib/dates.ts'], ['src/old/r2.ts'])
    const d = diffArchitecture({ base: { graph: base, coherence: coherenceOfApp(base) }, head: { graph: head, coherence: coherenceOfApp(head) }, blockOf, touched: ['src/old/r2.ts', 'src/lib/api.ts'] })
    expect(d.docs.map(x => [x.doc, x.line, x.names, x.why])).toEqual([
      ['docs/data.md', 1, 'src/old/r2.ts', 'removed'],
      ['docs/data.md', 1, 'src/lib/api.ts › connect', 'reshaped'],
    ])
  })

  it('says nothing without documents', () => {
    expect(diff().docs).toEqual([])
  })
})
