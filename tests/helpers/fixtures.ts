import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyze } from '../../src/analyzer/analyze.ts'
import type { Graph, GraphEdge } from '../../src/core/model.ts'

export const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures')

/** Fixtures live in this repo, so their git history changes with every commit: it's left out. */
export function analyzeFixture(name: string, options: { root?: string; cacheDir?: string | false } = {}) {
  return analyze({ root: options.root ?? path.join(FIXTURES, name), cacheDir: options.cacheDir ?? false, history: false })
}

/** A throwaway copy of a fixture, for tests that edit files. */
export function copyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `archrift-${name}-`))
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true })
  return dir
}

export function edge(graph: Graph, source: string, kind: GraphEdge['kind'], target: string): GraphEdge | undefined {
  return graph.edges.find(e => e.source === source && e.kind === kind && e.target === target)
}

export function node(graph: Graph, id: string) {
  const n = graph.nodes.find(x => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}
