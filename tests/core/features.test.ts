import { describe, expect, it } from 'vitest'
import { SHELL, featureOfRoute, findFeatures, words } from '../../src/core/features.ts'
import type { FeatureOptions } from '../../src/core/features.ts'
import type { EdgeKind, Graph, GraphEdge, GraphNode } from '../../src/core/model.ts'

type FileSpec = [path: string, ...tags: string[]]
type EdgeSpec = [source: string, kind: EdgeKind, target: string]

/** Files (each with one symbol, `<path>#main`, unless an edge names others), directories made up, symbol-level edges. */
function graphOf(files: FileSpec[], edges: EdgeSpec[]): Graph {
  const nodes = new Map<string, GraphNode>([['d:.', { id: 'd:.', kind: 'directory', name: 'shop', path: '' }]])
  for (const [path, ...tags] of files) {
    const parts = path.split('/')
    let parent = 'd:.'
    for (let i = 1; i < parts.length; i++) {
      const dir = `d:${parts.slice(0, i).join('/')}`
      if (!nodes.has(dir)) nodes.set(dir, { id: dir, kind: 'directory', name: parts[i - 1], path: parts.slice(0, i).join('/'), parent })
      parent = dir
    }
    nodes.set(`f:${path}`, { id: `f:${path}`, kind: 'file', name: parts.at(-1)!, path, parent, tags })
    nodes.set(`s:${path}#main`, { id: `s:${path}#main`, kind: 'symbol', name: 'main', path, parent: `f:${path}` })
  }
  const sym = (ref: string): string => {
    const [path, name = 'main'] = ref.split('#')
    const id = `s:${path}#${name}`
    if (!nodes.has(id)) {
      const member = name.includes('.')
      // a member's class too, so it lies in its file
      const owner = member ? sym(`${path}#${name.split('.')[0]}`) : `f:${path}`
      nodes.set(id, { id, kind: member ? 'member' : 'symbol', name: name.split('.').pop()!, path, parent: owner })
    }
    return id
  }
  const list: GraphEdge[] = edges.map(([s, kind, t]) => ({ source: sym(s), target: sym(t), kind, count: 1, targets: ['default'], confidence: 'exact' }))
  return {
    meta: { name: 'shop', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } },
    nodes: [...nodes.values()],
    edges: list,
    sites: [],
  }
}

const NONE: FeatureOptions = { merge: {}, exclude: [] }

// a shop organized by layer: pages, components (a UI kit among them), hooks, a service interface with a local
// and a cloud class, server routers, lib; features cut across all of them
const FILES: FileSpec[] = [
  ['app/layout.tsx', 'layout:/'],
  ['app/(shop)/orders/page.tsx', 'route:/orders'],
  ['app/(shop)/orders/[id]/page.tsx', 'route:/orders/[id]'],
  ['app/(shop)/cart/page.tsx', 'route:/cart'],
  ['app/(shop)/profile/page.tsx', 'route:/profile'],
  ['app/login/page.tsx', 'route:/login'],
  ['app/api/auth/route.ts', 'api:/api/auth'],
  ['app/api/trpc/route.ts', 'api:/api/trpc'],
  ['components/OrderList.tsx'],
  ['components/CartTable.tsx'],
  ['components/Nav.tsx'],
  ['components/ui/button.tsx'],
  ['components/ui/dialog.tsx'],
  ['components/ui/sheet.tsx'],
  ['components/ui/table.tsx'],
  ['hooks/useService.ts'],
  ['lib/service.ts'],
  ['lib/local-service.ts'],
  ['lib/cloud-service.ts'],
  ['lib/money.ts'],
  ['lib/format.ts'],
  ['lib/order-totals.ts'],
  ['lib/discounts.ts'],
  ['server/routers/orders.ts'],
  ['server/routers/cart.ts'],
  ['server/routers/index.ts'],
  ['scripts/seed.ts'],
  ['tests/order-totals.test.ts', 'test'],
]

