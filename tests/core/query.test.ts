import { describe, expect, it } from 'vitest'
import type { FileCoverage } from '../../src/core/crap.ts'
import type { GraphNode } from '../../src/core/model.ts'
import { Query, findJobs } from '../../src/core/query.ts'
import type { Place } from '../../src/core/query.ts'
import type { ImpactAnswer, ImpactStart } from '../../src/core/query.ts'
import { RULES, appGraph, blockOf, coherenceOfApp, tagsFor } from '../helpers/query-graph.ts'
import { IMPACT_FILES } from '../helpers/query-graph.ts'
import type { AppFile } from '../helpers/query-graph.ts'
import { waysText } from '../../src/cli/query.ts'

// pages call the server through tRPC, but c.tsx fetches and reaches the database; the old
// reports still use Moment.js where the library moved to date-fns
const FILES: AppFile[] = [
  { path: 'src/app/a.tsx', ways: ['js.http=trpc'], uses: ['src/lib/api.ts'] },
  { path: 'src/app/b.tsx', ways: ['js.http=trpc'] },
  { path: 'src/app/c.tsx', ways: ['js.http=fetch'], uses: ['src/lib/api.ts', 'src/server/db.ts'] },
  { path: 'src/app/index.ts' },
  { path: 'src/lib/api.ts', ways: ['js.http=fetch'], uses: ['src/server/db.ts'] },
  { path: 'src/lib/dates.ts', ways: ['js.dates=date-fns'] },
  { path: 'src/lib/index.ts' },
  { path: 'src/server/db.ts' },
  { path: 'src/old/r1.ts', ways: ['js.dates=moment'] },
  { path: 'src/old/r2.ts', ways: ['js.dates=moment'] },
]

function query(files = FILES) {
  const graph = appGraph(files)
  return new Query({ graph, coherence: coherenceOfApp(graph), blockOf, tagsFor, rules: RULES })
}

const file = (q: Query, p: string) => q.place(p) as Place & { kind: 'file' }

describe('what a path stands for', () => {
  const q = query()

  it('is a file, a folder, a file by its unique name, or a new file', () => {
    expect(q.place('src/app/a.tsx')).toEqual({ kind: 'file', path: 'src/app/a.tsx', id: 'f:src/app/a.tsx' })
    expect(q.place('./src/app/')).toMatchObject({ kind: 'folder', path: 'src/app', files: ['f:src/app/a.tsx', 'f:src/app/b.tsx', 'f:src/app/c.tsx', 'f:src/app/index.ts'] })
    expect(q.place('c.tsx')).toMatchObject({ kind: 'file', path: 'src/app/c.tsx' })
    expect(q.place('lib/api')).toMatchObject({ kind: 'file', path: 'src/lib/api.ts' })
    expect(q.place('src/server/new.ts')).toEqual({ kind: 'new', path: 'src/server/new.ts' })
  })

  it('asks which file when several have the name; a package by its name; nothing for an unknown word', () => {
    expect(q.place('index.ts')).toEqual({ kind: 'ambiguous', path: 'index.ts', candidates: ['src/app/index.ts', 'src/lib/index.ts'] })
    expect(q.place('@tauri-apps/api/core')).toEqual({ kind: 'external', path: '@tauri-apps/api/core', id: 'x:npm:@tauri-apps/api' })
    expect(q.place('lodash/fp')).toMatchObject({ kind: 'external', id: 'x:npm:lodash' })
    expect(q.place('react')).toEqual({ kind: 'missing', path: 'react' })
  })
})

describe('which jobs a question names', () => {
  const c = coherenceOfApp(appGraph(FILES))
  it('by id, its last part, its label, or the words of its description', () => {
    expect(findJobs(c, 'js.http').map(s => s.concern.id)).toEqual(['js.http'])
    expect(findJobs(c, 'http').map(s => s.concern.id)).toEqual(['js.http'])
    expect(findJobs(c, 'Dates').map(s => s.concern.id)).toEqual(['js.dates'])
    expect(findJobs(c, 'how does this folder call the server?').map(s => s.concern.id)).toEqual(['js.http'])
    expect(findJobs(c, 'parsing a date').map(s => s.concern.id)).toEqual(['js.dates'])
    expect(findJobs(c, 'the weather')).toEqual([])
  })
})

