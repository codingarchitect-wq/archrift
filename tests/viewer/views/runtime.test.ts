import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GraphIndex } from '../../../src/core/graph-index.ts'
import type { EdgeKind, GraphNode } from '../../../src/core/model.ts'
import { fileDetails, overview } from '../../../src/server/views.ts'
import type { EdgeWithSites, FileDetails } from '../../../src/server/views.ts'
import { currentEntry, entriesFor } from '../../../src/viewer/views/runtime/choice.ts'
import { ROW, layoutDiagram, messageText, relief } from '../../../src/viewer/views/runtime/diagram.ts'
import { relatedTo } from '../../../src/viewer/views/runtime/decoration.ts'
import { groupScenario } from '../../../src/viewer/views/runtime/grouped.ts'
import { entriesOf, mainSymbols, participantName, walkScenario } from '../../../src/viewer/views/runtime/scenario.ts'
import type { Scenario } from '../../../src/viewer/views/runtime/scenario.ts'
import { World } from '../../../src/viewer/world.ts'
import { FIXTURES, analyzeFixture } from '../../helpers/fixtures.ts'

const ACCOUNTS = 'f:src/app/(shop)/accounts/page.tsx'

/** The fullstack fixture's scenarios, walked over the server's own file details. */
async function fullstack() {
  const graph = await analyzeFixture('fullstack')
  const index = new GraphIndex(graph)
  const walk = (entry: string) =>
    walkScenario({
      entry: index.node(entry)!,
      details: async f => fileDetails(index, f),
      line: async (p, l) => fs.readFileSync(path.join(FIXTURES, 'fullstack', p), 'utf8').split('\n')[l - 1],
      file: id => index.node(id),
    })
  return { graph, index, walk }
}

// ── a made-up codebase: a page calling a service interface with a local and a cloud implementation ──

type Sym = [id: string, subkind: string, extra?: Partial<GraphNode>]
type Ref = [source: string, kind: EdgeKind, target: string, line: number, col?: number, subkind?: string]

/** File details for made-up files: symbols by id (`s:<path>#Name`), edges with one site each. */
function madeUp(symbols: Sym[], refs: Ref[]) {
  const nodes = new Map<string, GraphNode>()
  for (const [id, subkind, extra] of symbols) {
    const [, path, name] = /^s:(.*)#(.*)$/.exec(id)!
    const member = name.includes('.')
    nodes.set(id, { id, kind: member ? 'member' : 'symbol', name: name.split('.').pop()!, subkind, path, parent: member ? `s:${path}#${name.split('.')[0]}` : `f:${path}`, ...extra })
  }
  const fileOf = (id: string) => `f:${/^s:(.*)#/.exec(id)![1]}`
  const files = new Map<string, GraphNode>()
  for (const n of nodes.values()) {
    const f = fileOf(n.id)
    files.set(f, { id: f, kind: 'file', name: n.path!.split('/').pop()!, path: n.path })
  }
  const edges: EdgeWithSites[] = refs.map(([source, kind, target, line, col = 1, subkind]) => ({ source, target, kind, subkind, count: 1, targets: ['default'], confidence: 'exact', sites: [line, col] }))
  let reads = 0
  const details = async (file: string): Promise<FileDetails | undefined> => {
    reads++
    const own = [...nodes.values()].filter(n => fileOf(n.id) === file)
    if (!own.length) return undefined
    const ids = new Set(own.map(n => n.id))
    const touching = edges.filter(e => ids.has(e.source) || ids.has(e.target))
    const endpoints = [...new Set(touching.flatMap(e => [e.source, e.target]))].filter(id => !ids.has(id)).map(id => nodes.get(id)!)
    return { file, symbols: own, edges: touching, endpoints }
  }
  return { details, file: (id: string) => files.get(id), node: (id: string) => nodes.get(id) ?? files.get(id), reads: () => reads }
}

