// `archrift query impact` as an agent reads it: who depends on a file, step by
// step, the entry points and features it reaches, and the tests to run.
import { describe, expect, it } from 'vitest'
import { answer } from '../../src/cli/query.ts'
import type { QueryArgs } from '../../src/cli/query.ts'
import { Query } from '../../src/core/query.ts'
import { IMPACT_FILES, RULES, appGraph, blockOf, coherenceOfApp, tagsFor } from '../helpers/query-graph.ts'

const graph = appGraph(IMPACT_FILES)
const q = new Query({ graph, coherence: coherenceOfApp(graph), blockOf, tagsFor, rules: RULES })
const ask = (paths: string[], more: Partial<QueryArgs> = {}) => answer(q, { question: 'impact', paths, format: 'text', ...more })

describe('query impact, as text', () => {
  it('says how many files depend on it, lists the first two steps, counts the rest, and names the tests to run', () => {
    const r = ask(['src/lib/money.ts'], { max: 2 })
    expect(r.code).toBe(0)
    expect(r.text.split('\n')).toEqual([
      'src/lib/money.ts: 10 files depend on it (4 directly), in 2 features, 2 entry points',
      '  6 production files, 4 test files (3 to run); by steps 1: 4 · 2: 5 · 3: 1',
      '',
      'Directly (4):',
      '  src/lib/parse-user.ts:2  (calls, imports)',
      '  src/lib/report.ts:1  (calls, imports)',
      '  … 2 more (--max)',
      '',
      'Through them (2 steps, 5):',
      '  src/app/api/export/route.ts  via src/lib/report.ts  (calls, imports)',
      '  src/components/Chart.tsx  via src/lib/report.ts  (calls, imports)',
      '  … 3 more (--max)',
      '',
      'Further: 3 steps: 1 file (--depth 3 lists them, --format json has every file)',
      '',
      'Features: reports 2 · export 1',
      '',
      'Entry points reached (2):',
      '  page /reports  src/app/reports/page.tsx',
      '  api /api/export  src/app/api/export/route.ts',
      '',
      'Tests that reach it (run these, 3):',
      '  tests/money.test.ts',
      '  tests/chart.test.ts',
      '  … 1 more (--max)',
      '  (1 more test file reaches it: helpers, fixtures or setup, which run nothing)',
      '',
    ])
  })

  it('lists as many steps as --depth walks, and says how many files lie further', () => {
    const one = ask(['src/lib/money.ts'], { depth: 1 }).text
    expect(one.split('\n').slice(0, 2)).toEqual(['src/lib/money.ts: 4 files depend on it (4 directly)', '  2 production files, 2 test files (1 to run); by steps 1: 4; walked 1 step, 6 files further (--depth)'])
    expect(one).not.toContain('Through them')
    expect(ask(['src/lib/money.ts'], { depth: 3 }).text).toContain('\n3 steps (1):\n  src/app/reports/page.tsx  via src/components/Chart.tsx  (imports, renders)\n')
  })

  it('names a function by its file, shows a folder’s files the dependents use, and answers for a new file', () => {
    expect(ask(['src/lib/money.ts#parse']).text).toMatch(/^src\/lib\/money\.ts › parse: 2 files depend on it \(2 directly\)\n/)
    expect(ask(['src/lib']).text).toContain('src/app/other/page.tsx  via src/lib/index.ts  (imports)')
    expect(ask(['src/lib/new.ts'])).toEqual({ text: 'src/lib/new.ts: no file there yet, so nothing depends on it yet\n', code: 0 })
    expect(ask(['tests/chart.test.ts'])).toEqual({ text: 'tests/chart.test.ts: nothing depends on it\n', code: 0 })
  })

  it('exits 4 for a name nothing has, 2 without a path; as JSON, the whole answer', () => {
    expect(ask(['src/lib/money.ts#nothing'])).toEqual({ text: 'src/lib/money.ts#nothing: no file, folder, function, class or package by that name\n', code: 4 })
    expect(ask([]).code).toBe(2)
    const json = JSON.parse(ask(['src/lib/money.ts'], { format: 'json', max: 1 }).text)
    expect(json.hits).toHaveLength(10)
    expect(json).toMatchObject({ seed: { kind: 'file', path: 'src/lib/money.ts' }, production: 6, tests: 4, testsToRun: ['tests/money.test.ts', 'tests/chart.test.ts', 'tests/report.test.ts'] })
  })
})
