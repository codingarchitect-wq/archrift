import { describe, expect, it } from 'vitest'
import {
  coverageOf,
  describables,
  hash,
  keyFor,
  parseDescriptions,
  resolveDescriptions,
  serializeDescriptions,
  stamp,
  surfaceOf,
  syncDescriptions,
  todo,
} from '../../src/core/descriptions.ts'
import type { DescriptionsFile } from '../../src/core/descriptions.ts'
import { GraphIndex } from '../../src/core/graph-index.ts'
import type { Graph, GraphEdge, GraphNode } from '../../src/core/model.ts'

const dir = (path: string): GraphNode => ({ id: path ? `d:${path}` : 'd:.', kind: 'directory', name: path.split('/').pop() || '.', path, ...(path ? { parent: path.includes('/') ? `d:${path.slice(0, path.lastIndexOf('/'))}` : 'd:.' } : {}) })
const file = (path: string, loc: number, fanIn = 0, ...tags: string[]): GraphNode => ({
  id: `f:${path}`,
  kind: 'file',
  name: path.split('/').pop()!,
  path,
  parent: `d:${path.slice(0, path.lastIndexOf('/'))}`,
  metrics: { loc, fanIn },
  tags,
})
const sym = (path: string, name: string, signature: string, exported = true, subkind = 'function'): GraphNode => ({ id: `s:${path}#${name}`, kind: 'symbol', name, subkind, path, parent: `f:${path}`, exported, signature, range: [1, 1, 2, 1] })
const uses = (source: string, target: string, kind: GraphEdge['kind'] = 'calls'): GraphEdge => ({ source, target, kind, count: 1, targets: ['web'], confidence: 'exact' })

/** A small app: pages in src/app, a database client in src/lib, a test. */
function app(): Graph {
  return {
    meta: {
      name: 'shop',
      generatedAt: '',
      tool: { name: 'archrift', version: '0' },
      analyzers: [],
      targets: ['web'],
      counts: {},
      timings: {},
      cycles: [],
      features: [{ name: 'orders', routes: ['/orders'], files: 2 }],
      diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 },
    },
    nodes: [
      dir(''),
      dir('src'),
      dir('src/app'),
      dir('src/app/orders'),
      dir('src/lib'),
      file('src/app/orders/page.tsx', 40, 0, 'route:/orders', 'feature:orders'),
      file('src/lib/db.ts', 30, 2, 'feature:orders'),
      file('src/lib/money.ts', 60, 1),
      file('src/lib/db.test.ts', 20, 0, 'test'),
      sym('src/app/orders/page.tsx', 'OrdersPage', 'function OrdersPage(): JSX.Element', true, 'component'),
      sym('src/lib/db.ts', 'query', 'function query(sql: string): Row[]'),
      sym('src/lib/db.ts', 'helper', 'function helper(): void', false),
      sym('src/lib/money.ts', 'format', 'function format(n: number): string'),
    ],
    edges: [uses('s:src/app/orders/page.tsx#OrdersPage', 's:src/lib/db.ts#query'), uses('s:src/lib/db.ts#query', 's:src/lib/money.ts#format'), uses('s:src/app/orders/page.tsx#OrdersPage', 's:src/lib/money.ts#format')],
    sites: [],
  }
}

const withNodes = (g: Graph, change: (nodes: GraphNode[]) => GraphNode[]): Graph => ({ ...g, nodes: change(g.nodes.map(n => ({ ...n }))) })