const SHOP = madeUp(
  [
    ['s:app/page.tsx#Page', 'component', { tags: ['default-export'], exported: true }],
    ['s:app/page.tsx#helper', 'function'],
    ['s:app/page.tsx#quiet', 'function'],
    ['s:lib/svc.ts#Svc', 'interface'],
    ['s:lib/svc.ts#Svc.load', 'method'],
    ['s:lib/local.ts#Local', 'class'],
    ['s:lib/local.ts#Local.load', 'method'],
    ['s:lib/cloud.ts#Cloud', 'class'],
    ['s:lib/cloud.ts#Cloud.load', 'method'],
    ['s:lib/db.ts#DB', 'class'],
    ['s:lib/db.ts#DB.items', 'table', { tags: ['dexie'] }],
    ['s:server/router.ts#router', 'variable'],
    ['s:server/router.ts#router.list', 'procedure', { tags: ['rpc:items.list'] }],
    ['s:prisma/schema.prisma#Item', 'model'],
    ['s:lib/util.ts#fmt', 'function', { metrics: { fanIn: 80 } }],
    ['s:ui/Header.tsx#Header', 'component'],
    ['s:ui/Header.tsx#Title', 'component'],
  ],
  [
    // the page: a utility (left out), a helper in the file leading to the service, a header rendered last
    ['s:app/page.tsx#Page', 'calls', 's:lib/util.ts#fmt', 2],
    ['s:app/page.tsx#Page', 'calls', 's:app/page.tsx#helper', 3],
    ['s:app/page.tsx#Page', 'calls', 's:app/page.tsx#quiet', 4],
    ['s:app/page.tsx#Page', 'renders', 's:ui/Header.tsx#Header', 9],
    ['s:app/page.tsx#helper', 'calls', 's:lib/svc.ts#Svc.load', 12],
    ['s:ui/Header.tsx#Header', 'renders', 's:ui/Header.tsx#Title', 3],
    // the interface and the classes implementing it
    ['s:lib/local.ts#Local.load', 'implements', 's:lib/svc.ts#Svc.load', 1],
    ['s:lib/cloud.ts#Cloud.load', 'implements', 's:lib/svc.ts#Svc.load', 1],
    ['s:lib/local.ts#Local.load', 'queries', 's:lib/db.ts#DB.items', 5, 17, 'read'],
    ['s:lib/cloud.ts#Cloud.load', 'rpc-call', 's:server/router.ts#router.list', 4, 3, 'query'],
    ['s:server/router.ts#router.list', 'queries', 's:prisma/schema.prisma#Item', 7, 35, 'read'],
  ],
)

const walkShop = (limits?: Parameters<typeof walkScenario>[0]['limits']) =>
  walkScenario({
    entry: { id: 'f:app/page.tsx', kind: 'file', name: 'page.tsx', path: 'app/page.tsx', tags: ['route:/shop'] },
    details: SHOP.details,
    file: SHOP.file,
    // the source lines the queries are on: the accessor where the site is, then the operation
    line: async (_path, line) => (line === 7 ? '    const rows = await ctx.prisma.item.findMany()' : line === 5 ? '    return this.items.toArray()' : undefined),
    limits,
  })

