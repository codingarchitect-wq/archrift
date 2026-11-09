import { describe, expect, it } from 'vitest'
import { autoLayers } from '../../../src/core/auto-layers.ts'
import { GraphIndex } from '../../../src/core/graph-index.ts'
import type { GraphNode } from '../../../src/core/model.ts'
import { overview } from '../../../src/server/views.ts'
import type { Visibility } from '../../../src/viewer/controller.ts'
import type { Layout } from '../../../src/viewer/layouts/types.ts'
import { store } from '../../../src/viewer/store.ts'
import type { State } from '../../../src/viewer/store.ts'
import crosscutting from '../../../src/viewer/views/crosscutting/index.tsx'
import matrix from '../../../src/viewer/views/matrix/index.tsx'
import risks from '../../../src/viewer/views/risks/index.ts'
import terrain from '../../../src/viewer/views/terrain/index.ts'
import transit from '../../../src/viewer/views/transit/index.ts'
import tree from '../../../src/viewer/views/tree/index.ts'
import type { ViewContext, ViewPlugin } from '../../../src/viewer/views/types.ts'
import wheel from '../../../src/viewer/views/wheel/index.ts'
import { World, depGraph } from '../../../src/viewer/world.ts'
import { analyzeFixture } from '../../helpers/fixtures.ts'

const THEME = { background: '#0e1117', ground: '#141922', district: '#232a35', selection: '#ffffff', accent: '#58a6ff' }

// every folder and file of the fixture with a name written for it: «its path»
describe('described names in the views', async () => {
  const world = new World(overview(new GraphIndex(await analyzeFixture('fullstack'))))
  const shown = (n: GraphNode) => !n.tags?.includes('test') && !n.tags?.includes('asset')
  const ids = new Set(world.graph.nodes.filter(n => n.kind === 'file' && shown(n)).map(n => n.id))
  const visibility: Visibility = { key: 'described', isVisible: n => n.kind !== 'file' || ids.has(n.id), ids }
  const graph = depGraph(world, 'described', [], 'default', id => ids.has(id))
  // layers from the dependencies, as the toolbar's "derived": Transit's lines run down them
  const areas = [...new Set([...ids].map(id => world.areaOf.get(id)!))]
  const edges = [...graph.out].flatMap(([a, targets]) => targets.map(b => ({ source: world.areaOf.get(a)!, target: world.areaOf.get(b)! })))
  const auto = autoLayers(areas, edges, id => world.node(id)?.path ?? id)
  const layers = { order: auto.order, layerOf: (n: GraphNode) => auto.layerOfArea.get(world.areaOf.get(n.id) ?? '') }
  const entries = Object.fromEntries(world.graph.nodes.filter(n => (n.kind === 'directory' || n.kind === 'file') && n.path).map(n => [n.id, { name: `«${n.path}»`, summary: 'Written.' }]))

  const contextOf = (names: 'code' | 'described', selected: string | null = null): ViewContext => {
    const base = store.getState()
    const s = { ...base, selected, options: { ...base.options, names, target: 'default' }, descriptions: { entries, orphans: [] } } as State
    return { s, world, visibility, graph, grouping: null, layers: () => layers, theme: THEME, refresh: () => {} } as unknown as ViewContext
  }
  const labelsOf = (view: ViewPlugin, names: 'code' | 'described', selected?: string) => {
    const ctx = contextOf(names, selected)
    const layout = view.layout(ctx) as Layout
    return view.labels!(ctx, layout).map(l => l.text)
  }
  const written = (texts: string[]) => texts.filter(t => t.includes('«'))

  it.each([
    ['Tree', tree, undefined],
    ['Wheel', wheel, undefined],
    ['Terrain', terrain, undefined],
    ['Transit', transit, undefined],
    ['Crosscutting', crosscutting, undefined],
    ['Risks', risks, undefined],
    ['Matrix', matrix, 'f:src/server/trpc.ts'],
  ] as const)('%s labels with the names written for the code when the toolbar asks for them', (_, view, selected) => {
    const code = labelsOf(view, 'code', selected)
    expect(code.length).toBeGreaterThan(0)
    expect(written(code)).toEqual([])
    expect(written(labelsOf(view, 'described', selected)).length).toBeGreaterThan(0)
  })

  it('Matrix heads its wall with them, so its layout follows the names option', () => {
    const key = (names: 'code' | 'described') => matrix.layoutKey!(contextOf(names))
    expect(key('described')).not.toBe(key('code'))
    expect(labelsOf(matrix, 'described', 'f:src/server/trpc.ts')).toContain('«src/server/trpc.ts»')
  })
})
