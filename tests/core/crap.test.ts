import { describe, expect, it } from 'vitest'
import { byRisk, coverageBetween, crapScore, functionRisk } from '../../src/core/crap.ts'
import type { FileCoverage } from '../../src/core/crap.ts'

// lines 1–10: an if on line 3 (then taken, else not) and a ?: on line 6 (both taken); statements
// on lines 2, 3, 4 (run) and 8, 9 (never run). Line 20 runs, with no branch; line 22 has an untaken arm.
const FILE: FileCoverage = {
  statementMap: { 0: { start: { line: 2 } }, 1: { start: { line: 3 } }, 2: { start: { line: 4 } }, 3: { start: { line: 8 } }, 4: { start: { line: 9 } }, 5: { start: { line: 20 } } },
  s: { 0: 3, 1: 3, 2: 3, 3: 0, 4: 0, 5: 1 },
  branchMap: {
    0: { loc: { start: { line: 3 } }, locations: [{ start: { line: 3 } }, { start: { line: 5 } }] },
    1: { loc: { start: { line: 6 } }, locations: [{ start: { line: 6 } }, {}] },
    2: { loc: { start: { line: 22 } }, locations: [{ start: { line: 22 } }] },
  },
  b: { 0: [3, 0], 1: [2, 1], 2: [0] },
}

describe('CRAP', () => {
  it('is complexity² × (1 − coverage)³ + complexity, so never below the complexity', () => {
    expect(crapScore(10, 1)).toBe(10)
    expect(crapScore(10, 0)).toBe(110)
    expect(crapScore(4, 0.5)).toBe(6)
  })

  it('measures the branch arms taken between two lines (an arm without a place is its branch’s), else the statements run', () => {
    expect(coverageBetween(FILE, 1, 10)).toBe(3 / 4)
    expect(coverageBetween(FILE, 1, 10, false)).toBe(3 / 5)
    expect(coverageBetween(FILE, 19, 21)).toBe(1)
    expect(coverageBetween(FILE, 21, 23)).toBe(0)
    expect(coverageBetween(FILE, 30, 40)).toBeUndefined()
  })

  it('scores a function from its lines; complexity only when its file changed after the run or the run left it out', () => {
    const of = (p: string) => (p === 'a.ts' ? FILE : p === 'b.ts' ? ('stale' as const) : undefined)
    // 16 × (1 − 0.75)³ + 4 = 4.25
    expect(functionRisk({ name: 'f', path: 'a.ts', range: [1, 10], complexity: 4 }, of)).toEqual({ name: 'f', path: 'a.ts', line: 1, complexity: 4, coverage: 0.75, crap: 4.3 })
    // straight-line code: by its statements, 1 × 0.4³ + 1
    expect(functionRisk({ name: 'g', path: 'a.ts', range: [1, 10], complexity: 1 }, of)).toMatchObject({ coverage: 0.6, crap: 1.1 })
    // nothing measured in its lines: 0 %
    expect(functionRisk({ name: 'h', path: 'a.ts', range: [30, 40], complexity: 3 }, of)).toMatchObject({ coverage: 0, crap: 12 })
    expect(functionRisk({ name: 'f', path: 'b.ts', range: [1, 10], complexity: 4 }, of)).toEqual({ name: 'f', path: 'b.ts', line: 1, complexity: 4, stale: true })
    expect(functionRisk({ name: 'f', path: 'c.ts', range: [1, 10], complexity: 4 }, of)).toEqual({ name: 'f', path: 'c.ts', line: 1, complexity: 4, unmeasured: true })
    expect(functionRisk({ name: 'f', path: 'a.ts', range: [1, 10], complexity: 4 }, undefined)).toEqual({ name: 'f', path: 'a.ts', line: 1, complexity: 4 })
  })

  it('ranks by CRAP where known (complexity where not), then complexity, then place', () => {
    const risks = [
      { name: 'small', path: 'a.ts', line: 1, complexity: 3, crap: 3 },
      { name: 'stale', path: 'b.ts', line: 1, complexity: 20, stale: true as const },
      { name: 'untested', path: 'a.ts', line: 9, complexity: 6, crap: 42 },
      { name: 'same-score', path: 'a.ts', line: 5, complexity: 3, crap: 3 },
    ]
    expect([...risks].sort(byRisk).map(r => r.name)).toEqual(['untested', 'stale', 'small', 'same-score'])
  })
})
