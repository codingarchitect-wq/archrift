import { describe, expect, it } from 'vitest'
import { GraphIndex } from '../../../src/core/graph-index.ts'
import type { EdgeKind, Graph, GraphEdge, GraphNode } from '../../../src/core/model.ts'
import { overview } from '../../../src/server/views.ts'
import { autoLayers } from '../../../src/core/auto-layers.ts'
import { MAX_LINES, buildNetwork, pairKinds, stationName } from '../../../src/viewer/views/transit/network.ts'
import type { Network } from '../../../src/viewer/views/transit/network.ts'
import { ROW, routeBetween, schematic } from '../../../src/viewer/views/transit/schematic.ts'
import { World, depGraph } from '../../../src/viewer/world.ts'
import { analyzeFixture } from '../../helpers/fixtures.ts'

/** The network the view builds: tests hidden, every edge kind, configured layers or ones derived from dependencies. */
function networkOf(world: World, layering: 'config' | 'auto'): Network {
  const files = world.graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test'))
  const ids = new Set(files.map(f => f.id))
  const g = depGraph(world, `test|${layering}`, [], 'default', id => ids.has(id))
  let order: string[]
  let layerOf: (n: GraphNode) => string | undefined
  if (layering === 'config') {
    order = world.graph.meta.layers ?? []
    layerOf = n => n.tags?.find(t => t.startsWith('layer:'))?.slice(6)
  } else {
    const areas = [...new Set(files.map(f => world.areaOf.get(f.id)!))]
    const edges = [...g.out].flatMap(([a, targets]) => targets.map(b => ({ source: world.areaOf.get(a)!, target: world.areaOf.get(b)! })))
    const auto = autoLayers(areas, edges, id => world.node(id)?.path ?? id)
    order = auto.order
    layerOf = n => auto.layerOfArea.get(world.areaOf.get(n.id) ?? '')
  }
  return buildNetwork({ files, out: g.out, in: g.in, weight: g.weight, kinds: pairKinds(world.graph.edges, 'default'), order, layerOf })
}

type EdgeSpec = [source: string, kind: EdgeKind, target: string, count?: number, subkind?: string]

/** A file-level graph: files by path (with tags), directories made up, edges between paths. */
function graphOf(files: [string, ...string[]][], edges: EdgeSpec[], layers?: string[]): Graph {
  const nodes = new Map<string, GraphNode>([['d:.', { id: 'd:.', kind: 'directory', name: 'root', path: '' }]])
  for (const [path, ...tags] of files) {
    const parts = path.split('/')
    let parent = 'd:.'
    for (let i = 1; i < parts.length; i++) {
      const dir = `d:${parts.slice(0, i).join('/')}`
      if (!nodes.has(dir)) nodes.set(dir, { id: dir, kind: 'directory', name: parts[i - 1], parent, path: parts.slice(0, i).join('/') })
      parent = dir
    }
    nodes.set(`f:${path}`, { id: `f:${path}`, kind: 'file', name: parts.at(-1)!, parent, path, tags, metrics: { loc: 50 } })
  }
  return {
    meta: {
      name: 'hand-made',
      generatedAt: '',
      tool: { name: 'archrift', version: '0' },
      analyzers: [],
      targets: ['default'],
      layers,
      counts: {},
      timings: {},
      cycles: [],
      diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 },
    },
    nodes: [...nodes.values()],
    edges: edges.map(
      ([s, kind, t, count = 1, subkind]): GraphEdge => ({ source: `f:${s}`, target: `f:${t}`, kind, count, targets: ['default'], confidence: 'exact', ...(subkind ? { subkind } : {}) }),
    ),
    sites: [],
  }
}

const short = (ids: string[]) => ids.map(id => id.replace(/^f:/, ''))

