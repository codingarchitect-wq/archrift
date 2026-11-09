// The toolbar's groups (detected modules, layers, configured groups,
// features) as ids: what a group's id looks like, and a group's short name.

/** Prefixes of group ids: a detected module, a layer or configured group, a feature (or its shared code). */
const GROUP_PREFIXES = ['module:', 'layer:', 'feature:']

/** A group's id rather than a node's (a group is selected, labelled and inspected as a whole). */
export const isGroupId = (id: string) => GROUP_PREFIXES.some(p => id.startsWith(p))

/** A feature group's id; shared code is `feature:shared:<area>`, files without a feature `feature:(none)`. */
export const featureGroupId = (name: string) => `feature:${name}`
export const SHARED_GROUP = 'feature:shared:'
export const NO_FEATURE_GROUP = 'feature:(none)'

/** What kind of group an id is, for the inspector's badge. */
export function groupKind(id: string): string {
  if (id.startsWith('module:')) return 'detected module'
  if (id.startsWith(SHARED_GROUP)) return 'shared code'
  if (id.startsWith('feature:')) return 'feature'
  return 'layer'
}

/** A group's short name: a layer's or configured group's own, a detected module's number and the folder most of it is in, a feature's label. */
export function groupName(g: { id: string; label: string }): string {
  if (g.id.startsWith('module:')) {
    const dir = g.label.split(' · ')[0].split('/').pop() || g.label
    return `module ${Number(g.id.slice(7)) + 1} · ${dir}`
  }
  if (g.id.startsWith('feature:')) return g.label
  return g.id.startsWith('layer:') ? g.id.slice(6) : g.label
}
