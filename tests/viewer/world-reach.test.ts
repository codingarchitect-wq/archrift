import { describe, expect, it } from 'vitest'
import { reachEdges } from '../../src/viewer/world.ts'
import type { DepGraph } from '../../src/viewer/world.ts'

/** A file graph from `a>b` pairs (a uses b). */
function graph(...pairs: string[]): DepGraph {
  const out = new Map<string, string[]>()
  const inc = new Map<string, string[]>()
  for (const p of pairs) {
    const [a, b] = p.split('>')
    out.set(a, [...(out.get(a) ?? []), b])
    inc.set(b, [...(inc.get(b) ?? []), a])
  }
  return { key: 'test', out, in: inc, weight: new Map() }
}
const text = (edges: { source: string; target: string; depth: number }[]) => edges.map(e => `${e.source}>${e.target}@${e.depth}`).sort()

describe("a selection's focus", () => {
  // the English and German guide texts both use the content types and are both read by the registry
  const g = graph('en>types', 'de>types', 'registry>en', 'registry>de', 'types>zod', 'page>registry')

  it('draws every dependency of the selected files, a neighbor they share once for each of them', () => {
    const r = reachEdges(g, ['en', 'de'], 'both', 1)
    expect(text(r.edges)).toEqual(['de>types@1', 'en>types@1', 'registry>de@1', 'registry>en@1'])
    expect([...r.reached].sort()).toEqual(['registry', 'types'])
    expect(r.first).toEqual(['types', 'registry'])
  })

  it('goes on one way to each file further out, in the direction asked', () => {
    expect(text(reachEdges(g, ['en', 'de'], 'out', 2).edges)).toEqual(['de>types@1', 'en>types@1', 'types>zod@2'])
    expect(text(reachEdges(g, ['en', 'de'], 'in', 0).edges)).toEqual(['page>registry@2', 'registry>de@1', 'registry>en@1'])
  })

  it('leaves out the dependencies among the selected files themselves', () => {
    expect(text(reachEdges(g, ['registry', 'en'], 'out', 1).edges)).toEqual(['en>types@1', 'registry>de@1'])
  })
})
