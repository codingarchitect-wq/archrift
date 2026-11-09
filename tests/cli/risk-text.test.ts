import { describe, expect, it } from 'vitest'
import { diffMarkdown, diffText } from '../../src/cli/diff.ts'
import { risksText } from '../../src/cli/query.ts'
import type { ArchitectureDiff } from '../../src/core/diff.ts'
import type { ReachChange } from '../../src/core/reach.ts'
import type { Violation } from '../../src/core/rules.ts'

const over = (value: number, symbol = 's:src/components/ImportDialog.tsx#ImportDialog'): Violation => ({
  rule: 'functions-small-ui',
  severity: 'warn',
  message: `src/components/ImportDialog.tsx › ImportDialog: complexity ${value}, more than 19`,
  from: 'f:src/components/ImportDialog.tsx',
  to: 'f:src/components/ImportDialog.tsx',
  targets: [],
  measure: { metric: 'complexity', value, bound: 'max', limit: 19, symbol },
})

const nothing: ArchitectureDiff = { files: { added: [], removed: [] }, rules: { added: [], grew: [], fixed: [], unmatched: [] }, cycles: { added: [], fixed: [] }, jobs: [], blocks: { added: [], removed: [] }, reach: { added: [], removed: [] }, docs: [] }
const meta = { project: 'app', base: 'HEAD (abc12345)', head: 'the working tree', touched: 1 }

describe('the diff, as text', () => {
  it('shows a limit broken further with the measure before and after', () => {
    const text = diffText({ ...nothing, rules: { ...nothing.rules, grew: [{ before: over(83), after: over(85) }] } }, meta)
    expect(text).toContain('Rules: 1 limit broken further')
    expect(text).toContain('↑ functions-small-ui (warn): src/components/ImportDialog.tsx › ImportDialog: complexity 83 → 85, more than 19 (grew)')
  })

  it('counts new violations and grown ones apart', () => {
    const text = diffText({ ...nothing, rules: { ...nothing.rules, added: [over(24, 's:src/components/plans/EventDialog.tsx#EventDialog')], grew: [{ before: over(83), after: over(85) }] } }, meta)
    expect(text).toContain('Rules: 1 new violation, 1 limit broken further')
  })
})

describe('what imports bring into the entry points, as text', () => {
  const pages = (n: number) => Array.from({ length: n }, (_, i) => `src/app/p${i}/page.tsx`)
  const heavy: ReachChange = {
    from: 'src/lib/format.ts',
    to: 'src/components/charts/Sankey.tsx',
    files: ['src/components/charts/Sankey.tsx', 'src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts', 'src/lib/d.ts', 'src/lib/e.ts'],
    packages: ['d3-sankey'],
    entries: pages(24),
    targets: ['desktop', 'web'],
  }
  const pkg: ReachChange = { from: 'src/lib/dates.ts', to: 'dayjs', files: [], packages: ['dayjs'], entries: pages(1), targets: ['default'] }
  const gone: ReachChange = { from: 'src/app/p0/page.tsx', to: 'src/lib/old.ts', files: ['src/lib/old.ts', 'src/lib/x.ts', 'src/lib/y.ts', 'src/lib/z.ts', 'src/lib/w.ts'], packages: [], entries: pages(1), targets: ['web'] }

  it('names each import, what it brings and into which entry points, the most first; and the gone ones', () => {
    const text = diffText({ ...nothing, reach: { added: [heavy, pkg], removed: [gone] } }, meta)
    expect(text.split('\n').slice(2)).toEqual([
      "Reach: 2 imports bring 6 files and 2 packages into entry points that didn't load them; 1 import gone, taking 5 files out",
      '  src/lib/format.ts → src/components/charts/Sankey.tsx brings 6 files and package d3-sankey into 24 entry points (desktop, web)',
      '    files: src/components/charts/Sankey.tsx, src/lib/a.ts, src/lib/b.ts and 3 more',
      '    entry points: src/app/p0/page.tsx, src/app/p1/page.tsx and 22 more',
      '  src/lib/dates.ts → dayjs brings package dayjs into 1 entry point',
      '    entry points: src/app/p0/page.tsx',
      '  gone: src/app/p0/page.tsx → src/lib/old.ts, so 1 entry point (web) no longer loads 5 files',
      '',
    ])
  })

  it('as markdown, nests the details under each import', () => {
    const md = diffMarkdown({ ...nothing, reach: { added: [heavy], removed: [] } }, meta)
    expect(md).toContain("**Reach: 1 import brings 6 files and 1 package into entry points that didn't load them**")
    expect(md).toContain('- `src/lib/format.ts` → `src/components/charts/Sankey.tsx` brings 6 files and package `d3-sankey` into 24 entry points (desktop, web)\n  - files: `src/components/charts/Sankey.tsx`, `src/lib/a.ts`, `src/lib/b.ts` and 3 more')
  })
})

describe('the riskiest functions, as text', () => {
  it('lists CRAP, complexity and coverage, says where the coverage comes from and what changed since', () => {
    const text = risksText(
      {
        place: { kind: 'folder', path: 'src/lib', files: [] },
        coverage: { file: 'coverage/coverage-final.json', at: '2026-11-01T08:31:12.000Z' },
        functions: [
          { name: 'rowProblem', path: 'src/lib/schemas/import-rows.ts', line: 58, complexity: 22, coverage: 0.57, crap: 60.1 },
          { name: 'computePrices', path: 'src/lib/pricing-engine.ts', line: 433, complexity: 189, stale: true },
          { name: 'validateProductionEnv', path: 'src/lib/env.ts', line: 26, complexity: 13, unmeasured: true },
          { name: 'tiny', path: 'src/lib/a.ts', line: 1, complexity: 1, coverage: 1, crap: 1 },
        ],
        stale: ['src/lib/pricing-engine.ts'],
      },
      3,
    )
    expect(text.split('\n')).toEqual([
      'src/lib/: 4 functions, riskiest first',
      '  CRAP = complexity² × (1 − coverage)³ + complexity, coverage from coverage/coverage-final.json (2026-11-01 08:31 UTC): 1 of 2 at CRAP 10 or more',
      '  1 file changed since that run: complexity only (src/lib/pricing-engine.ts)',
      '',
      '  rowProblem  src/lib/schemas/import-rows.ts:58  CRAP 60.1 · complexity 22 · coverage 57 %',
      '  computePrices  src/lib/pricing-engine.ts:433  complexity 189 · changed since the coverage run',
      '  validateProductionEnv  src/lib/env.ts:26  complexity 13 · not in the coverage run',
      '  … 1 more (--max)',
      '',
    ])
  })

  it('without a coverage run, says how to get one', () => {
    const text = risksText({ place: { kind: 'file', path: 'src/lib/a.ts', id: 'f:src/lib/a.ts' }, functions: [{ name: 'f', path: 'src/lib/a.ts', line: 3, complexity: 4 }], stale: [] }, 20)
    expect(text).toContain('no coverage run found (npm run test:coverage writes one): by complexity only')
    expect(text).toContain('  f (line 3)  complexity 4')
  })
})
