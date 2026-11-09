import { describe, expect, it } from 'vitest'
import type { EdgeKind, Graph, GraphEdge, GraphNode } from '../../../src/core/model.ts'
import { GAP, SPACING, arrange, sampleCentripetal } from '../../../src/viewer/views/crosscutting/layout.ts'
import { MAX_CANDIDATES, SPREAD, conceptOf, crosscuttingModel, words } from '../../../src/viewer/views/crosscutting/model.ts'
import type { CrosscuttingModel } from '../../../src/viewer/views/crosscutting/model.ts'
import { BAND, isLit, litBy } from '../../../src/viewer/views/crosscutting/scene.ts'
import { World, depGraph } from '../../../src/viewer/world.ts'

type EdgeSpec = [source: string, target: string, count?: number, kind?: EdgeKind]

/** A file-level graph: files by path (layer tags from `layers`), directories made up, edges between paths. */
function graphOf(files: string[], edges: EdgeSpec[], layers: Record<string, string> = {}, order = false): Graph {
  const nodes = new Map<string, GraphNode>([['d:.', { id: 'd:.', kind: 'directory', name: 'root', path: '' }]])
  for (const path of files) {
    const parts = path.split('/')
    let parent = 'd:.'
    for (let i = 1; i < parts.length; i++) {
      const dir = `d:${parts.slice(0, i).join('/')}`
      if (!nodes.has(dir)) nodes.set(dir, { id: dir, kind: 'directory', name: parts[i - 1], parent, path: parts.slice(0, i).join('/') })
      parent = dir
    }
    const layer = Object.entries(layers).find(([prefix]) => path.startsWith(prefix))?.[1]
    nodes.set(`f:${path}`, { id: `f:${path}`, kind: 'file', name: parts.at(-1)!, parent, path, tags: layer ? [`layer:${layer}`] : [], metrics: { loc: 10 } })
  }
  const list = [...nodes.values()]
  return {
    meta: {
      name: 'hand-made',
      generatedAt: '',
      tool: { name: 'archrift', version: '0' },
      analyzers: [],
      targets: ['default'],
      layers: [...new Set(Object.values(layers))],
      counts: {},
      timings: {},
      cycles: [],
      diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 },
    },
    nodes: order ? list.reverse() : list,
    edges: edges.map(([s, t, count = 1, kind = 'calls']): GraphEdge => ({ source: `f:${s}`, target: `f:${t}`, kind, count, targets: ['default'], confidence: 'exact' })),
    sites: [],
  }
}

function modelOf(graph: Graph, grouping?: Parameters<typeof crosscuttingModel>[0]['grouping']): { model: CrosscuttingModel; world: World } {
  const world = new World(graph)
  const ids = new Set(graph.nodes.filter(n => n.kind === 'file').map(n => n.id))
  const g = depGraph(world, 'test', [], 'default', id => ids.has(id))
  const order = graph.meta.layers ?? []
  const model = crosscuttingModel({
    world,
    isShown: n => ids.has(n.id),
    in: g.in,
    weight: g.weight,
    order,
    layerOf: n => n.tags?.find(t => t.startsWith('layer:'))?.slice(6),
    grouping,
  })
  return { model, world }
}