describe('ways', () => {
  const q = query()

  it('gives the block’s way, files that take it, and the file here that differs', () => {
    const a = q.ways(q.place('src/app'), 'call the server')
    expect(a.blocks).toEqual(['src/app'])
    expect(a.jobs).toHaveLength(1)
    expect(a.jobs[0]).toMatchObject({ id: 'js.http', kind: 'mixed', project: [{ label: 'fetch', files: 2 }, { label: 'tRPC client', files: 2 }] })
    expect(a.jobs[0].blocks).toEqual([
      {
        block: 'src/app',
        files: 3,
        ways: [
          { id: 'trpc', label: 'tRPC client', files: 2 },
          { id: 'fetch', label: 'fetch', files: 1 },
        ],
        main: { id: 'trpc', label: 'tRPC client' },
        use: { id: 'trpc', label: 'tRPC client' },
        examples: ['src/app/a.tsx', 'src/app/b.tsx'],
      },
    ])
    expect(a.jobs[0].here).toContainEqual({ path: 'src/app/c.tsx', ways: ['fetch'], differs: true })
  })

  it('answers for a file not written yet: where its block doesn’t do the job, the project’s way', () => {
    const a = q.ways(q.place('src/server/new.ts'), 'dates')
    expect(a.place).toEqual({ kind: 'new', path: 'src/server/new.ts' })
    expect(a.jobs[0].blocks[0]).toMatchObject({ block: 'src/server', files: 0, use: { label: 'date-fns' }, examples: ['src/lib/dates.ts'] })
  })

  it('points past a legacy way to the one the project moves to', () => {
    const a = q.ways(q.place('src/old/r3.ts'), 'dates')
    expect(a.jobs[0].migration).toMatchObject({ from: ['Moment.js'], to: 'date-fns' })
    expect(a.jobs[0].migration!.done).toBeCloseTo(1 / 3)
    expect(a.jobs[0].blocks[0]).toMatchObject({ main: { label: 'Moment.js' }, use: { label: 'date-fns' }, examples: ['src/lib/dates.ts'] })
  })

  it('a job that matches none: no job, and every job the project does, to ask instead', () => {
    const a = q.ways(q.place('src/app'), 'read a file')
    expect(a.jobs).toEqual([])
    expect(a.elsewhere.map(e => e.id)).toEqual(['js.http', 'js.dates'])
    expect(waysText(a, 'read a file')).toBe('src/app/ (a folder: 4 files, block src/app)\n\nNo job this project does matches "read a file". Its jobs: HTTP calls (js.http), Dates (js.dates).\n')
  })

  it('without a job: the jobs of the place’s block, and the project’s way for the others', () => {
    const a = q.ways(q.place('src/app/b.tsx'))
    expect(a.jobs.map(j => j.id)).toEqual(['js.http'])
    expect(a.elsewhere).toEqual([{ id: 'js.dates', label: 'Dates', stack: 'JS', use: 'date-fns' }])
  })
})

describe('rules', () => {
  const q = query()

  it('says what a file may depend on, who may depend on it, and what it breaks now', () => {
    const a = q.rules(q.place('src/app/c.tsx'))
    expect(a.layer).toBe('app')
    expect(a.own.map(c => [c.rule, c.says])).toEqual([
      ['no-app-to-server', 'must not depend on src/server/**'],
      ['layers-down', 'is in layer app: may depend on app, lib, server'],
      ['no-cycles', 'must not take part in an import cycle'],
    ])
    expect(a.guarded).toEqual([{ rule: 'layers-down', severity: 'warn', kind: 'layers', says: 'lib, server must not depend on it (layers below app)' }])
    expect(a.violations.map(v => [v.rule, v.from, v.to])).toEqual([['no-app-to-server', 'f:src/app/c.tsx', 'f:src/server/db.ts']])
  })

  it('for a dependency, who must not use it', () => {
    const a = q.rules(q.place('src/server/db.ts'))
    expect(a.guarded.map(c => c.says)).toContain('src/app/** must not depend on it')
  })

  it('tries a new dependency: the rules it would break, errors forbidding it', () => {
    const no = q.mayDepend(q.place('src/app/a.tsx'), q.place('src/server/db.ts'))
    expect(no).toMatchObject({ from: 'src/app/a.tsx', to: 'src/server/db.ts', exists: false, allowed: false })
    expect(no.breaks.map(v => v.rule)).toEqual(['no-app-to-server'])
    // a new file in lib using a page: only the layers warn
    const up = q.mayDepend(q.place('src/lib/new.ts'), q.place('src/app/a.tsx'))
    expect(up).toMatchObject({ allowed: true, breaks: [{ rule: 'layers-down', severity: 'warn' }] })
    // the database using the client closes a cycle
    const cycle = q.mayDepend(q.place('src/server/db.ts'), q.place('src/lib/api.ts'))
    expect(cycle.allowed).toBe(false)
    expect(cycle.breaks.map(v => v.rule).sort()).toEqual(['layers-down', 'no-cycles'])
    // already there: nothing new breaks
    expect(q.mayDepend(q.place('src/lib/api.ts'), q.place('src/server/db.ts'))).toMatchObject({ exists: true, allowed: true, breaks: [] })
  })
})

