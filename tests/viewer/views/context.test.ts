import { describe, expect, it } from 'vitest'
import { GraphIndex } from '../../../src/core/graph-index.ts'
import type { EdgeKind, GraphEdge, GraphNode } from '../../../src/core/model.ts'
import { overview } from '../../../src/server/views.ts'
import { excludedSystem, packageOf, systemOf } from '../../../src/viewer/views/context/catalog.ts'
import { NO_LAYER, commonFolder, contextModel } from '../../../src/viewer/views/context/model.ts'
import type { ContextModel } from '../../../src/viewer/views/context/model.ts'
import { ICON, SHELL, placeContext } from '../../../src/viewer/views/context/place.ts'
import { World } from '../../../src/viewer/world.ts'
import { analyzeFixture } from '../../helpers/fixtures.ts'

describe('the package catalog', () => {
  it('knows the packages that reach outside, and the neighbor each reaches', () => {
    expect(systemOf('pg')).toMatchObject({ key: 'sql', name: 'PostgreSQL', kind: 'database', side: 'store', channel: 'SQL' })
    expect(systemOf('@prisma/adapter-pg')?.name).toBe('PostgreSQL')
    expect(systemOf('mysql2')?.name).toBe('MySQL')
    // an ORM alone reaches a database it can't name, so a driver outranks it
    expect(systemOf('prisma')).toMatchObject({ key: 'sql', name: 'Database' })
    expect(systemOf('prisma')!.rank).toBeLessThan(systemOf('pg')!.rank)
    expect(systemOf('dexie')).toMatchObject({ key: 'indexeddb', kind: 'browser-db', side: 'store' })
    expect(systemOf('stripe')).toMatchObject({ key: 'stripe', kind: 'service', side: 'out', channel: 'HTTPS' })
    expect(systemOf('nodemailer')).toMatchObject({ name: 'Mail server', channel: 'SMTP' })
    expect(systemOf('@aws-sdk/client-s3')?.name).toBe('Object storage') // before AWS in general
    expect(systemOf('@aws-sdk/client-lambda')?.name).toBe('AWS')
    expect(systemOf('@sentry/nextjs')?.about).toBe('error tracking')
    expect(systemOf('node:fs')?.name).toBe('File system')
    expect(systemOf('node:fs/promises')?.key).toBe('fs')
    expect(systemOf('xlsx')?.key).toBe('spreadsheets')
    expect(systemOf('@tauri-apps/plugin-fs')?.name).toBe('Desktop OS (Tauri)')
    expect(systemOf('electron')?.name).toBe('Desktop OS (Electron)')
    expect(systemOf('node:child_process')?.kind).toBe('processes')
  })

  it('leaves libraries alone: code that runs inside the system', () => {
    for (const lib of ['react', 'zod', 'd3', 'next', 'node:path', 'node:crypto', '@radix-ui/react-dialog', 'pgx', 'stripe-ish']) expect(systemOf(lib), lib).toBeUndefined()
  })

  it('reads package names off external nodes, and takes a generated Prisma client for the database', () => {
    expect(packageOf('x:npm:@scope/pkg')).toBe('@scope/pkg')
    expect(packageOf('x:node:fs')).toBe('node:fs')
    expect(packageOf('f:src/a.ts')).toBeUndefined()
    expect(excludedSystem('x:excluded:src/generated/prisma/client.ts')?.key).toBe('sql')
    expect(excludedSystem('x:excluded:src/generated/demo.json')).toBeUndefined()
    expect(excludedSystem('x:npm:prisma')).toBeUndefined()
  })
})

type EdgeSpec = [source: string, kind: EdgeKind, target: string, subkind?: string]

/** An overview graph from file paths with tags (directories made up), externals by id, edges between them. */
function graphOf(files: [string, ...string[]][], externals: string[], edges: EdgeSpec[]) {
  const nodes = new Map<string, GraphNode>([['d:.', { id: 'd:.', kind: 'directory', name: 'shop', path: '' }]])
  for (const [path, ...tags] of files) {
    const parts = path.split('/')
    let parent = 'd:.'
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!nodes.has(`d:${dir}`)) nodes.set(`d:${dir}`, { id: `d:${dir}`, kind: 'directory', name: parts[i - 1], path: dir, parent })
      parent = `d:${dir}`
    }
    nodes.set(`f:${path}`, { id: `f:${path}`, kind: 'file', name: parts[parts.length - 1], path, parent, tags })
  }
  for (const id of externals) nodes.set(id, { id, kind: 'external', name: id.replace(/^x:(npm|node):/, '') })
  const id = (s: string) => (s.startsWith('x:') ? s : `f:${s}`)
  return {
    nodes: [...nodes.values()],
    edges: edges.map(([s, kind, t, subkind]): GraphEdge => ({ source: id(s), target: id(t), kind, count: 1, targets: ['web'], confidence: 'exact', ...(subkind ? { subkind } : {}) })),
  }
}