describe('lines on the fullstack fixture', async () => {
  const world = new World(overview(new GraphIndex(await analyzeFixture('fullstack'))))
  const network = networkOf(world, 'auto')
  const line = (name: string) => network.lines.find(l => l.name === name)!

  it('start at the pages with dependencies, named by their routes', () => {
    expect(network.entries).toBe(4) // /, /accounts, /accounts/[id], /api/health
    // the account page and the health check depend on nothing: no line
    expect(network.lines.map(l => l.name)).toEqual(['/accounts', '/'])
    expect(line('/accounts').id).toBe('f:src/app/(shop)/accounts/page.tsx')
  })

  it('follow the request down the layers: client service, tRPC router, Prisma schema', () => {
    expect(short(line('/accounts').stations)).toEqual(['src/app/(shop)/accounts/page.tsx', 'src/client/service.ts', 'src/server/routers/accounts.ts', 'prisma/schema.prisma'])
    expect(line('/accounts').end).toBe('data')
    // the stations' columns only ever move right
    const columns = line('/accounts').stations.map(id => network.column.get(id)!)
    expect(columns).toEqual([...columns].sort((a, b) => a - b))
  })

  it('go as far down as they can without data, and not along an href or a type', () => {
    expect(short(line('/').stations)).toEqual(['src/app/page.tsx', 'src/ui/ThemeContext.tsx', 'src/lib/fake-libs.ts'])
    expect(line('/').end).toBe('none')
    // client/trpc.ts only has types from the server: never a station
    expect(network.column.has('f:src/client/trpc.ts')).toBe(false)
  })

  it('have no interchanges here: the two lines share nothing', () => {
    const map = schematic(network.lines, network.column, network.columns)
    expect([...map.stations.values()].filter(s => s.interchange)).toEqual([])
    expect(map.stations.size).toBe(7)
  })
})

// app → components → hooks → server → lib, the Prisma schema outside every layer. Two pages
// reach their data through a shared hook, which reads local data (Dexie) or calls the server.
const SHOP = graphOf(
  [
    ['app/a/page.tsx', 'layer:app', 'route:/a'],
    ['app/b/page.tsx', 'layer:app', 'route:/b'],
    ['app/c/page.tsx', 'layer:app', 'route:/c'],
    ['app/api/health/route.ts', 'layer:app', 'api:/api/health'],
    ['components/A.tsx', 'layer:components'],
    ['components/B.tsx', 'layer:components'],
    ['hooks/index.ts', 'layer:hooks'],
    ['hooks/useData.ts', 'layer:hooks'],
    ['hooks/useAuth.ts', 'layer:hooks'],
    ['server/router.ts', 'layer:server'],
    ['lib/local.ts', 'layer:lib'],
    ['lib/cloud.ts', 'layer:lib'],
    ['lib/db.ts', 'layer:lib'],
    ['lib/utils.ts', 'layer:lib'],
    ['lib/types.ts', 'layer:lib'],
    ['prisma/schema.prisma', 'prisma-schema', 'prisma'],
    ['tests/a.test.ts', 'test'],
  ],
  [
    ['app/a/page.tsx', 'renders', 'components/A.tsx', 5],
    ['app/a/page.tsx', 'imports', 'hooks/index.ts', 30], // a barrel: passed through, however heavy
    ['app/a/page.tsx', 'calls', 'lib/utils.ts', 3],
    ['app/a/page.tsx', 'type-ref', 'lib/types.ts', 40], // types carry no request
    ['app/a/page.tsx', 'navigates', 'app/b/page.tsx', 4],
    ['app/b/page.tsx', 'renders', 'components/B.tsx', 3],
    ['app/b/page.tsx', 'calls', 'hooks/useData.ts', 1],
    ['app/api/health/route.ts', 'imports', 'lib/types.ts', 1, 'type-only'],
    ['components/A.tsx', 'calls', 'hooks/useData.ts', 3],
    ['components/A.tsx', 'calls', 'lib/utils.ts', 2],
    ['components/B.tsx', 'calls', 'hooks/useData.ts', 2],
    ['hooks/index.ts', 're-exports', 'hooks/useData.ts'],
    ['hooks/index.ts', 're-exports', 'hooks/useAuth.ts'],
    ['hooks/useData.ts', 'instantiates', 'lib/local.ts', 2],
    ['hooks/useData.ts', 'instantiates', 'lib/cloud.ts', 1],
    ['lib/local.ts', 'queries', 'lib/db.ts', 40],
    ['lib/db.ts', 'calls', 'lib/utils.ts', 5], // data ends a line even when it depends on more
    ['lib/cloud.ts', 'rpc-call', 'server/router.ts', 2],
    ['lib/cloud.ts', 'calls', 'lib/utils.ts', 1],
    ['server/router.ts', 'queries', 'prisma/schema.prisma', 9],
    ['tests/a.test.ts', 'calls', 'app/a/page.tsx', 1],
  ],
  ['app', 'components', 'hooks', 'server', 'lib'],
)

