// Test reach: for every file, how many test files reach it
// through runtime imports (directly or not), and how many import or mock it
// directly. The viewer lists which tests those are.
import { isRuntimeImport } from '../../core/model.ts'
import type { Plugin } from './types.ts'

export const tests: Plugin = {
  name: 'tests',
  version: 1,

  assemble(api) {
    const isTest = (id: string) => api.nodes.get(id)?.tags?.includes('test') ?? false
    const out = new Map<string, string[]>()
    const direct = new Map<string, Set<string>>()
    for (const e of api.edges()) {
      if (!e.source.startsWith('f:') || !e.target.startsWith('f:')) continue
      if (isRuntimeImport(e)) {
        const list = out.get(e.source)
        if (list) list.push(e.target)
        else out.set(e.source, [e.target])
      }
      if (isTest(e.source) && (isRuntimeImport(e) || e.kind === 'mocks')) direct.set(e.target, (direct.get(e.target) ?? new Set()).add(e.source))
    }
    const reach = new Map<string, number>()
    for (const t of api.nodes.values()) {
      if (t.kind !== 'file' || !t.tags?.includes('test')) continue
      const seen = new Set([t.id])
      const queue = [t.id]
      while (queue.length) for (const next of out.get(queue.pop()!) ?? []) if (!seen.has(next)) seen.add(next), queue.push(next)
      for (const id of seen) if (id !== t.id && !isTest(id)) reach.set(id, (reach.get(id) ?? 0) + 1)
    }
    for (const n of api.nodes.values()) {
      if (n.kind !== 'file' || n.tags?.includes('test') || n.tags?.includes('asset')) continue
      n.metrics = { ...n.metrics, testReach: reach.get(n.id) ?? 0, testedDirectly: direct.get(n.id)?.size ?? 0 }
    }
  },
}