const layerOf = (n: GraphNode) => n.tags?.find(t => t.startsWith('layer:'))?.slice(6)
const modelOf = (g: ReturnType<typeof graphOf>, order = ['app', 'server', 'lib']): ContextModel =>
  contextModel({ name: 'shop', nodes: g.nodes, edges: g.edges, target: 'web', isShown: n => !n.tags?.includes('test'), order, layerOf })

// A shop: pages and API routes in app/, a server that queries Prisma through pg, a local Dexie store,
// a webhook that Stripe calls back (it also reaches the mail server, further away), libraries.
const SHOP = graphOf(
  [
    ['src/app/page.tsx', 'layer:app', 'route:/'],
    ['src/app/cart/page.tsx', 'layer:app', 'route:/cart'],
    ['src/app/api/trpc/[trpc]/route.ts', 'layer:app', 'api:/api/trpc/[trpc]'],
    ['src/app/api/cron/cleanup/route.ts', 'layer:app', 'api:/api/cron/cleanup'],
    ['src/app/api/health/route.ts', 'layer:app', 'api:/api/health'],
    ['src/app/api/export/route.ts', 'layer:app', 'api:/api/export'],
    ['src/app/api/billing/webhook/route.ts', 'layer:app', 'api:/api/billing/webhook'],
    ['src/server/db.ts', 'layer:server'],
    ['src/server/orders.ts', 'layer:server'],
    ['src/lib/pay.ts', 'layer:lib'],
    ['src/lib/mail.ts', 'layer:lib'],
    ['src/lib/types.ts', 'layer:lib'],
    ['src/lib/local.ts', 'layer:lib'],
    ['src/lib/localdb.ts', 'layer:lib'],
    ['prisma/schema.prisma', 'prisma-schema'],
    ['tests/mail.test.ts', 'test'],
  ],
  ['x:npm:react', 'x:npm:pg', 'x:npm:stripe', 'x:npm:nodemailer', 'x:npm:dexie'],
  [
    ['src/app/page.tsx', 'imports', 'x:npm:react', 'static'],
    ['src/app/api/billing/webhook/route.ts', 'imports', 'x:npm:stripe', 'static'],
    ['src/app/api/billing/webhook/route.ts', 'calls', 'src/lib/mail.ts'],
    ['src/lib/pay.ts', 'imports', 'x:npm:stripe', 'dynamic'],
    ['src/lib/types.ts', 'imports', 'x:npm:stripe', 'type-only'],
    ['src/lib/mail.ts', 'imports', 'x:npm:nodemailer', 'static'],
    ['tests/mail.test.ts', 'imports', 'x:npm:nodemailer', 'static'],
    ['src/server/db.ts', 'imports', 'x:npm:pg', 'static'],
    ['src/server/db.ts', 'queries', 'prisma/schema.prisma'],
    ['src/server/orders.ts', 'queries', 'prisma/schema.prisma'],
    ['src/lib/local.ts', 'queries', 'src/lib/localdb.ts'],
    ['src/lib/localdb.ts', 'imports', 'x:npm:dexie', 'static'],
  ],
)