describe('lines on a hand-made graph', () => {
  const network = networkOf(new World(SHOP), 'config')
  const line = (name: string) => network.lines.find(l => l.name === name)!

  it('take the heaviest way to data, passing barrels by and ending where data is read', () => {
    expect(network.lines.map(l => l.name)).toEqual(['/a', '/b'])
    expect(short(line('/a').stations)).toEqual(['app/a/page.tsx', 'components/A.tsx', 'hooks/useData.ts', 'lib/local.ts', 'lib/db.ts'])
    expect(short(line('/b').stations)).toEqual(['app/b/page.tsx', 'components/B.tsx', 'hooks/useData.ts', 'lib/local.ts', 'lib/db.ts'])
    expect(network.column.has('f:hooks/index.ts')).toBe(false)
    expect(network.column.has('f:lib/types.ts')).toBe(false)
  })

  it('fork towards other data: the server call to the Prisma schema, which sits in a column of its own', () => {
    expect(line('/a').branches.map(short)).toEqual([['hooks/useData.ts', 'lib/cloud.ts', 'server/router.ts', 'prisma/schema.prisma']])
    expect(network.columns).toEqual(['app', 'components', 'hooks', 'server', 'lib', 'data'])
    expect(network.column.get('f:prisma/schema.prisma')).toBe(5)
    // the call goes back left, from lib to the server: that's where the request travels
    expect(network.column.get('f:server/router.ts')).toBeLessThan(network.column.get('f:lib/cloud.ts')!)
  })

  it('make every station of two lines an interchange', () => {
    const map = schematic(network.lines, network.column, network.columns)
    const interchanges = [...map.stations.values()].filter(s => s.interchange).map(s => s.id)
    expect(short(interchanges).sort()).toEqual(['hooks/useData.ts', 'lib/cloud.ts', 'lib/db.ts', 'lib/local.ts', 'prisma/schema.prisma', 'server/router.ts'])
    for (const s of map.stations.values()) expect(s.radius > 1).toBe(s.interchange)
  })

  it('start at entry points when there are no routes, and at top files nothing uses when there are none', () => {
    const tagged = graphOf(
      [
        ['cli/main.ts', 'layer:top', 'entrypoint'],
        ['cli/other.ts', 'layer:top'],
        ['core/run.ts', 'layer:core'],
      ],
      [
        ['cli/main.ts', 'calls', 'core/run.ts', 3],
        ['cli/other.ts', 'calls', 'core/run.ts', 3],
      ],
      ['top', 'core'],
    )
    const withEntry = networkOf(new World(tagged), 'config')
    expect(withEntry.lines.map(l => [l.name, short(l.stations)])).toEqual([['main', ['cli/main.ts', 'core/run.ts']]])
    const untagged = new World({ ...tagged, nodes: tagged.nodes.map(n => ({ ...n, tags: n.tags?.filter(t => t !== 'entrypoint') })) })
    expect(networkOf(untagged, 'config').lines.map(l => l.name)).toEqual(['main', 'other'])
  })

  it('names stations by file, index files by folder', () => {
    expect(stationName({ id: 'f:src/lib/local-db.ts', kind: 'file', name: 'local-db.ts', path: 'src/lib/local-db.ts' })).toBe('local-db')
    expect(stationName({ id: 'f:src/server/routers/index.ts', kind: 'file', name: 'index.ts', path: 'src/server/routers/index.ts' })).toBe('routers/index')
    expect(stationName({ id: 'f:prisma/schema.prisma', kind: 'file', name: 'schema.prisma', path: 'prisma/schema.prisma' })).toBe('schema.prisma')
  })
})