describe('limits', () => {
  const rules = [...RULES, { name: 'small-pages', severity: 'warn' as const, limit: { files: 'src/app/**', max: { loc: 5 } } }]
  const graph = appGraph(FILES, rules)
  const q = new Query({ graph, coherence: coherenceOfApp(graph), blockOf, tagsFor, rules })

  it('names the limits on a file or a new one, and what breaks them now', () => {
    const a = q.rules(q.place('src/app/c.tsx'))
    expect(a.own.at(-1)).toEqual({ rule: 'small-pages', severity: 'warn', kind: 'limit', says: 'each file: loc at most 5' })
    expect(a.violations.map(v => v.message)).toContain('src/app/c.tsx: loc 10, more than 5')
    expect(q.rules(q.place('src/app/new.tsx')).own.map(c => c.rule)).toContain('small-pages')
    expect(q.rules(q.place('src/lib/api.ts')).own.map(c => c.rule)).toEqual(['layers-down', 'no-cycles'])
  })

  it('never counts a broken limit against a new dependency', () => {
    expect(q.mayDepend(q.place('src/app/a.tsx'), q.place('src/lib/dates.ts'))).toMatchObject({ allowed: true, breaks: [] })
  })
})

describe('paths', () => {
  const q = query()

  it('finds the shortest dependency paths, each hop with its kinds', () => {
    const a = q.paths(q.place('src/app/a.tsx'), q.place('src/server/db.ts'))
    expect(a.reversed).toBe(false)
    expect(a.paths).toEqual([
      [
        { from: 'src/app/a.tsx', to: 'src/lib/api.ts', kinds: ['calls', 'imports'] },
        { from: 'src/lib/api.ts', to: 'src/server/db.ts', kinds: ['calls', 'imports'] },
      ],
    ])
  })

  it('from a folder; the other way round when there is none', () => {
    expect(q.paths(q.place('src/app'), q.place('src/server/db.ts')).paths).toEqual([[{ from: 'src/app/c.tsx', to: 'src/server/db.ts', kinds: ['calls', 'imports'] }]])
    const back = q.paths(q.place('src/server/db.ts'), q.place('src/app/a.tsx'))
    expect(back.reversed).toBe(true)
    expect(back.paths[0].map(h => h.from)).toEqual(['src/app/a.tsx', 'src/lib/api.ts'])
    expect(q.paths(q.place('src/app/b.tsx'), q.place('src/lib/dates.ts')).paths).toEqual([])
  })
})

describe('one file', () => {
  it('gathers where it sits, what it uses and who uses it, its jobs and its rules', () => {
    const q = query()
    const a = q.file(file(q, 'src/lib/api.ts'))
    expect(a.block).toBe('src/lib')
    expect(a.dependsOn).toEqual([{ path: 'src/server/db.ts', kinds: ['calls', 'imports'] }])
    expect(a.usedBy.map(d => d.path)).toEqual(['src/app/a.tsx', 'src/app/c.tsx'])
    expect(a.jobs).toEqual([{ id: 'js.http', label: 'HTTP calls', stack: 'JS', ways: ['fetch'], use: 'fetch', differs: false }])
    expect(a.rules.layer).toBe('lib')
    expect(q.file(file(q, 'src/app/c.tsx')).jobs[0]).toMatchObject({ ways: ['fetch'], use: 'tRPC client', differs: true })
  })
})