// a shop: pages in app (six places), ui, server, big hooks and lib blocks (lib with a schemas folder, a barrel and helpers), a small i18n block
const LIB = ['src/lib/utils.ts', 'src/lib/money.ts', 'src/lib/index.ts', 'src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts', 'src/lib/d.ts', 'src/lib/schemas/order.ts', 'src/lib/schemas/user.ts']
const FILES = [
  ...[1, 2, 3, 4, 5, 6].map(n => `src/app/p${n}/page.tsx`),
  'src/app/layout.tsx',
  'src/app/error.tsx',
  'src/app/loading.tsx',
  'src/ui/Button.tsx',
  'src/ui/Form.tsx',
  'src/server/orders.ts',
  'src/hooks/useT.ts',
  'src/hooks/useCart.ts',
  ...[1, 2, 3, 4, 5, 6, 7].map(n => `src/hooks/useThing${n}.ts`),
  'src/i18n/messages.ts',
  'src/i18n/locale.ts',
  ...LIB,
]
const EDGES: EdgeSpec[] = [
  // utils: used by app, ui and server (and by lib itself, which doesn't count)
  ['src/app/p1/page.tsx', 'src/lib/utils.ts', 5],
  ['src/ui/Button.tsx', 'src/lib/utils.ts', 2],
  ['src/server/orders.ts', 'src/lib/utils.ts', 1],
  ['src/lib/money.ts', 'src/lib/utils.ts', 9],
  // schemas: each file by fewer blocks, the folder by three
  ['src/app/p2/page.tsx', 'src/lib/schemas/order.ts'],
  ['src/server/orders.ts', 'src/lib/schemas/order.ts'],
  ['src/ui/Form.tsx', 'src/lib/schemas/user.ts'],
  // money: used by app only
  ['src/app/p3/page.tsx', 'src/lib/money.ts'],
  // the barrel: everyone imports it, but it only re-exports
  ['src/lib/index.ts', 'src/lib/a.ts', 1, 're-exports'],
  ['src/app/p4/page.tsx', 'src/lib/index.ts', 1, 'imports'],
  ['src/ui/Form.tsx', 'src/lib/index.ts', 1, 'imports'],
  ['src/server/orders.ts', 'src/lib/index.ts', 1, 'imports'],
  // translations: the useT hook all over the pages and the ui, the i18n folder from the hooks and the server
  ...[1, 2, 3, 4, 5, 6].map((n): EdgeSpec => [`src/app/p${n}/page.tsx`, 'src/hooks/useT.ts']),
  ['src/ui/Button.tsx', 'src/hooks/useT.ts'],
  ['src/hooks/useT.ts', 'src/i18n/messages.ts'],
  ['src/server/orders.ts', 'src/i18n/locale.ts'],
  // the cart hook: two blocks, few places
  ['src/app/p1/page.tsx', 'src/hooks/useCart.ts'],
  ['src/ui/Button.tsx', 'src/hooks/useCart.ts'],
]
const LAYERS = { 'src/app': 'app', 'src/ui': 'ui', 'src/hooks': 'ui', 'src/server': 'server', 'src/lib': 'lib', 'src/i18n': 'lib' }

