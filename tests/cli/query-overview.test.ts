// `archrift query overview` and `query find`: where an agent (the Ask bar's)
// starts, with what was written about the code (archrift describe).
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/analyzer/config.ts'
import { answer, queryFor } from '../../src/cli/query.ts'
import { resolveDescriptions } from '../../src/core/descriptions.ts'
import type { Graph } from '../../src/core/model.ts'
import { FIXTURES, analyzeFixture } from '../helpers/fixtures.ts'

const root = path.join(FIXTURES, 'plain-ts')
let graph: Graph
beforeAll(async () => {
  graph = await analyzeFixture('plain-ts')
})

const ask = (question: 'overview' | 'find', paths: string[] = [], format: 'text' | 'json' = 'text') => {
  const descriptions = resolveDescriptions(graph, { project: 'Draws shapes.', entries: { 'd:src': { summary: 'All the code.' }, 'f:src/util.ts': { name: 'Helpers', summary: 'Small sums the shapes need.' } } })
  return answer(queryFor(graph, loadConfig(root), undefined, descriptions), { question, paths, format })
}

describe('query overview', () => {
  it('gives the project at a glance with what was written about it', () => {
    const r = ask('overview')
    expect(r.code).toBe(0)
    expect(r.text).toMatch(/^plain-ts: Draws shapes\.\n/)
    expect(r.text).toContain('Blocks (the folders its production code splits into):')
    expect(r.text).toMatch(/ {2}src {2}\d+ files, \d+ lines {2}“All the code\.”/)
    const json = JSON.parse(ask('overview', [], 'json').text)
    expect(json).toMatchObject({ project: 'plain-ts', described: 'Draws shapes.', blocks: [{ path: 'src', described: 'All the code.' }] })
  })
})

describe('query find', () => {
  it('finds by name and by the words written about it, things matching more words first', () => {
    const byName = ask('find', ['makeCircle'])
    expect(byName.text.split('\n')[0]).toBe('src/shapes.ts › makeCircle  (function)')
    const byWords = ask('find', ['shapes', 'sums'])
    expect(byWords.text.split('\n')[0]).toBe('src/util.ts  (file)  “Helpers: Small sums the shapes need.”')
    expect(ask('find', ['zzzz'])).toEqual({ text: 'nothing matches "zzzz" by name, path, route or description\n', code: 4 })
    expect(ask('find', []).code).toBe(2)
  })
})