const EDGES: EdgeSpec[] = [
  // every page renders through the UI kit and asks the one service (an interface) for its data
  ['app/(shop)/orders/page.tsx', 'renders', 'components/OrderList.tsx'],
  ['app/(shop)/orders/[id]/page.tsx', 'calls', 'hooks/useService.ts'],
  ['app/(shop)/orders/[id]/page.tsx', 'calls', 'lib/service.ts#Service.order'],
  ['components/OrderList.tsx', 'calls', 'hooks/useService.ts'],
  ['components/OrderList.tsx', 'calls', 'lib/service.ts#Service.orders'],
  ['components/OrderList.tsx', 'renders', 'components/ui/button.tsx'],
  ['components/OrderList.tsx', 'renders', 'components/ui/table.tsx'],
  ['components/OrderList.tsx', 'renders', 'components/ui/sheet.tsx'],
  ['components/OrderList.tsx', 'calls', 'lib/money.ts'],
  ['components/OrderList.tsx', 'calls', 'lib/order-totals.ts'],
  ['app/(shop)/cart/page.tsx', 'renders', 'components/CartTable.tsx'],
  ['components/CartTable.tsx', 'calls', 'hooks/useService.ts'],
  ['components/CartTable.tsx', 'calls', 'lib/service.ts#Service.cart'],
  ['components/CartTable.tsx', 'renders', 'components/ui/button.tsx'],
  ['components/CartTable.tsx', 'renders', 'components/ui/table.tsx'],
  ['components/CartTable.tsx', 'renders', 'components/ui/dialog.tsx'],
  ['components/CartTable.tsx', 'calls', 'lib/money.ts'],
  ['components/CartTable.tsx', 'calls', 'lib/discounts.ts'],
  ['app/(shop)/profile/page.tsx', 'calls', 'hooks/useService.ts'],
  ['app/(shop)/profile/page.tsx', 'renders', 'components/ui/button.tsx'],
  ['app/(shop)/profile/page.tsx', 'renders', 'components/ui/dialog.tsx'],
  ['app/(shop)/profile/page.tsx', 'calls', 'lib/format.ts'],
  ['app/login/page.tsx', 'renders', 'components/ui/button.tsx'],
  ['app/login/page.tsx', 'renders', 'components/ui/dialog.tsx'],
  ['app/login/page.tsx', 'calls', 'lib/format.ts'],
  ['app/api/auth/route.ts', 'calls', 'lib/format.ts'],
  // the interface's methods run in both classes; the cloud one calls the server
  ['lib/local-service.ts#Local.orders', 'implements', 'lib/service.ts#Service.orders'],
  ['lib/cloud-service.ts#Cloud.orders', 'implements', 'lib/service.ts#Service.orders'],
  ['lib/local-service.ts#Local.cart', 'implements', 'lib/service.ts#Service.cart'],
  ['lib/cloud-service.ts#Cloud.cart', 'implements', 'lib/service.ts#Service.cart'],
  ['lib/cloud-service.ts#Cloud.orders', 'rpc-call', 'server/routers/orders.ts#list'],
  ['lib/cloud-service.ts#Cloud.cart', 'rpc-call', 'server/routers/cart.ts#get'],
  ['lib/local-service.ts#Local.cart', 'calls', 'lib/discounts.ts'],
  // the tRPC endpoint reaches every router
  ['app/api/trpc/route.ts', 'references', 'server/routers/index.ts'],
  ['server/routers/index.ts', 'references', 'server/routers/orders.ts#list'],
  ['server/routers/index.ts', 'references', 'server/routers/cart.ts#get'],
  // the shell
  ['app/layout.tsx', 'renders', 'components/Nav.tsx'],
  // a link between pages is no part of either
  ['components/CartTable.tsx', 'navigates', 'app/(shop)/orders/page.tsx'],
]

describe('features: routes', () => {
  it('names a route by its first static segment, an API route by the one after /api', () => {
    expect(featureOfRoute('/orders', NONE)).toBe('orders')
    expect(featureOfRoute('/orders/[id]', NONE)).toBe('orders')
    expect(featureOfRoute('/[locale]/orders', NONE)).toBe('orders')
    // a Spring controller's paths: an API version or a {variable} names no feature
    expect(featureOfRoute('/v5/projects/{projectId}', NONE)).toBe('projects')
    expect(featureOfRoute('/{tenant}/orders', NONE)).toBe('orders')
    expect(featureOfRoute('/:locale/orders/:id', NONE)).toBe('orders') // Angular
    expect(featureOfRoute('/(theater:theater)', NONE)).toBe('theater') // an Angular named outlet
    expect(featureOfRoute('/api/upgrade/webhook', NONE)).toBe('upgrade')
    expect(featureOfRoute('/', NONE)).toBe('home')
  })

  it('leaves out transports and excluded routes, and merges routes into a named feature', () => {
    expect(featureOfRoute('/api/trpc/[trpc]', NONE)).toBeUndefined()
    expect(featureOfRoute('/api/health', NONE)).toBeUndefined()
    const options = { merge: { auth: ['/login', '/api/auth'], dashboard: ['/'] }, exclude: ['/admin'] }
    expect(featureOfRoute('/login', options)).toBe('auth')
    expect(featureOfRoute('/api/auth/verify', options)).toBe('auth')
    expect(featureOfRoute('/loginx', options)).toBe('loginx') // a prefix is whole segments
    expect(featureOfRoute('/', options)).toBe('dashboard')
    expect(featureOfRoute('/orders', options)).toBe('orders') // `/` merges only itself
    expect(featureOfRoute('/admin/users', options)).toBeUndefined()
  })

  it('splits names into singular words', () => {
    expect(words('src/hooks/useCurrentFinancesCrud.ts')).toEqual(['src', 'hook', 'use', 'current', 'finance', 'crud'])
    expect(words('lib/order-cost-history.ts')).toEqual(['lib', 'order', 'cost', 'history'])
    expect(words('categories')).toEqual(['category'])
  })
})

