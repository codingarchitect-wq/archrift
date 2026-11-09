import { describe, expect, it } from 'vitest'
import type { Graph, GraphEdge, GraphNode } from '../../src/core/model.ts'
import { applyPatch, diffGraphs, patchShare } from '../../src/core/patch.ts'

const file = (path: string, loc: number): GraphNode => ({ id: `f:${path}`, kind: 'file', name: path, path, parent: 'd:.', metrics: { loc } })
const edge = (a: string, b: string, count = 1, kind: GraphEdge['kind'] = 'imports'): GraphEdge => ({
  source: `f:${a}`,
  target: `f:${b}`,
  kind,
  count,
  targets: ['default'],
  confidence: 'exact',
})
const graph = (nodes: GraphNode[], edges: GraphEdge[]): Graph => ({
  meta: { name: 'g', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } },
  nodes,
  edges,
  sites: [],
})
const dir: GraphNode = { id: 'd:.', kind: 'directory', name: 'root' }
const sorted = (g: Graph) => ({ nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: g.edges.map(e => JSON.stringify(e)).sort() })

describe('graph patches', () => {
  const before = graph([dir, file('a.ts', 10), file('b.ts', 20), file('c.ts', 5)], [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts', 2), edge('a.ts', 'c.ts', 3, 'co-changes')])
  const after = graph([dir, file('a.ts', 12), file('b.ts', 20), file('d.ts', 7)], [edge('a.ts', 'b.ts'), edge('b.ts', 'd.ts'), edge('a.ts', 'd.ts', 3, 'co-changes')])

  it('says what was added, changed and removed, and which files that touches', () => {
    const p = diffGraphs(before, after, 1, 2)
    expect(p.nodes.map(n => n.id)).toEqual(['f:a.ts', 'f:d.ts'])
    expect(p.removedNodes).toEqual(['f:c.ts'])
    expect(p.edges.map(e => `${e.source}>${e.target}`)).toEqual(['f:b.ts>f:d.ts', 'f:a.ts>f:d.ts'])
    expect(p.removedEdges).toHaveLength(2)
    // b.ts's imports changed; co-change alone doesn't make a file changed
    expect(p.files).toEqual(['f:a.ts', 'f:b.ts', 'f:c.ts', 'f:d.ts'])
    expect(p).toMatchObject({ from: 1, to: 2 })
  })

  it('turns the old graph into the new one', () => {
    expect(sorted(applyPatch(before, diffGraphs(before, after, 1, 2)))).toEqual(sorted(after))
    expect(sorted(applyPatch(after, diffGraphs(after, before, 2, 3)))).toEqual(sorted(before))
  })

  it('is empty when nothing changed, and measures how much a patch rewrites', () => {
    const same = diffGraphs(before, before, 1, 2)
    expect([same.nodes, same.removedNodes, same.edges, same.removedEdges]).toEqual([[], [], [], []])
    expect(patchShare(after, diffGraphs(before, after, 1, 2))).toBeCloseTo(7 / 7)
    expect(patchShare(before, same)).toBe(0)
  })

  it('treats a changed count as a new edge', () => {
    const more = graph(before.nodes, [edge('a.ts', 'b.ts', 5), ...before.edges.slice(1)])
    const p = diffGraphs(before, more, 1, 2)
    expect(p.edges).toEqual([edge('a.ts', 'b.ts', 5)])
    expect(p.removedEdges).toHaveLength(1)
  })
})