describe('crosscutting: candidates', () => {
  const { model, world } = modelOf(graphOf(FILES, EDGES, LAYERS))

  it('orders the blocks as pillars: by layer, then largest first', () => {
    expect(model.blocks.map(b => b.name)).toEqual(['app', 'hooks', 'ui', 'server', 'lib', 'i18n'])
    expect(model.layers).toEqual([0, 1, 1, 2, 3, 3])
    expect(model.threshold).toBe(2) // 40 % of the five other blocks, at most three, at least two
  })

  it('finds code used across blocks, weighs folders and small blocks whole, and passes over barrels', () => {
    const byId = new Map(model.candidates.map(c => [c.id, c]))
    // utils: three other blocks (lib's own use doesn't count)
    const utils = byId.get('f:src/lib/utils.ts')!
    expect([...utils.users.keys()].sort()).toEqual(['d:src/app', 'd:src/server', 'd:src/ui'])
    expect(utils.weight).toBe(8)
    expect(utils.name).toBe('Utilities?')
    // schemas: the folder is one unit, used by three blocks though each file by fewer
    const schemas = byId.get('d:src/lib/schemas')!
    expect(schemas.breadth).toBe(3)
    expect(schemas.files).toEqual(['f:src/lib/schemas/order.ts', 'f:src/lib/schemas/user.ts'])
    expect(schemas.name).toBe('Validation & schemas?')
    // used by one block, or a barrel: not candidates
    expect(byId.has('f:src/lib/money.ts')).toBe(false)
    expect(byId.has('f:src/lib/index.ts')).toBe(false)
    // the hooks are weighed one by one (a big block), useCart by its two users
    expect(byId.get('f:src/hooks/useCart.ts')?.breadth).toBe(2)
    expect(world.node('d:src/hooks')).toBeDefined()
  })

  it('makes units suggesting the same concept one candidate, with both homes', () => {
    const t = model.candidates.find(c => c.concept === 'Translations (i18n)')!
    expect(t.members.map(m => m.id)).toEqual(['f:src/hooks/useT.ts', 'd:src/i18n'])
    expect(t.id).toBe('f:src/hooks/useT.ts') // the most widely used member
    expect(t.homes).toEqual(['d:src/hooks', 'd:src/i18n'])
    // the hooks use i18n, but hooks is a home: the users are the others
    expect([...t.users.keys()].sort()).toEqual(['d:src/app', 'd:src/server', 'd:src/ui'])
    expect(t.spread).toBe(8) // six page folders, the ui, the server
    expect(model.candidates.filter(c => c.concept === 'Translations (i18n)')).toHaveLength(1)
  })

  it('ranks by spread, then breadth, then weight', () => {
    expect(model.candidates.map(c => c.name)).toEqual(['Translations (i18n)?', 'Utilities?', 'Validation & schemas?', 'useCart'])
  })

  it('needs three blocks, or two in many places, when there are many blocks', () => {
    // nine more blocks: the threshold rises to three
    const extra = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(x => `src/${x}/x.ts`)
    const { model: wide } = modelOf(graphOf([...FILES, ...extra], EDGES, LAYERS))
    expect(wide.threshold).toBe(3)
    const names = wide.candidates.map(c => c.name)
    expect(names).toContain('Translations (i18n)?')
    expect(names).not.toContain('useCart') // two blocks, two places
    expect(SPREAD).toBeGreaterThan(2)
  })

  it('is the same whatever order the graph lists things in', () => {
    const again = modelOf(graphOf(FILES, EDGES, LAYERS, true)).model
    expect(again.blocks.map(b => b.id)).toEqual(model.blocks.map(b => b.id))
    expect(again.candidates.map(c => [c.id, c.breadth, c.spread, c.weight])).toEqual(model.candidates.map(c => [c.id, c.breadth, c.spread, c.weight]))
  })

  it('keeps at most MAX_CANDIDATES', () => {
    const files = [...Array.from({ length: 20 }, (_, i) => `src/core/util${i}.ts`), 'src/core/pad1.ts', 'src/core/pad2.ts', 'src/a/x.ts', 'src/b/x.ts', 'src/c/x.ts']
    const edges: EdgeSpec[] = Array.from({ length: 20 }, (_, i) => ['src/a/x.ts', 'src/b/x.ts', 'src/c/x.ts'].map((s): EdgeSpec => [s, `src/core/util${i}.ts`])).flat()
    expect(modelOf(graphOf(files, edges)).model.candidates).toHaveLength(MAX_CANDIDATES)
  })
})

describe('crosscutting: concept names', () => {
  it('splits names into words at separators and camel case', () => {
    expect(words('useDataService')).toEqual(['use', 'data', 'service'])
    expect(words('entitlement-token')).toEqual(['entitlement', 'token'])
    expect(words('(auth)')).toEqual(['auth'])
  })

  it('suggests a concept from the unit’s own name first, then its folders', () => {
    expect(conceptOf('src/hooks/useAuth.ts')).toBe('Authentication')
    expect(conceptOf('src/hooks/useNavT.ts')).toBe('Translations (i18n)')
    expect(conceptOf('src/i18n')).toBe('Translations (i18n)')
    expect(conceptOf('src/lib/schemas')).toBe('Validation & schemas')
    expect(conceptOf('src/lib/local-db.ts')).toBe('Persistence')
    expect(conceptOf('src/lib/entitlement-token.ts')).toBe('Feature gating')
    expect(conceptOf('src/components/ui')).toBe('UI primitives')
    expect(conceptOf('src/types')).toBe('Shared types')
    expect(conceptOf('src/lib/utils/date.ts')).toBe('Utilities') // from its folder
    expect(conceptOf('src/lib/shipping-estimate.ts')).toBeUndefined()
    // a hook named after a thing ending in T is not a translation hook unless the T stands alone
    expect(conceptOf('src/hooks/useEffect.ts')).toBeUndefined()
  })
})