describe('runtime view: the scenario walk', () => {
  it('follows the calls in source order, through an interface to each class implementing it, across the network to the data', async () => {
    const s = await walkShop()
    expect(s.name).toBe('/shop')
    expect(s.participants.map(p => [p.name, p.kind, p.side])).toEqual([
      ['Browser', 'actor', 'client'],
      ['app/page', 'file', 'client'],
      ['svc', 'interface', 'client'],
      ['cloud', 'file', 'client'],
      ['local', 'file', 'client'],
      ['Header', 'file', 'client'],
      ['db', 'database', 'client'],
      // the server side after the client's databases
      ['router', 'file', 'server'],
      ['schema.prisma', 'database', 'server'],
    ])
    const name = (i: number) => s.participants[i].name
    expect(s.messages.map(m => [m.depth, m.kind, m.label, name(m.from), name(m.to)])).toEqual([
      [1, 'open', 'open /shop', 'Browser', 'app/page'],
      [2, 'self', 'helper()', 'app/page', 'app/page'], // a call within the file, shown for where it leads
      [3, 'call', 'load()', 'app/page', 'svc'],
      [4, 'call', 'load()', 'svc', 'cloud'], // the alt's operands, in id order
      [5, 'rpc', 'items.list.query()', 'cloud', 'router'],
      [6, 'query', 'Item.findMany()', 'router', 'schema.prisma'], // the operation read off the source line
      [4, 'call', 'load()', 'svc', 'local'],
      [5, 'query', 'items.toArray()', 'local', 'db'],
      [2, 'render', '<Header/>', 'app/page', 'Header'], // Header's own render of Title leads nowhere: left out
    ])
    expect(s.fragments).toEqual([
      {
        kind: 'alt',
        depth: 3,
        operands: [
          { guard: 'Cloud', first: 3, last: 5 },
          { guard: 'Local', first: 6, last: 7 },
        ],
      },
    ])
    expect(s.messages.filter(m => m.fragment).map(m => m.fragment!.operand)).toEqual([0, 0, 0, 1, 1])
    // `fmt` (used everywhere, leading nowhere) and `quiet` (a call in the file leading nowhere) are left out
    expect(s.messages.some(m => /^(fmt|quiet)/.test(m.label))).toBe(false)
    // what selecting a message selects: the callee, or the entry file for the first one
    expect(s.messages[0].target).toBe('f:app/page.tsx')
    expect(s.messages[4]).toMatchObject({ target: 's:server/router.ts#router.list', source: 's:lib/cloud.ts#Cloud.load' })
  })

  it('keeps to its caps: messages, lifelines and depth, saying how much it left out', async () => {
    // four messages: the way to the data first; the alt's two operands don't fit any more
    const few = await walkShop({ messages: 4 })
    expect(few.messages.map(m => m.label)).toEqual(['open /shop', 'helper()', 'load()', '<Header/>'])
    expect(few.fragments).toEqual([])
    expect(few.left).toBe(8)
    const narrow = await walkShop({ participants: 4 })
    expect(narrow.participants.map(p => p.name)).toEqual(['Browser', 'app/page', 'svc', 'Header'])
    // depth counts calls into other files: a call within one, or an interface handing it on, isn't a level
    const shallow = await walkShop({ depth: 2 })
    expect(shallow.messages.map(m => m.label)).toEqual(['open /shop', 'helper()', 'load()', 'load()', 'items.list.query()', 'load()', 'items.toArray()', '<Header/>'])
  })

  it('reads each file once', async () => {
    const before = SHOP.reads()
    await walkShop()
    // page, svc, local, cloud, router, db, schema, ui/Header, util
    expect(SHOP.reads() - before).toBeLessThanOrEqual(9)
  })

  it('starts at a page’s default export, an API route’s handlers, or else what a file exports', () => {
    const n = (name: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id: `s:x.ts#${name}`, kind: 'symbol', name, subkind: 'function', ...extra })
    expect(mainSymbols([n('GET'), n('POST'), n('helper')], true).map(s => s.name)).toEqual(['GET', 'POST'])
    expect(mainSymbols([n('Page', { tags: ['default-export'] }), n('other', { exported: true })], false).map(s => s.name)).toEqual(['Page'])
    expect(mainSymbols([n('run', { exported: true }), n('T', { subkind: 'type', exported: true })], false).map(s => s.name)).toEqual(['run'])
  })

  it('names files as the diagram shows them', () => {
    expect(participantName({ id: 'f:src/app/(shop)/accounts/page.tsx', kind: 'file', name: 'page.tsx', path: 'src/app/(shop)/accounts/page.tsx' })).toBe('accounts/page')
    expect(participantName({ id: 'f:src/lib/db.ts', kind: 'file', name: 'db.ts', path: 'src/lib/db.ts' })).toBe('db')
    expect(participantName({ id: 'f:prisma/schema.prisma', kind: 'file', name: 'schema.prisma', path: 'prisma/schema.prisma' })).toBe('schema.prisma')
  })
})