describe('the context model', () => {
  const model = modelOf(SHOP)
  const nb = (key: string) => model.neighbors.find(n => n.key === key)!
  const short = (ids: string[]) => ids.map(id => id.replace(/^f:/, ''))

  it('finds the callers, the services and the data stores, callers first', () => {
    expect(model.neighbors.map(n => `${n.side}:${n.key}`)).toEqual([
      'in:user',
      'in:clients',
      'in:monitor',
      'in:scheduler',
      'out:stripe',
      'out:smtp',
      // two files each: by name
      'store:indexeddb',
      'store:sql',
    ])
    expect(model.libraries).toEqual(['react'])
  })

  it('guesses who calls an API route: the app’s own endpoints its user, cron a scheduler, health checks monitoring, the rest API clients', () => {
    expect(short(nb('user').ties[0].files)).toEqual(['src/app/api/trpc/[trpc]/route.ts', 'src/app/cart/page.tsx', 'src/app/page.tsx'])
    expect(nb('user').ties[0].routes).toEqual(['pages', '/api/trpc'])
    expect(nb('user').select).toBe('d:src/app')
    expect(nb('scheduler').ties[0]).toMatchObject({ dir: 'in', routes: ['/api/cron'], select: 'f:src/app/api/cron/cleanup/route.ts' })
    expect(nb('monitor').name).toBe('Monitoring')
    expect(short(nb('clients').ties[0].files)).toEqual(['src/app/api/export/route.ts'])
  })

  it('has a webhook called back by the service it uses itself, not one further away', () => {
    const stripe = nb('stripe')
    expect(stripe.ties.map(t => `${t.dir}:${model.slabs[t.slab].name}`)).toEqual(['in:app', 'out:app', 'out:lib'])
    expect(stripe.ties[0]).toMatchObject({ routes: ['/api/billing'], select: 'f:src/app/api/billing/webhook/route.ts' })
    // the type-only import isn't a call to Stripe
    expect(stripe.ties.flatMap(t => short(t.files))).not.toContain('src/lib/types.ts')
    expect(stripe.select).toBe('x:npm:stripe')
    expect(nb('smtp').files).toBe(1) // the test file doesn't count
  })

  it('names the database by its driver, selects the schema code queries, and ties it to the layer that queries it', () => {
    const sql = nb('sql')
    expect(sql.name).toBe('PostgreSQL')
    expect(sql.select).toBe('f:prisma/schema.prisma')
    expect(sql.ids).toEqual(['f:prisma/schema.prisma', 'x:npm:pg'])
    expect(sql.ties).toHaveLength(1)
    expect(sql.ties[0]).toMatchObject({ dir: 'out', channel: 'SQL', slab: 1 })
    expect(short(sql.ties[0].files)).toEqual(['src/server/db.ts', 'src/server/orders.ts'])
    // a Dexie database joins the package its file uses
    expect(nb('indexeddb')).toMatchObject({ name: 'IndexedDB (browser)', select: 'f:src/lib/localdb.ts' })
  })

  it('stacks one slab per layer, each standing for the folder holding its files', () => {
    expect(model.slabs.map(s => [s.name, s.files, s.select])).toEqual([
      // src/app is the user's already
      ['app', 7, undefined],
      ['server', 2, 'd:src/server'],
      ['lib', 5, 'd:src/lib'],
    ])
  })

  it('gives a layer its own tie only when it holds a fair share of the files', () => {
    const files = (n: number, layer: string) => Array.from({ length: n }, (_, i) => [`src/${layer}/f${i}.ts`, `layer:${layer}`] as [string, string])
    const uses = (paths: [string, string][]) => paths.map(([p]) => [p, 'imports', 'x:npm:axios', 'static'] as EdgeSpec)
    const fair = [...files(3, 'lib'), ...files(1, 'server')]
    expect(modelOf(graphOf(fair, ['x:npm:axios'], uses(fair))).neighbors[0].ties.map(t => t.share)).toEqual([0.75, 0.25])
    const small = [...files(7, 'lib'), ...files(1, 'server')]
    expect(modelOf(graphOf(small, ['x:npm:axios'], uses(small))).neighbors[0].ties).toHaveLength(1)
    // files in no layer get a last slab of their own
    const loose: [string, ...string[]][] = [['scripts/seed.ts'], ['src/lib/a.ts', 'layer:lib']]
    const m = modelOf(graphOf(loose, ['x:node:fs'], [['scripts/seed.ts', 'imports', 'x:node:fs', 'static']]))
    expect(m.slabs.map(s => s.name)).toEqual(['app', 'server', 'lib', NO_LAYER])
    expect(m.neighbors[0].ties[0].slab).toBe(3)
  })

  it('without pages or API routes, calls the entry points’ callers', () => {
    const m = modelOf(graphOf([['src/main.ts', 'entrypoint', 'layer:app'], ['vite.config.ts', 'entrypoint'], ['src/a.ts', 'layer:lib']], [], []))
    expect(m.neighbors.map(n => [n.key, n.files])).toEqual([['callers', 1]])
  })
})

