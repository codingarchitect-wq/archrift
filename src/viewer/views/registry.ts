// View plug-ins: every src/viewer/views/<id>/index.ts(x) whose default export
// is a ViewPlugin. Adding a view touches no other file.
import type { ViewPlugin } from './types.ts'

const modules = import.meta.glob<{ default: ViewPlugin }>('./*/index.{ts,tsx}', { eager: true })

export const VIEW_PLUGINS: readonly ViewPlugin[] = Object.values(modules)
  .map(m => m.default)
  .filter(p => p && typeof p.layout === 'function')
  .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))

export const pluginFor = (id: string): ViewPlugin | undefined => VIEW_PLUGINS.find(p => p.id === id)

/** Built-in views, then plug-ins: [id, label, description]. */
export const ALL_VIEWS: readonly [string, string, string][] = [
  ['city', 'City', 'Folders as districts, files as buildings'],
  ['layers', 'Layers', 'One plane per architecture layer; red arcs point up'],
  ['galaxy', 'Galaxy', 'Files as stars, pulled together by their dependencies'],
  ...VIEW_PLUGINS.map(p => [p.id, p.label, p.description] as [string, string, string]),
]

export const isKnownView = (id: string) => ALL_VIEWS.some(([v]) => v === id)

export interface ViewEntry {
  id: string
  label: string
  description: string
}

/** What the toolbar's view control holds, in order (also the keys 1–9): a view, or a group's menu. */
export type ToolbarEntry = ({ kind: 'view' } & ViewEntry) | { kind: 'group'; name: string; views: ViewEntry[] }

/** The views in toolbar order, plug-ins of one group folded into one entry where the first of them is. */
export function toolbarEntries(views: readonly (readonly [string, string, string])[], groupOf: (id: string) => string | undefined): ToolbarEntry[] {
  const entries: ToolbarEntry[] = []
  const groups = new Map<string, Extract<ToolbarEntry, { kind: 'group' }>>()
  for (const [id, label, description] of views) {
    const name = groupOf(id)
    if (!name) {
      entries.push({ kind: 'view', id, label, description })
      continue
    }
    let group = groups.get(name)
    if (!group) {
      group = { kind: 'group', name, views: [] }
      groups.set(name, group)
      entries.push(group)
    }
    group.views.push({ id, label, description })
  }
  return entries
}

export const TOOLBAR_ENTRIES: readonly ToolbarEntry[] = toolbarEntries(ALL_VIEWS, id => pluginFor(id)?.group)

/**
 * The view a toolbar entry opens: a view itself; for a group, its first
 * view, or the next one when one of them is shown (pressing its key again
 * steps through the group).
 */
export function viewForEntry(entry: ToolbarEntry, current: string): string {
  if (entry.kind === 'view') return entry.id
  const at = entry.views.findIndex(v => v.id === current)
  return entry.views[(at + 1) % entry.views.length].id
}