describe('features: who owns what', () => {
  const found = findFeatures(graphOf(FILES, EDGES))
  const ownerOf = (path: string) => found.owner.get(`f:${path}`) ?? (found.shared.has(`f:${path}`) ? 'shared' : undefined)

  it('finds a feature per route segment and the shell from the layouts, most files first', () => {
    expect(found.features.map(f => f.name).sort()).toEqual(['app shell', 'auth', 'cart', 'login', 'orders', 'profile'].sort())
    expect(found.features.find(f => f.name === 'orders')!.routes).toEqual(['/orders', '/orders/[id]'])
    expect(found.features.find(f => f.name === SHELL)!.routes).toEqual(['layout:/'])
    const files = found.features.map(f => f.files)
    expect(files).toEqual([...files].sort((a, b) => b - a))
  })

  it('follows a call through the interface to the classes implementing it, without tying the features together', () => {
    // orders and cart both use the service, but each reaches only its own server router
    expect(found.reachedBy.get('f:server/routers/orders.ts')).toEqual(['orders'])
    expect(found.reachedBy.get('f:server/routers/cart.ts')).toEqual(['cart'])
    expect(found.reachedBy.get('f:lib/cloud-service.ts')).toEqual(['cart', 'orders'])
    // a link to another page isn't followed; the tRPC endpoint is no feature
    expect(found.reachedBy.get('f:components/OrderList.tsx')).toEqual(['orders'])
    expect(found.reachedBy.has('f:server/routers/index.ts')).toBe(false)
  })

  it('gives a file named after a feature to it, wherever it lies', () => {
    expect(ownerOf('server/routers/orders.ts')).toBe('orders')
    expect(ownerOf('lib/order-totals.ts')).toBe('orders')
    expect(ownerOf('components/OrderList.tsx')).toBe('orders')
    expect(ownerOf('components/CartTable.tsx')).toBe('cart')
    // a test follows the name too; a route group isn't a name
    expect(ownerOf('tests/order-totals.test.ts')).toBe('orders')
    expect(ownerOf('app/(shop)/profile/page.tsx')).toBe('profile')
  })

  it('gives a file one feature reaches to it, and one a few reach to the one using it most', () => {
    expect(ownerOf('lib/discounts.ts')).toBe('cart') // only the cart reaches it
    expect(ownerOf('components/Nav.tsx')).toBe(SHELL)
    // the cloud service: orders and cart reach it, neither uses it more: shared
    expect(ownerOf('lib/cloud-service.ts')).toBe('shared')
  })

  it('makes code many features share common, and everything in a folder of common code, even what one feature uses', () => {
    expect(ownerOf('hooks/useService.ts')).toBe('shared')
    expect(ownerOf('lib/format.ts')).toBe('shared')
    expect(ownerOf('components/ui/button.tsx')).toBe('shared')
    expect(ownerOf('components/ui/sheet.tsx')).toBe('shared') // only orders renders it, but it's the UI kit's
  })

  it('leaves files no feature reaches and no name ties to one without', () => {
    expect(ownerOf('scripts/seed.ts')).toBeUndefined()
    expect(ownerOf('server/routers/index.ts')).toBeUndefined()
  })

  it('finds nothing without pages or API routes, and is the same whatever order the graph lists things in', () => {
    expect(findFeatures(graphOf([['lib/a.ts'], ['lib/b.ts']], [['lib/a.ts', 'calls', 'lib/b.ts']])).features).toEqual([])
    const g = graphOf(FILES, EDGES)
    const reversed = { ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() }
    const again = findFeatures(reversed)
    expect(again.features).toEqual(found.features)
    expect([...again.owner].sort()).toEqual([...found.owner].sort())
  })
})
