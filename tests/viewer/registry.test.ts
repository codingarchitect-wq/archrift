import { describe, expect, it } from 'vitest'
import { ALL_VIEWS, TOOLBAR_ENTRIES, VIEW_PLUGINS, isKnownView, pluginFor, toolbarEntries, viewForEntry } from '../../src/viewer/views/registry.ts'

describe('the view registry', () => {
  it('lists the built-in views first, then the plug-ins by order', () => {
    expect(ALL_VIEWS.slice(0, 3).map(v => v[0])).toEqual(['city', 'layers', 'galaxy'])
    expect(ALL_VIEWS.slice(3).map(v => v[0])).toEqual(VIEW_PLUGINS.map(p => p.id))
    const orders = VIEW_PLUGINS.map(p => p.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('gives every plug-in a unique lowercase id, a label and a description', () => {
    const ids = VIEW_PLUGINS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of VIEW_PLUGINS) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(['city', 'layers', 'galaxy']).not.toContain(p.id)
      expect(p.label && p.description).toBeTruthy()
    }
  })

  it('knows its views and nothing else', () => {
    expect(isKnownView('city')).toBe(true)
    expect(isKnownView('nosuchview')).toBe(false)
    expect(pluginFor('city')).toBeUndefined()
  })
})

describe('toolbar entries', () => {
  const views: [string, string, string][] = [
    ['city', 'City', ''],
    ['matrix', 'Matrix', ''],
    ['context', '§3 Context', ''],
    ['wheel', 'Wheel', ''],
    ['blocks', '§5 Building blocks', ''],
  ]
  const groups: Record<string, string> = { context: 'arc42', blocks: 'arc42' }

  it('folds a group into one entry where its first view is', () => {
    const entries = toolbarEntries(views, id => groups[id])
    expect(entries.map(e => (e.kind === 'view' ? e.id : `[${e.name}: ${e.views.map(v => v.id).join(' ')}]`))).toEqual([
      'city',
      'matrix',
      '[arc42: context blocks]',
      'wheel',
    ])
  })

  it('opens a group at its first view, and steps through it when one of them is shown', () => {
    const group = toolbarEntries(views, id => groups[id])[2]
    expect(viewForEntry(group, 'city')).toBe('context')
    expect(viewForEntry(group, 'context')).toBe('blocks')
    expect(viewForEntry(group, 'blocks')).toBe('context')
    expect(viewForEntry({ kind: 'view', id: 'wheel', label: 'Wheel', description: '' }, 'context')).toBe('wheel')
  })

  it('lists every view of the registry once', () => {
    const ids = TOOLBAR_ENTRIES.flatMap(e => (e.kind === 'view' ? [e.id] : e.views.map(v => v.id)))
    expect(ids.sort()).toEqual(ALL_VIEWS.map(v => v[0]).sort())
  })
})