describe('runtime view: on the fullstack fixture', () => {
  it('traces /accounts from the page through the client service and tRPC to the Prisma model', async () => {
    const { walk } = await fullstack()
    const s = await walk(ACCOUNTS)
    expect(s.participants.map(p => `${p.name}:${p.kind}:${p.side}`)).toEqual([
      'Browser:actor:client',
      'accounts/page:file:client',
      'fake-libs:file:client',
      'service:file:client',
      'accounts:file:server',
      'schema.prisma:database:server',
    ])
    expect(s.messages.map(m => messageText(m))).toEqual(['open /accounts', 'useRouter() ×3', 'new CloudService()', 'getAccounts()', 'accounts.list.query()', 'Account.findMany()'])
    expect(s.messages.map(m => m.kind)).toEqual(['open', 'call', 'new', 'call', 'rpc', 'query'])
    expect(s.left).toBe(0)
  })

  it('lists the pages and API routes, and opens on the one reaching data through the most files', async () => {
    const { graph, index } = await fullstack()
    expect(entriesOf(graph.nodes).map(e => e.id)).toEqual(['f:src/app/page.tsx', ACCOUNTS, 'f:src/app/(shop)/accounts/[id]/page.tsx', 'f:src/app/api/health/route.ts'])
    const world = new World(overview(index))
    const entries = entriesFor(world)
    expect(entries.find(e => e.id === ACCOUNTS)).toMatchObject({ name: '/accounts', data: true, api: false })
    expect(entries.find(e => e.name === '/api/health')).toMatchObject({ api: true, data: false })
    expect(currentEntry(entries, null)?.id).toBe(ACCOUNTS)
    expect(currentEntry(entries, 'f:src/app/page.tsx')?.name).toBe('/')
    expect(currentEntry(entries, 'f:nope')?.id).toBe(ACCOUNTS)
  })
})

describe('runtime view: the diagram', () => {
  const diagram = async () => layoutDiagram(await walkShop(), { viewport: 1000, aspect: 1.6 })

  it('gives each message a row of its own, with room before an alt and between its operands', async () => {
    const d = await diagram()
    for (let k = 1; k < d.rows.length; k++) expect(d.rows[k] - d.rows[k - 1]).toBeGreaterThanOrEqual(ROW - 1e-9)
    const [alt] = d.fragments
    // the alt starts after the dispatching call with a gap for its top line and guard; the second operand too
    expect(d.rows[3] - d.rows[2]).toBeGreaterThan(2 * ROW)
    expect(d.rows[6] - d.rows[5]).toBeGreaterThan(2 * ROW)
    expect(alt.v0).toBeGreaterThan(d.rows[2])
    expect(alt.v0).toBeLessThan(d.rows[3])
    expect(alt.dividers).toHaveLength(1)
    expect(alt.dividers[0]).toBeGreaterThan(d.rows[5])
    expect(alt.dividers[0]).toBeLessThan(d.rows[6])
    expect(alt.guards.map(g => g.text)).toEqual(['[Cloud]', '[Local]'])
    // a row is tall enough on screen for a label (the viewer keeps labels 18 px apart)
    expect(ROW * d.pixels).toBeGreaterThanOrEqual(18)
  })

  it('stands deeper calls further out of the board, with each arrow on the front of the activation it starts', async () => {
    const d = await diagram()
    const s = d.scenario
    for (const a of d.arrows) expect(a.lift).toBeCloseTo(relief(s.messages[a.message].depth) + 0.03)
    expect(relief(5)).toBeGreaterThan(relief(2))
    // every message but the actor's starts an activation, on its callee's lifeline, ending at or after its last nested message
    expect(d.activations).toHaveLength(s.messages.length)
    for (const a of d.activations) {
      expect(a.v1).toBeGreaterThan(a.v0)
      expect(Math.abs(a.u - d.columns[a.participant].u)).toBeLessThan(ROW)
    }
    // the self-call's activation is nested: shifted right on its lifeline
    const self = d.activations.find(a => s.messages[a.message].kind === 'self')!
    expect(self.u).toBeGreaterThan(d.columns[self.participant].u)
    // its arrow loops out and back
    expect(d.arrows.find(a => a.message === self.message)!.points).toHaveLength(4)
  })

  it('puts the network between the client side and the server side', async () => {
    const d = await diagram()
    const s = d.scenario
    const lastClient = s.participants.map(p => p.side).lastIndexOf('client')
    expect(d.boundary?.label).toBe('network · tRPC')
    expect(d.boundary!.u).toBeGreaterThan(d.columns[lastClient].u)
    expect(d.boundary!.u).toBeLessThan(d.columns[lastClient + 1].u)
    // lifelines left to right, inside the board
    const us = d.columns.map(c => c.u)
    expect(us).toEqual([...us].sort((a, b) => a - b))
    expect(us[0]).toBeGreaterThan(0)
    expect(us[us.length - 1]).toBeLessThan(d.width)
  })

  it('moves a name up a line when its neighbor’s is in the way, and keeps names on a line apart', async () => {
    const s = await walkShop()
    const short = layoutDiagram({ ...s, participants: s.participants.map((p, i) => ({ ...p, name: `p${i}` })) }, { viewport: 1000, aspect: 1.6 })
    const long: Scenario = { ...s, participants: s.participants.map(p => ({ ...p, name: `${p.name}-with-a-rather-long-name` })) }
    const d = layoutDiagram(long, { viewport: 1000, aspect: 1.6 })
    expect(new Set(short.columns.map(c => c.nameV)).size).toBe(1)
    expect(new Set(d.columns.map(c => c.nameV)).size).toBe(2)
    // on each line, neighbors' names (12px bold, about 7.4px a letter) don't overlap at the scale the layout was made for
    const scale = d.pixels
    for (const v of new Set(d.columns.map(c => c.nameV))) {
      const on = d.columns.map((c, i) => ({ c, i })).filter(x => x.c.nameV === v)
      const half = (i: number) => (long.participants[i].name.length * 7.4 + 12) / 2
      for (let k = 1; k < on.length; k++) expect((on[k].c.u - on[k - 1].c.u) * scale).toBeGreaterThanOrEqual(half(on[k].i) + half(on[k - 1].i) - 1e-6)
    }
  })

  it('says which messages a selection touches', async () => {
    const d = await diagram()
    expect(relatedTo(null, d)).toBeNull()
    expect(relatedTo('f:elsewhere.ts', d)).toBeNull()
    const local = relatedTo('f:lib/local.ts', d)!
    expect([...local.messages].map(k => d.scenario.messages[k].label)).toEqual(['load()', 'items.toArray()'])
    const list = relatedTo('s:server/router.ts#router.list', d)!
    expect([...list.messages].map(k => d.scenario.messages[k].kind)).toEqual(['rpc', 'query'])
  })
})