describe('a descriptions file', () => {
  it('keeps well-formed entries, names the malformed ones, and writes keys sorted', () => {
    const { file: f, problems } = parseDescriptions({ project: ' A shop. ', entries: { 'f:b.ts': { summary: ' B. ', name: ' Bee ' }, 'f:a.ts': { name: 'no summary' }, 'f:c.ts': 'just text' } })
    expect(f).toEqual({ $schema: 'archrift/descriptions@1', project: 'A shop.', entries: { 'f:b.ts': { name: 'Bee', summary: 'B.' } } })
    expect(problems).toEqual(['f:a.ts: needs a "summary"', 'f:c.ts: needs a "summary"'])
    expect(() => parseDescriptions([])).toThrow(/entries/)
    const text = serializeDescriptions({ entries: { 'f:z.ts': { summary: 'Z.' }, 'f:a.ts': { summary: 'A.' } } })
    expect(Object.keys(JSON.parse(text).entries)).toEqual(['f:a.ts', 'f:z.ts'])
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('surfaces', () => {
  it("change with a file's exports and routes, not with what it keeps to itself", () => {
    const g = app()
    const before = surfaceOf(new GraphIndex(g), 'f:src/lib/db.ts')
    const privateChange = withNodes(g, ns => ns.map(n => (n.id === 's:src/lib/db.ts#helper' ? { ...n, signature: 'function helper(x: number): void' } : n)))
    expect(surfaceOf(new GraphIndex(privateChange), 'f:src/lib/db.ts')).toBe(before)
    const exportChange = withNodes(g, ns => ns.map(n => (n.id === 's:src/lib/db.ts#query' ? { ...n, signature: 'function query(sql: string, args: unknown[]): Row[]' } : n)))
    expect(surfaceOf(new GraphIndex(exportChange), 'f:src/lib/db.ts')).not.toBe(before)
    const page = surfaceOf(new GraphIndex(g), 'f:src/app/orders/page.tsx')
    const moved = withNodes(g, ns => ns.map(n => (n.id === 'f:src/app/orders/page.tsx' ? { ...n, tags: ['route:/purchases'] } : n)))
    expect(surfaceOf(new GraphIndex(moved), 'f:src/app/orders/page.tsx')).not.toBe(page)
  })

  it("are a function's signature, and none for folders, features or the project", () => {
    const index = new GraphIndex(app())
    expect(surfaceOf(index, 's:src/lib/db.ts#query')).toMatch(/^[0-9a-f]{16}$/)
    expect(surfaceOf(index, 'd:src/lib')).toBeUndefined()
    expect(surfaceOf(index, 'feature:orders')).toBeUndefined()
    expect(hash('x')).toBe(hash('x'))
    expect(hash('x')).not.toBe(hash('y'))
  })
})

describe('resolving', () => {
  it('marks an entry stale when its surface moved on and names the orphans', () => {
    const g = app()
    const index = new GraphIndex(g)
    const file: DescriptionsFile = {
      project: 'A shop.',
      entries: {
        'f:src/lib/db.ts': stamp(index, 'f:src/lib/db.ts', { name: 'Database', summary: 'Runs queries.' }),
        'd:src/lib': stamp(index, 'd:src/lib', { summary: 'Shared code.' }),
        'feature:orders': { summary: 'Taking orders.' },
        'f:src/gone.ts': { summary: 'Gone.' },
      },
    }
    expect(resolveDescriptions(g, file)).toEqual({
      project: 'A shop.',
      entries: { 'f:src/lib/db.ts': { name: 'Database', summary: 'Runs queries.' }, 'd:src/lib': { summary: 'Shared code.' }, 'feature:orders': { summary: 'Taking orders.' } },
      orphans: ['f:src/gone.ts'],
    })
    const changed = withNodes(g, ns => ns.map(n => (n.id === 's:src/lib/db.ts#query' ? { ...n, signature: 'function query(): void' } : n)))
    expect(resolveDescriptions(changed, file).entries['f:src/lib/db.ts'].stale).toBe(true)
    // a folder never goes stale, whatever moves inside it
    expect(resolveDescriptions(changed, file).entries['d:src/lib'].stale).toBeUndefined()
  })

  it('marks a block of the files right in a folder above other blocks: its words are not the whole folder’s', () => {
    // src holds proxy.ts beside the src/app and src/lib blocks: the block `src` is that one file
    const g = withNodes(app(), ns => [...ns, file('src/proxy.ts', 20)])
    expect(describables(g).filter(i => i.level === 'block').map(i => i.key)).toContain('d:src')
    const resolved = resolveDescriptions(g, {
      entries: { 'd:src': { name: 'Request guard', summary: 'src/proxy.ts guards the routes.' }, 'd:src/lib': { name: 'Core logic', summary: 'Shared code.' } },
    })
    expect(resolved.entries['d:src']).toEqual({ name: 'Request guard', summary: 'src/proxy.ts guards the routes.', ownFiles: true })
    // a block holding its whole folder is the folder
    expect(resolved.entries['d:src/lib']).toEqual({ name: 'Core logic', summary: 'Shared code.' })
    // without a file of its own, src is no block: its entry describes the whole folder
    expect(resolveDescriptions(app(), { entries: { 'd:src': { summary: 'The app.' } } }).entries['d:src']).toEqual({ summary: 'The app.' })
  })

  it('finds what an argument names: a file, a folder, a feature, an id or the project', () => {
    const g = app()
    const index = new GraphIndex(g)
    expect(keyFor(g, index, 'src/lib/db.ts')).toBe('f:src/lib/db.ts')
    expect(keyFor(g, index, './src/lib/')).toBe('d:src/lib')
    expect(keyFor(g, index, '.')).toBe('d:.')
    expect(keyFor(g, index, 'feature:orders')).toBe('feature:orders')
    expect(keyFor(g, index, 'feature:billing')).toBeUndefined()
    expect(keyFor(g, index, 's:src/lib/db.ts#query')).toBe('s:src/lib/db.ts#query')
    expect(keyFor(g, index, 'project')).toBe('project')
    expect(keyFor(g, index, 'src/nope.ts')).toBeUndefined()
  })
})

describe('sync', () => {
  const contents: Record<string, string> = { 'src/lib/db.ts': 'sha1:db', 'src/lib/money.ts': 'sha1:money', 'src/app/orders/page.tsx': 'sha1:page' }

  it('carries a moved file by its content, its functions along, a renamed folder by its name, and drops the rest', () => {
    const g = app()
    const index = new GraphIndex(g)
    const file: DescriptionsFile = {
      entries: {
        'f:src/db.ts': { summary: 'Runs queries.', surface: 'old', content: 'sha1:db' },
        's:src/db.ts#query': { summary: 'One query.', surface: surfaceOf(index, 's:src/lib/db.ts#query') },
        'd:lib': { summary: 'Shared code.' },
        'f:src/deleted.ts': { summary: 'Deleted.', content: 'sha1:none' },
        'feature:billing': { summary: 'Gone feature.' },
      },
    }
    const r = syncDescriptions(g, file, p => contents[p])
    expect(r.moved).toEqual([
      ['f:src/db.ts', 'f:src/lib/db.ts'],
      ['s:src/db.ts#query', 's:src/lib/db.ts#query'],
      ['d:lib', 'd:src/lib'],
    ])
    expect(r.dropped).toEqual(['f:src/deleted.ts', 'feature:billing'])
    expect(Object.keys(r.file.entries).sort()).toEqual(['d:src/lib', 'f:src/lib/db.ts', 's:src/lib/db.ts#query'])
    expect(r.file.entries['f:src/lib/db.ts'].summary).toBe('Runs queries.')
  })

  it('carries a renamed file by its name and exports when its content changed too, and stamps entries written by hand', () => {
    const g = app()
    const index = new GraphIndex(g)
    const file: DescriptionsFile = {
      entries: {
        'f:old/money.ts': { summary: 'Formats money.', surface: surfaceOf(index, 'f:src/lib/money.ts'), content: 'sha1:before' },
        'f:src/lib/db.ts': { summary: 'Runs queries.' },
      },
    }
    const r = syncDescriptions(g, file, p => contents[p])
    expect(r.moved).toEqual([['f:old/money.ts', 'f:src/lib/money.ts']])
    expect(r.stamped).toEqual(['f:src/lib/db.ts'])
    expect(r.file.entries['f:src/lib/db.ts']).toEqual({ summary: 'Runs queries.', surface: surfaceOf(index, 'f:src/lib/db.ts'), content: 'sha1:db' })
    // stamped: no longer stale-able by accident, and the moved one isn't stamped again
    expect(syncDescriptions(g, r.file, p => contents[p]).stamped).toEqual([])
  })
})

describe('what to describe', () => {
  it('lists the project, blocks, features, folders and production files, most worth it first, tests left out', () => {
    const items = describables(app())
    expect(items.map(i => `${i.level} ${i.key}`)).toEqual([
      'project project',
      'block d:src/lib',
      'block d:src/app',
      'feature feature:orders',
      'folder d:src/app/orders',
      'file f:src/lib/db.ts',
      'file f:src/lib/money.ts',
      'file f:src/app/orders/page.tsx',
    ])
  })

  it('counts coverage per level and puts stale entries before missing ones', () => {
    const g = app()
    const index = new GraphIndex(g)
    const resolved = resolveDescriptions(g, {
      entries: {
        'd:src/lib': { summary: 'Shared code.' },
        'f:src/lib/money.ts': { summary: 'Formats money.', surface: 'not-any-more' },
      },
    })
    expect(coverageOf(describables(g), resolved).find(c => c.level === 'file')).toEqual({ level: 'file', described: 1, total: 3, stale: 1 })
    const t = todo(g, resolved, { max: 4 }, index)
    expect(t.total).toBe(7)
    expect(t.items.map(i => `${i.key} ${i.why}`)).toEqual(['project missing', 'd:src/app missing', 'feature:orders missing', 'd:src/app/orders missing'])
    const files = todo(g, resolved, { scope: 'src/lib' }, index).items
    expect(files.map(i => `${i.key} ${i.why}`)).toEqual(['f:src/lib/money.ts stale', 'f:src/lib/db.ts missing'])
    expect(files[0].current).toEqual({ summary: 'Formats money.', stale: true })
  })

  it('gives each a digest: exports, routes, what it uses and who uses it, with their descriptions', () => {
    const g = app()
    const resolved = resolveDescriptions(g, { entries: { 'f:src/lib/money.ts': { summary: 'Formats money.' } } })
    const [db] = todo(g, resolved, { scope: 'src/lib/db.ts' }).items
    expect(db.digest).toMatchObject({
      kind: 'file',
      path: 'src/lib/db.ts',
      lines: 30,
      exports: [{ name: 'query', kind: 'function', signature: 'function query(sql: string): Row[]' }],
      uses: [{ path: 'src/lib/money.ts', described: 'Formats money.' }],
      usedBy: [{ path: 'src/app/orders/page.tsx' }],
      usedByCount: 1,
    })
    const [page] = todo(g, resolved, { scope: 'src/app/orders/page.tsx' }).items
    expect(page.digest.routes).toEqual(['route:/orders'])
    const feature = todo(g, resolved).items.find(i => i.key === 'feature:orders')!
    expect(feature.digest).toMatchObject({ kind: 'feature', routes: ['/orders'], contents: [{ path: 'src/app/orders/page.tsx', lines: 40 }, { path: 'src/lib/db.ts', lines: 30 }] })
  })
})
