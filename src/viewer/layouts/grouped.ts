// City grouped by something other than folders: detected modules
// or layers become the districts, each holding a district per folder its
// files come from, then the files. Comparing it with the plain city shows
// where folders and dependencies disagree. A folder whose files fall into
// several groups keeps its own id in the group holding most of them and is
// `dir\0group` in the others.
import type { GraphNode } from '../../core/model.ts'
import { SCALE, childrenOf, placeExternals, placeTree, weighTree } from './city.ts'
import type { CityInput } from './city.ts'
import type { Layout } from './types.ts'
import { emptyLayout } from './types.ts'

const SPLIT = '\u0000'

export interface GroupedInput extends CityInput {
  /** Group ids (they become district ids and selectable) with labels, in order. */
  groups: { id: string; label: string }[]
  groupOf: (file: GraphNode) => string | undefined
}

export function groupedLayout(input: GroupedInput): Layout {
  const byId = new Map(input.nodes.map(n => [n.id, n]))
  const files = input.nodes.filter(n => n.kind === 'file' && input.isVisible(n))
  const groupOf = (f: GraphNode) => input.groupOf(f) ?? ''

  // which group holds most of each folder's files
  const counts = new Map<string, Map<string, number>>()
  for (const f of files) {
    const c = counts.get(f.parent!) ?? new Map<string, number>()
    c.set(groupOf(f), (c.get(groupOf(f)) ?? 0) + 1)
    counts.set(f.parent!, c)
  }
  const order = new Map(input.groups.map((g, i) => [g.id, i]))
  const primary = new Map([...counts].map(([dir, c]) => [dir, [...c].sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))[0][0]]))

  // a synthetic tree: root → groups → folders → files
  const names = new Map<string, string>()
  const nodes: GraphNode[] = [{ ...byId.get(input.rootId)!, parent: undefined }]
  for (const g of input.groups) {
    nodes.push({ id: g.id, kind: 'directory', name: g.label, parent: input.rootId })
    names.set(g.id, g.label)
  }
  const fragments = new Set<string>()
  for (const f of files) {
    const g = groupOf(f)
    // the root keeps its id for the root: files directly in it get a folder per group
    const frag = primary.get(f.parent!) === g && f.parent !== input.rootId ? f.parent! : `${f.parent}${SPLIT}${g}`
    if (!fragments.has(frag)) {
      fragments.add(frag)
      const dir = byId.get(f.parent!)
      nodes.push({ id: frag, kind: 'directory', name: dir?.path || dir?.name || f.parent!, parent: g })
      names.set(frag, shortPath(dir?.path || dir?.name || ''))
    }
    nodes.push({ ...f, parent: frag })
  }
  for (const n of input.nodes) if (n.kind === 'external') nodes.push(n)

  const children = childrenOf(nodes)
  const root = nodes[0]
  const weight = weighTree(children, root, n => n.kind !== 'file' || input.isVisible(n))
  const total = weight.get(root.id) ?? 0
  const size = Math.max(60, Math.sqrt(total) * SCALE)
  const out: Layout = { ...emptyLayout(), view: 'city', size, center: [0, 0, size * 0.08], names }
  if (total > 0) placeTree({ children, weight, out }, root, { x: -size / 2, z: -size / 2, w: size, d: size }, 0, 0)
  placeExternals(input, out, size / 2)
  return out
}

/** The last two segments of a path: enough to tell folders apart on a label. */
function shortPath(p: string) {
  const parts = p.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}