describe('runtime view: lifelines by the toolbar’s grouping', () => {
  it('merges the files of a group into its lifeline, keeps the actor and the databases, and the client side first', async () => {
    const s = await walkShop()
    // the client: the page, the ui and the library's files; the server its router; databases stay their own
    const groupOf = (f: string) => (f.startsWith('f:server/') ? 'layer:server' : f.startsWith('f:prisma/') || f === 'f:lib/db.ts' ? undefined : 'layer:client')
    const g = groupScenario(s, groupOf, id => id.slice(6))
    expect(g.participants.map(p => [p.kind, p.name, p.side])).toEqual([
      ['actor', s.participants[0].name, 'client'],
      ['file', 'client', 'client'],
      ...s.participants.filter(p => p.kind === 'database' && p.side === 'client').map(p => ['database', p.name, 'client']),
      ['file', 'server', 'server'],
      ...s.participants.filter(p => p.kind === 'database' && p.side === 'server').map(p => ['database', p.name, 'server']),
    ])
    const client = g.participants.findIndex(p => p.id === 'layer:client')
    expect(g.participants[client].members!.sort()).toEqual(s.participants.filter(p => p.kind !== 'actor' && groupOf(p.id) === 'layer:client').map(p => p.id).sort())
    // the same messages, in the same order, selecting the same symbols; a call within the group calls itself
    expect(g.messages.map(m => m.target)).toEqual(s.messages.map(m => m.target))
    expect(g.messages.filter(m => m.from === client && m.to === client).every(m => m.kind !== 'call')).toBe(true)
    expect(g.fragments).toEqual(s.fragments)
    // the network stays between the two sides
    const d = layoutDiagram(g, { viewport: 1000, aspect: 1.6 })
    const server = g.participants.findIndex(p => p.side === 'server')
    expect(d.boundary!.u).toBeGreaterThan(d.columns[server - 1].u)
    expect(d.boundary!.u).toBeLessThan(d.columns[server].u)
    // a file of a group lights its lifeline
    expect(relatedTo('f:ui/Header.tsx', d)?.participants.has(client)).toBe(true)
  })
})