describe('impact', () => {
  const q = query(IMPACT_FILES)
  const impact = (ref: string, depth?: number) => q.impact(q.impactSeed(ref) as ImpactStart, depth)
  const at = (a: ImpactAnswer) => a.hits.map(h => [h.depth, h.path])

  it('walks back from a file to everything depending on it, nearest first, production before tests', () => {
    const a = impact('src/lib/money.ts')
    expect(at(a)).toEqual([
      [1, 'src/lib/parse-user.ts'],
      [1, 'src/lib/report.ts'],
      [1, 'tests/helpers/factories.ts'],
      [1, 'tests/money.test.ts'],
      [2, 'src/app/api/export/route.ts'],
      [2, 'src/components/Chart.tsx'],
      [2, 'src/lib/index.ts'],
      [2, 'tests/chart.test.ts'],
      [2, 'tests/report.test.ts'],
      [3, 'src/app/reports/page.tsx'],
    ])
    expect(a.levels).toEqual([
      { depth: 1, production: 2, tests: 2 },
      { depth: 2, production: 3, tests: 2 },
      { depth: 3, production: 1, tests: 0 },
    ])
    expect(a).toMatchObject({ production: 6, tests: 4, beyond: 0 })
    expect(a.hits.find(h => h.path === 'src/app/reports/page.tsx')).toEqual({ path: 'src/app/reports/page.tsx', depth: 3, via: 'src/components/Chart.tsx', kinds: ['imports', 'renders'] })
  })

  it('gives the line of the first reference, from the sites', () => {
    const a = impact('src/lib/money.ts')
    expect(a.hits.slice(0, 2)).toEqual([
      { path: 'src/lib/parse-user.ts', depth: 1, via: 'src/lib/money.ts', kinds: ['calls', 'imports'], line: 2 },
      { path: 'src/lib/report.ts', depth: 1, via: 'src/lib/money.ts', kinds: ['calls', 'imports'], line: 1 },
    ])
    expect(a.hits.find(h => h.path === 'tests/money.test.ts')).toEqual({ path: 'tests/money.test.ts', depth: 1, via: 'src/lib/money.ts', kinds: ['mocks'], test: true })
  })

  it('lists the tests to run, not the helpers; the features and the entry points it reaches', () => {
    const a = impact('src/lib/money.ts')
    expect(a.testsToRun).toEqual(['tests/money.test.ts', 'tests/chart.test.ts', 'tests/report.test.ts'])
    expect(a.features).toEqual([
      { name: 'reports', files: 2 },
      { name: 'export', files: 1 },
    ])
    expect(a.entryPoints).toEqual([
      { kind: 'page', route: '/reports', path: 'src/app/reports/page.tsx', depth: 3 },
      { kind: 'api', route: '/api/export', path: 'src/app/api/export/route.ts', depth: 2 },
    ])
  })

  it('goes no further than --depth, counting what lies beyond', () => {
    const a = impact('src/lib/money.ts', 1)
    expect(at(a)).toEqual([
      [1, 'src/lib/parse-user.ts'],
      [1, 'src/lib/report.ts'],
      [1, 'tests/helpers/factories.ts'],
      [1, 'tests/money.test.ts'],
    ])
    expect(a).toMatchObject({ depth: 1, beyond: 6, testsToRun: ['tests/money.test.ts'], entryPoints: [] })
  })

  it('passes nothing on through a barrel, a mock or a link to a page past the first step', () => {
    // other/page.tsx imports the barrel re-exporting report.ts, and links to the reports page; export.test.ts mocks report.ts
    const paths = impact('src/lib/money.ts').hits.map(h => h.path)
    expect(paths).not.toContain('src/app/other/page.tsx')
    expect(paths).not.toContain('tests/export.test.ts')
    // on the first step they count: who imports the barrel, mocks the file, links to the page
    expect(impact('src/lib/index.ts').hits.map(h => h.path)).toEqual(['src/app/other/page.tsx'])
    expect(impact('src/lib/report.ts').hits.filter(h => h.depth === 1).map(h => h.path)).toContain('tests/export.test.ts')
    expect(impact('src/app/reports/page.tsx').hits).toEqual([{ path: 'src/app/other/page.tsx', depth: 1, via: 'src/app/reports/page.tsx', kinds: ['navigates'], line: 12 }])
  })

  it('for a folder: its files together, and only what depends on it from outside', () => {
    const a = impact('src/lib')
    expect(at(a)).toEqual([
      [1, 'src/app/api/export/route.ts'],
      [1, 'src/app/other/page.tsx'],
      [1, 'src/components/Chart.tsx'],
      [1, 'tests/export.test.ts'],
      [1, 'tests/helpers/factories.ts'],
      [1, 'tests/money.test.ts'],
      [1, 'tests/report.test.ts'],
      [2, 'src/app/reports/page.tsx'],
      [2, 'tests/chart.test.ts'],
    ])
    expect(a.hits.find(h => h.path === 'src/app/other/page.tsx')!.via).toBe('src/lib/index.ts')
    expect(a.hits.find(h => h.path === 'tests/chart.test.ts')!.via).toBe('src/components/Chart.tsx')
  })

  it('for a function: only the files using it, not every importer of its file', () => {
    const a = impact('src/lib/money.ts#parse')
    expect(a.seed).toEqual({ kind: 'symbol', path: 'src/lib/money.ts', id: 's:src/lib/money.ts#parse', name: 'parse', file: 'f:src/lib/money.ts' })
    // report.ts imports money.ts but uses format only; the test mocking the module counts
    expect(a.hits).toEqual([
      { path: 'src/lib/parse-user.ts', depth: 1, via: 'src/lib/money.ts', kinds: ['calls'], line: 9 },
      { path: 'tests/money.test.ts', depth: 1, via: 'src/lib/money.ts', kinds: ['mocks'], test: true },
    ])
    expect(impact('s:src/lib/money.ts#parse').hits).toEqual(a.hits)
  })

  it('for a function: also the users of its file’s functions that use it', () => {
    // format calls round: report.ts uses format, so changing round reaches it, from line 5
    const a = impact('src/lib/money.ts#round')
    expect(a.hits.filter(h => h.depth === 1)).toEqual([
      { path: 'src/lib/report.ts', depth: 1, via: 'src/lib/money.ts', kinds: ['calls'], line: 5 },
      { path: 'tests/helpers/factories.ts', depth: 1, via: 'src/lib/money.ts', kinds: ['calls'], test: true },
      { path: 'tests/money.test.ts', depth: 1, via: 'src/lib/money.ts', kinds: ['mocks'], test: true },
    ])
    expect(a.hits.map(h => h.path)).not.toContain('src/lib/parse-user.ts')
    expect(a.hits.at(-1)).toMatchObject({ path: 'src/app/reports/page.tsx', depth: 3 })
  })

  it('for a package: the files using it, then theirs', () => {
    const a = impact('@acme/decimal')
    expect(a.hits.filter(h => h.depth === 1)).toEqual([
      { path: 'src/lib/money.ts', depth: 1, via: '@acme/decimal', kinds: ['imports'] },
      { path: 'src/lib/tax.ts', depth: 1, via: '@acme/decimal', kinds: ['imports'] },
    ])
    // what depends on money.ts, but its mock: a step further out, a mock replaces what would carry the change
    expect(a.hits.map(h => h.path)).toEqual(['src/lib/money.ts', 'src/lib/tax.ts', ...impact('src/lib/money.ts').hits.map(h => h.path).filter(p => p !== 'tests/money.test.ts')])
  })

  it('a subscriber depends on the files publishing to its topic', () => {
    const graph = appGraph([
      { path: 'src/orders/publish.ts', links: [{ to: 'x:kafka:orders', kind: 'publishes' }] },
      { path: 'src/billing/listen.ts', links: [{ to: 'x:kafka:orders', kind: 'subscribes', sites: [4, 2] }] },
    ])
    graph.nodes.find(n => n.id === 'x:kafka:orders')!.tags = ['topic']
    const t = new Query({ graph, coherence: coherenceOfApp(graph), blockOf, tagsFor, rules: [] })
    expect(t.impact(t.impactSeed('src/orders/publish.ts') as ImpactStart).hits).toEqual([{ path: 'src/billing/listen.ts', depth: 1, via: 'src/orders/publish.ts', kinds: ['subscribes'], line: 4 }])
  })

  it('a new file has nothing depending on it; a name nothing has is missing', () => {
    expect(q.impactSeed('src/lib/new.ts')).toEqual({ kind: 'new', path: 'src/lib/new.ts' })
    expect(impact('src/lib/new.ts')).toMatchObject({ hits: [], testsToRun: [] })
    expect(q.impactSeed('src/lib/money.ts#nothing')).toEqual({ kind: 'missing', path: 'src/lib/money.ts#nothing' })
    expect(q.impactSeed('@acme/unused')).toEqual({ kind: 'missing', path: '@acme/unused' })
    expect(q.impactSeed('src/nowhere#x')).toEqual({ kind: 'missing', path: 'src/nowhere#x' })
  })
})