describe('the schematic map', () => {
  const network = networkOf(new World(SHOP), 'config')

  it('is deterministic', () => {
    const plain = (m: ReturnType<typeof schematic>) => JSON.stringify({ ...m, stations: [...m.stations] })
    expect(plain(schematic(network.lines, network.column, network.columns))).toEqual(plain(schematic(network.lines, network.column, network.columns)))
  })

  it('puts no two stations on one grid point, and every station in its layer’s column', () => {
    const map = schematic(network.lines, network.column, network.columns)
    const points = [...map.stations.values()].map(s => `${s.slot}:${s.row}`)
    expect(new Set(points).size).toBe(points.length)
    for (const s of map.stations.values()) {
      const band = map.bands[network.column.get(s.id)!]
      expect(s.x).toBeGreaterThan(band.x0)
      expect(s.x).toBeLessThan(band.x1)
    }
    // a line staying in one layer takes the next slot of its column
    const local = map.stations.get('f:lib/local.ts')!
    const db = map.stations.get('f:lib/db.ts')!
    expect(db.slot).toBe(local.slot + 1)
  })

  it('gives each line a lane, neighbors for lines that meet, and an interchange between them', () => {
    const map = schematic(network.lines, network.column, network.columns)
    expect(Math.abs(map.lanes[0] - map.lanes[1])).toBeLessThanOrEqual(2) // a branch lane may sit between them
    const hook = map.stations.get('f:hooks/useData.ts')!
    expect(hook.row).toBeGreaterThanOrEqual(Math.min(...map.lanes))
    expect(hook.row).toBeLessThanOrEqual(Math.max(...map.lanes) + 1)
    // lines sharing a stretch run side by side: distinct polylines
    const shared = map.segments.filter(s => s.from === 'f:hooks/useData.ts' && s.to === 'f:lib/local.ts')
    expect(shared.length).toBe(2)
    expect(shared[0].points).not.toEqual(shared[1].points)
  })

  it('routes run straight, diagonal at 45° or vertical', () => {
    const cases: [[number, number], [number, number]][] = [
      [[0, 0], [30, 0]],
      [[0, 0], [30, 10]],
      [[0, 0], [-20, 15]],
      [[0, 0], [10, 40]],
    ]
    for (const [a, b] of cases)
      for (const bend of [0, 0.3, 0.5, 1]) {
        const route = routeBetween(a, b, bend)
        expect(route[0]).toEqual(a)
        expect(route.at(-1)).toEqual(b)
        for (let i = 1; i < route.length; i++) {
          const dx = Math.abs(route[i][0] - route[i - 1][0])
          const dz = Math.abs(route[i][1] - route[i - 1][1])
          expect(dx < 1e-9 || dz < 1e-9 || Math.abs(dx - dz) < 1e-9).toBe(true)
        }
      }
  })

  it('moves a line around a station it would otherwise seem to stop at', () => {
    const map = schematic(network.lines, network.column, network.columns)
    for (const seg of map.segments)
      for (const s of map.stations.values()) {
        if (s.id === seg.from || s.id === seg.to) continue
        const near = seg.points.some((p, i) => {
          if (!i) return false
          const [ax, az] = seg.points[i - 1]
          const [dx, dz] = [p[0] - ax, p[1] - az]
          const t = Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.z - az) * dz) / (dx * dx + dz * dz || 1)))
          return Math.hypot(s.x - ax - t * dx, s.z - az - t * dz) < ROW * 0.3
        })
        expect(near, `${seg.from} → ${seg.to} passes ${s.id}`).toBe(false)
      }
  })
})

describe('at scale', () => {
  // 10,000 files in five layers, 300 pages, six dependencies each, 40 files querying two databases
  const layers = ['app', 'components', 'hooks', 'server', 'lib']
  let seed = 7
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const files: [string, ...string[]][] = []
  const edges: EdgeSpec[] = []
  const pathOf = (i: number) => `${layers[Math.floor(i / 2000)]}/d${Math.floor((i % 2000) / 25)}/f${i}.ts`
  for (let i = 0; i < 10_000; i++) {
    const layer = Math.floor(i / 2000)
    files.push([pathOf(i), `layer:${layers[layer]}`, ...(i < 300 ? [`route:/page${i}`] : [])])
    if (layer < 4) for (let k = 0; k < 6; k++) edges.push([pathOf(i), 'calls', pathOf(2000 * (layer + 1) + Math.floor(random() * (10_000 - 2000 * (layer + 1)))), 1 + Math.floor(random() * 6)])
  }
  for (let k = 0; k < 40; k++) edges.push([pathOf(8000 + k * 37), 'queries', pathOf(9990 + (k % 2)), 5])
  const world = new World(graphOf(files, edges, layers))

  it('keeps the lines few and short, fast', () => {
    const t0 = performance.now()
    const network = networkOf(world, 'config')
    const map = schematic(network.lines, network.column, network.columns) // every line shown: the most the map ever holds
    const ms = performance.now() - t0
    expect(network.entries).toBe(300)
    expect(network.lines.length).toBe(MAX_LINES)
    for (const l of network.lines) {
      expect(l.stations.length).toBeLessThanOrEqual(9)
      expect(l.branches.length).toBeLessThanOrEqual(2)
      for (const b of l.branches) expect(b.length).toBeLessThanOrEqual(4)
    }
    expect(network.lines.filter(l => l.end === 'data').length).toBeGreaterThan(0)
    const points = [...map.stations.values()].map(s => `${s.slot}:${s.row}`)
    expect(new Set(points).size).toBe(points.length)
    expect(ms).toBeLessThan(3000)
  })
})
