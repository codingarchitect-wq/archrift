// Risks view: a file's short name on the matrix and in the register: without
// its extension, and with its folder when the name alone says little
// (`hooks/index`, `accounts/page`).
import type { GraphNode } from '../../../core/model.ts'

const stem = (name: string) => name.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, '')

export function fileLabel(n: Pick<GraphNode, 'name' | 'path'>): string {
  const s = stem(n.name)
  if (!/^(index|page|route|layout|main|mod|types|utils|schema)$/.test(s)) return s
  const folder = n.path?.split('/').slice(-2, -1)[0]
  return folder ? `${folder}/${s}` : s
}