describe('crosscutting: layout', () => {
  const { model, world } = modelOf(graphOf(FILES, EDGES, LAYERS))
  const a = arrange(model)

  it('stands the pillars evenly in a gentle arc, sized by their files', () => {
    expect(a.pillars.map(p => p.id)).toEqual(model.blocks.map(b => b.id))
    a.pillars.slice(1).forEach((p, i) => expect(p.x - a.pillars[i].x).toBeCloseTo(SPACING))
    // the ends nearer the camera than the middle
    expect(a.pillars[0].z).toBeCloseTo(0)
    expect(a.pillars[a.pillars.length - 1].z).toBeCloseTo(0)
    expect(a.pillars[2].z).toBeLessThan(0)
    const app = a.pillars[0]
    const ui = a.pillars[2]
    expect(app.side).toBeGreaterThan(ui.side) // nine files against two
    for (const p of a.pillars) expect(p.h).toBeGreaterThan(a.bands[0].y)
  })

  it('puts the most widely spread band highest, one gap apart', () => {
    const ys = a.bands.map(b => b.y)
    ys.slice(1).forEach((y, k) => expect(ys[k] - y).toBeCloseTo(GAP))
  })

  it('runs a band through the pillars using it and behind the others, faint between pillars that don’t', () => {
    const k = model.candidates.findIndex(c => c.id === 'd:src/lib/schemas')
    const band = a.bands[k]
    // users: app, ui, server; home: lib; neither: hooks, i18n
    expect(band.uses.map(u => u > 0)).toEqual([true, false, true, true, false, false])
    expect(band.homes).toEqual([false, false, false, false, true, false])
    const at = (x: number) => band.spans.flatMap(s => s.points).reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best))
    const pillar = (i: number) => a.pillars[i]
    expect(at(pillar(0).x)[2]).toBeCloseTo(pillar(0).z, 1) // through app
    expect(at(pillar(1).x)[2]).toBeLessThan(pillar(1).z - pillar(1).side / 2) // behind hooks
    // spans: before app, app–hooks, hooks–ui, ui–server, server–lib, lib–i18n, on to the label (twice): each touches a user or a home
    expect(band.spans.map(s => s.strong)).toEqual([true, true, true, true, true, true, true, true])
    const t = a.bands[model.candidates.findIndex(c => c.concept === 'Translations (i18n)')]
    expect(t.uses.map(u => u > 0)).toEqual([true, false, true, true, false, false])
    expect(t.homes).toEqual([false, true, false, false, false, true])
    // every span joins the next one
    for (const b of a.bands) b.spans.slice(1).forEach((s, i) => expect(s.points[0]).toEqual(b.spans[i].points[b.spans[i].points.length - 1]))
    void world
  })

  it('fades a span with no pillar using the band at either end', () => {
    const files = ['src/a/x.ts', 'src/b/x.ts', 'src/c/x.ts', 'src/d/x.ts', 'src/e/x.ts', 'src/f/x.ts']
    const edges: EdgeSpec[] = [
      ['src/a/x.ts', 'src/f/x.ts'],
      ['src/b/x.ts', 'src/f/x.ts'],
      ['src/c/x.ts', 'src/f/x.ts'],
    ]
    const m = modelOf(graphOf(files, edges)).model
    const band = arrange(m).bands[0]
    const pillar = (id: string) => m.blocks.findIndex(b => b.id === id)
    expect(band.homes[pillar('d:src/f')]).toBe(true)
    // the span between d and e touches neither a user nor the home; the ones on either side do
    expect([pillar('d:src/d'), pillar('d:src/e')]).toEqual([3, 4])
    expect(band.spans.map(s => s.strong)).toEqual([true, true, true, true, false, true, true, true])
  })

  it('puts each pillar’s name in the first row where it clears the others', () => {
    const files = ['src/a-very-long-folder-name-indeed/x.ts', 'src/b-another-long-folder-name/x.ts', 'src/c/x.ts']
    const m = modelOf(graphOf(files, [])).model
    const p = arrange(m).pillars
    const row = (i: number) => p[i].nameZ - p[i].z - p[i].side / 2
    expect(new Set(p.map((_, i) => Math.round(row(i)))).size).toBeGreaterThan(1)
  })

  it('samples a smooth curve through every knot', () => {
    const knots = [
      [0, 0, 0],
      [10, 0, 5],
      [20, 0, 0],
    ] as const
    const pts = sampleCentripetal(knots, 4)
    expect(pts).toHaveLength(9)
    expect(pts[0]).toEqual([0, 0, 0])
    expect(pts[4][0]).toBeCloseTo(10)
    expect(pts[4][2]).toBeCloseTo(5)
    expect(pts[8]).toEqual([20, 0, 0])
  })
})

