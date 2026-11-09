// CRAP per function (change risk anti-patterns): CC² × (1 − coverage)³ + CC, the score Uncle
// Bob's crapper reports. It is never below the complexity, so a limit on complexity is the floor
// that no coverage lowers; the score adds what the tests leave untaken. Coverage is the share of
// branch arms the tests took inside the function (nested callbacks included, as its complexity
// counts them), else of its statements, from an Istanbul coverage-final.json (Vitest's v8
// provider writes one). Pure: the CLI reads the file and says which files changed since the run.

/** One file's entry in coverage-final.json: the parts read here. */
export interface FileCoverage {
  statementMap: Record<string, { start: { line: number } }>
  s: Record<string, number>
  branchMap: Record<string, { loc?: { start: { line: number } }; locations: ({ start?: { line?: number } } | null | undefined)[] }>
  b: Record<string, number[]>
}

/** A file's coverage, `stale` when the file changed after the coverage run (its lines may have moved), or nothing. */
export type CoverageOf = (path: string) => FileCoverage | 'stale' | undefined

/** Where the coverage comes from: the file, relative to the root, and when it was written. */
export interface CoverageSource {
  file: string
  at: string
  of: CoverageOf
}

export function crapScore(complexity: number, coverage: number): number {
  return complexity * complexity * (1 - coverage) ** 3 + complexity
}

/**
 * The share of branch arms the tests took between two lines (with `branches`), else of the
 * statements there; undefined when the run measured nothing there.
 */
export function coverageBetween(file: FileCoverage, from: number, to: number, branches = true): number | undefined {
  if (branches) {
    let arms = 0
    let taken = 0
    for (const [id, branch] of Object.entries(file.branchMap)) {
      branch.locations.forEach((loc, i) => {
        const line = loc?.start?.line ?? branch.loc?.start.line
        if (line === undefined || line < from || line > to) return
        arms++
        if ((file.b[id]?.[i] ?? 0) > 0) taken++
      })
    }
    if (arms) return taken / arms
  }
  let statements = 0
  let hit = 0
  for (const [id, loc] of Object.entries(file.statementMap)) {
    if (loc.start.line < from || loc.start.line > to) continue
    statements++
    if ((file.s[id] ?? 0) > 0) hit++
  }
  return statements ? hit / statements : undefined
}

export interface FunctionRisk {
  name: string
  path: string
  line: number
  complexity: number
  /** 0–1; absent when there is no coverage for the file, or it changed after the run. */
  coverage?: number
  crap?: number
  /** The file changed after the coverage run: complexity only. */
  stale?: true
  /** The coverage run left the file out (its config excludes it): complexity only. */
  unmeasured?: true
}

/**
 * A function's risk from its lines and complexity; a straight-line function (complexity 1) is
 * measured by its statements. A file the coverage run doesn't name was left out of it (Vitest
 * reports every file it includes, loaded or not), so it has no score, where crapper would say 0 %.
 */
export function functionRisk(fn: { name: string; path: string; range: [number, number]; complexity: number }, coverageOf: CoverageOf | undefined): FunctionRisk {
  const base: FunctionRisk = { name: fn.name, path: fn.path, line: fn.range[0], complexity: fn.complexity }
  if (!coverageOf) return base
  const file = coverageOf(fn.path)
  if (file === 'stale') return { ...base, stale: true }
  if (!file) return { ...base, unmeasured: true }
  const coverage = coverageBetween(file, fn.range[0], fn.range[1], fn.complexity > 1) ?? 0
  return { ...base, coverage, crap: Math.round(crapScore(fn.complexity, coverage) * 10) / 10 }
}

/** Riskiest first: by CRAP when known, then complexity, then where. */
export function byRisk(a: FunctionRisk, b: FunctionRisk): number {
  return (b.crap ?? b.complexity) - (a.crap ?? a.complexity) || b.complexity - a.complexity || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)
}