describe('the plan', () => {
  it('stands neighbors apart round the tower, ties running from each into its layer', () => {
    // many of each kind, so arcs fill and move out
    const many = graphOf(
      [['src/a.ts', 'layer:lib'], ['src/app/page.tsx', 'layer:app', 'route:/']],
      ['x:npm:pg', 'x:npm:mongodb', 'x:npm:redis', 'x:npm:dexie', 'x:node:fs', 'x:npm:xlsx', 'x:npm:stripe', 'x:npm:resend', 'x:npm:openai', 'x:npm:@sentry/node', 'x:npm:axios', 'x:npm:twilio'],
      ['x:npm:pg', 'x:npm:mongodb', 'x:npm:redis', 'x:npm:dexie', 'x:node:fs', 'x:npm:xlsx', 'x:npm:stripe', 'x:npm:resend', 'x:npm:openai', 'x:npm:@sentry/node', 'x:npm:axios', 'x:npm:twilio'].map(x => ['src/a.ts', 'imports', x, 'static'] as EdgeSpec),
    )
    const model = modelOf(many)
    expect(model.neighbors).toHaveLength(13)
    const plan = placeContext(model, 0.3)
    for (let i = 0; i < plan.neighbors.length; i++)
      for (let j = i + 1; j < plan.neighbors.length; j++) {
        const [a, b] = [plan.neighbors[i], plan.neighbors[j]]
        expect(Math.hypot(a.x - b.x, a.z - b.z), `${model.neighbors[i].name} and ${model.neighbors[j].name}`).toBeGreaterThan(ICON * 2 + 4)
      }
    // all of them well clear of the tower, on the board
    for (const p of plan.neighbors) {
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(SHELL * 2)
      expect(Math.abs(p.x - plan.board.u)).toBeLessThan(plan.board.w / 2 - ICON)
      expect(Math.abs(p.z - plan.board.v)).toBeLessThan(plan.board.h / 2 - ICON)
    }
    // callers on the left, stores in front
    const at = (key: string) => plan.neighbors[model.neighbors.findIndex(n => n.key === key)]
    expect(at('user').x).toBeLessThan(0)
    expect(at('sql').z).toBeGreaterThan(0)
    // a tie starts by its neighbor and ends at the tower's side, at its slab's height
    for (const t of plan.ties) {
      const n = plan.neighbors[t.neighbor]
      const [first, last] = [t.points[0], t.points[t.points.length - 1]]
      expect(Math.hypot(first[0] - n.x, first[2] - n.z)).toBeLessThan(ICON + 2)
      expect(Math.max(Math.abs(last[0]), Math.abs(last[2]))).toBeCloseTo(SHELL + 0.15, 0)
      const slab = plan.slabs[model.neighbors[t.neighbor].ties[t.tie].slab]
      expect(last[1]).toBeCloseTo((slab.y0 + slab.y1) / 2)
    }
    // the top layer is highest
    expect(plan.slabs[0].y0).toBeGreaterThan(plan.slabs[1].y0)
  })
})

describe('on the fullstack fixture', async () => {
  const world = new World(overview(new GraphIndex(await analyzeFixture('fullstack'))))
  const model = contextModel({
    name: world.graph.meta.name,
    nodes: world.graph.nodes,
    edges: world.graph.edges,
    target: 'default',
    isShown: n => !n.tags?.includes('test'),
    order: [],
    layerOf: () => undefined,
  })

  it('finds the pages’ user, the health check, the Prisma database and the Dexie store, without npm packages', () => {
    expect(model.neighbors.map(n => [n.key, n.name, n.select])).toEqual([
      ['user', 'User (browser)', 'd:src/app'],
      ['monitor', 'Monitoring', 'f:src/app/api/health/route.ts'],
      ['sql', 'Database', 'f:prisma/schema.prisma'],
      ['indexeddb', 'IndexedDB (browser)', 'f:src/local/db.ts'],
    ])
    expect(model.neighbors[0].ties[0].routes).toEqual(['pages'])
    expect(model.neighbors[2].ties[0].files).toEqual(['f:src/server/routers/accounts.ts'])
    expect(model.slabs.map(s => s.name)).toEqual([NO_LAYER])
  })

  it('finds the folder holding a set of files', () => {
    const byId = new Map(world.graph.nodes.map(n => [n.id, n]))
    expect(commonFolder(['f:src/app/page.tsx', 'f:src/app/(shop)/accounts/page.tsx'], byId)).toBe('d:src/app')
    expect(commonFolder(['f:src/app/page.tsx', 'f:prisma/schema.prisma'], byId)).toBe('d:.')
    expect(commonFolder(['f:src/app/page.tsx'], byId)).toBe('f:src/app/page.tsx')
  })
})