describe('risk', () => {
  const fn = (path: string, name: string, lines: [number, number], complexity: number, extra: Partial<GraphNode> = {}): GraphNode => ({
    id: `s:${path}#${name}`, kind: 'symbol', subkind: 'function', name, parent: `f:${path}`, path, range: [lines[0], 1, lines[1], 1], metrics: { complexity }, ...extra,
  })
  // api.ts: load (lines 3–12) took one of its four arms; tiny (14–15) ran
  const API: FileCoverage = {
    statementMap: { 0: { start: { line: 4 } }, 1: { start: { line: 14 } } },
    s: { 0: 1, 1: 1 },
    branchMap: { 0: { locations: [{ start: { line: 5 } }, { start: { line: 7 } }, { start: { line: 9 } }, { start: { line: 11 } }] } },
    b: { 0: [1, 0, 0, 0] },
  }
  const graph = appGraph([...FILES, { path: 'tests/api.test.ts' }])
  graph.nodes.find(n => n.path === 'tests/api.test.ts')!.tags = ['test']
  graph.nodes.push(
    fn('src/lib/api.ts', 'load', [3, 12], 8),
    fn('src/lib/api.ts', 'tiny', [14, 15], 1),
    fn('src/lib/dates.ts', 'Clock', [1, 10], 1, { subkind: 'class' }),
    fn('src/lib/dates.ts', 'tick', [2, 9], 5, { kind: 'member', subkind: 'method', id: 's:src/lib/dates.ts#Clock.tick', parent: 's:src/lib/dates.ts#Clock' }),
    fn('src/lib/index.ts', 'pick', [1, 4], 2),
    fn('tests/api.test.ts', 'helper', [1, 30], 12),
  )
  const of = (p: string) => (p === 'src/lib/api.ts' ? API : p === 'src/lib/dates.ts' ? ('stale' as const) : undefined)
  const q = new Query({ graph, coherence: coherenceOfApp(graph), blockOf, tagsFor, rules: RULES, coverage: { file: 'coverage/coverage-final.json', at: '2026-11-01T08:31:00.000Z', of } })

  it('ranks a folder’s functions by CRAP from the coverage run, by complexity where a file changed since or was left out', () => {
    const a = q.risks(q.place('src/lib'))
    // load: 64 × 0.75³ + 8 = 35
    expect(a.functions.map(f => [f.name, f.crap ?? null, f.stale ?? f.unmeasured ?? null])).toEqual([
      ['load', 35, null],
      ['Clock.tick', null, true],
      ['pick', null, true],
      ['tiny', 1, null],
    ])
    expect(a.functions[2].unmeasured).toBe(true)
    expect(a.stale).toEqual(['src/lib/dates.ts'])
    expect(a.coverage).toEqual({ file: 'coverage/coverage-final.json', at: '2026-11-01T08:31:00.000Z' })
  })

  it('leaves tests out of a folder, and lists a file’s own functions in the file answer', () => {
    expect(q.risks(q.place('')).functions.map(f => f.name)).not.toContain('helper')
    expect(q.file(file(q, 'src/lib/api.ts')).functions.map(f => f.name)).toEqual(['load', 'tiny'])
  })

  it('ranks by complexity alone without a coverage run', () => {
    const plain = new Query({ graph, coherence: coherenceOfApp(graph), blockOf, tagsFor, rules: RULES })
    const a = plain.risks(plain.place('src/lib'))
    expect(a.functions.map(f => [f.name, f.complexity])).toEqual([['load', 8], ['Clock.tick', 5], ['pick', 2], ['tiny', 1]])
    expect(a.coverage).toBeUndefined()
  })
})