describe('crosscutting: what the selection lights', () => {
  const { model, world } = modelOf(graphOf(FILES, EDGES, LAYERS))
  const scene = { model, arrangement: arrange(model) }
  const pillar = (id: string) => model.blocks.findIndex(b => b.id === id)
  const band = (name: string) => model.candidates.findIndex(c => c.name === name)

  it('lights a band, its users and its homes for a file or folder of it', () => {
    const lit = litBy(scene, world, 'f:src/lib/schemas/user.ts')!
    expect([...lit.bands]).toEqual([band('Validation & schemas?')])
    expect([...lit.pillars].sort()).toEqual([pillar('d:src/app'), pillar('d:src/ui'), pillar('d:src/server'), pillar('d:src/lib')].sort())
    expect(litBy(scene, world, 'd:src/i18n')!.bands).toEqual(new Set([band('Translations (i18n)?')]))
  })

  it('lights a pillar and the bands it uses or holds for its folder or another file in it', () => {
    const lit = litBy(scene, world, 'f:src/lib/money.ts')!
    expect([...lit.pillars]).toEqual([pillar('d:src/lib')])
    expect([...lit.bands].sort()).toEqual([band('Utilities?'), band('Validation & schemas?')].sort())
    expect(litBy(scene, world, 'd:src/ui')!.pillars).toEqual(new Set([pillar('d:src/ui')]))
  })

  it('lights everything without a selection, or with one outside the blocks', () => {
    expect(litBy(scene, world, null)).toBeNull()
    expect(litBy(scene, world, 'x:npm:react')).toBeNull()
    expect(isLit(null, 3)).toBe(true)
    const lit = litBy(scene, world, 'd:src/ui')
    expect(isLit(lit, pillar('d:src/ui'))).toBe(true)
    expect(isLit(lit, pillar('d:src/app'))).toBe(false)
    expect(isLit(lit, BAND + band('Utilities?'))).toBe(true)
    expect(isLit(lit, -1)).toBe(true) // the board
  })
})

describe('crosscutting: pillars by the toolbar’s grouping', () => {
  // the shop's layers as the toolbar's groups: app, ui (ui and hooks), server, lib (lib and i18n)
  const graph = graphOf(FILES, EDGES, LAYERS)
  const byLayer = {
    groups: ['app', 'ui', 'server', 'lib'].map(l => ({ id: `layer:${l}`, label: l })),
    groupOf: (f: string) => `layer:${Object.entries(LAYERS).find(([prefix]) => f.startsWith(`f:${prefix}`))?.[1]}`,
  }
  const { model, world } = modelOf(graph, byLayer)

  it('stands the groups as pillars, and finds what cuts across them', () => {
    expect(model.blocks.map(b => [b.id, b.name])).toEqual([
      ['layer:app', 'app'],
      ['layer:ui', 'ui'],
      ['layer:server', 'server'],
      ['layer:lib', 'lib'],
    ])
    // a group's code is weighed by the folders below the one its files share (lib's: src): lib/ is used by the
    // three other groups, the translations in i18n/ by ui (through useT) and the server
    expect(model.candidates.map(c => [c.name, c.members.map(m => m.id), [...c.users.keys()].sort(), c.homes])).toEqual([
      ['lib/', ['d:src/lib'], ['layer:app', 'layer:server', 'layer:ui'], ['layer:lib']],
      ['Translations (i18n)?', ['d:src/i18n'], ['layer:server', 'layer:ui'], ['layer:lib']],
    ])
  })

  it('lights a group’s pillar for the group or one of its files', () => {
    const scene = { model, arrangement: arrange(model) }
    const ui = model.blocks.findIndex(b => b.id === 'layer:ui')
    expect(litBy(scene, world, 'layer:ui')?.pillars).toEqual(new Set([ui]))
    expect(litBy(scene, world, 'f:src/hooks/useCart.ts')?.pillars).toEqual(new Set([ui]))
  })
})
