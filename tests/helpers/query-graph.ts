// A small app as a graph, for the query and diff tests: pages in src/app, a
// client in src/lib, a database in src/server; each file's ways (`js.http=trpc`)
// and dependencies given, rules evaluated and cycles found as the analyzer does.
import { coherenceModel, fileLinks } from '../../src/core/coherence.ts'
import type { CoherenceModel } from '../../src/core/coherence.ts'
import type { ConcernMeta, EdgeKind, Graph, GraphEdge, GraphNode } from '../../src/core/model.ts'
import { evaluateRules, importCycles, summarize } from '../../src/core/rules.ts'
import type { Rule } from '../../src/core/rules.ts'

export const HTTP: ConcernMeta = {
  id: 'js.http',
  label: 'HTTP calls',
  stack: 'JS',
  about: 'calling a server',
  paradigms: [
    { id: 'fetch', label: 'fetch' },
    { id: 'axios', label: 'axios' },
    { id: 'trpc', label: 'tRPC client' },
  ],
}

export const DATES: ConcernMeta = {
  id: 'js.dates',
  label: 'Dates',
  stack: 'JS',
  about: 'date arithmetic, parsing and formatting',
  paradigms: [
    { id: 'moment', label: 'Moment.js', legacy: true },
    { id: 'date-fns', label: 'date-fns' },
  ],
}

export const LAYERS = ['app', 'lib', 'server']

export const RULES: Rule[] = [
  { name: 'no-app-to-server', description: 'Pages go through the client.', forbid: { from: 'src/app/**', to: 'src/server/**' } },
  { name: 'layers-down', severity: 'warn', layers: 'down' },
  { name: 'no-cycles', cycles: 'forbid' },
]

/** A file's layer and block: its second folder (src/app → app, block src/app). */
export const layerOf = (path: string) => LAYERS.find(l => path.startsWith(`src/${l}/`))
export const blockOf = (path: string) => path.split('/').slice(0, 2).join('/')
export const tagsFor = (path: string) => (layerOf(path) ? [`layer:${layerOf(path)}`] : [])

export interface AppFile {
  path: string
  /** `concern=way` pairs. */
  ways?: string[]
  /** Files it imports (and calls). */
  uses?: string[]
  /** More tags: `test`, `route:/x`, `feature:x` … */
  tags?: string[]
  /** Its functions and classes by name (a member as `Store.load`): nodes `s:<path>#<name>`. */
  symbols?: string[]
  /** Other dependencies, with their kind and sites. */
  links?: AppLink[]
}

export interface AppLink {
  /** One of the file's symbols (by name); the file itself when absent. */
  from?: string
  /** A node id: `f:…`, `s:…#…`, or a package's `x:npm:…` (added as an external). */
  to: string
  kind: EdgeKind
  /** Where its references are: line, column, line, column … */
  sites?: number[]
}

const symbolNodes = (f: AppFile): GraphNode[] =>
  (f.symbols ?? []).map(name => {
    const owner = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : undefined
    return { id: `s:${f.path}#${name}`, kind: owner ? 'member' : 'symbol', subkind: owner ? 'method' : 'function', name: name.split('.').pop()!, parent: owner ? `s:${f.path}#${owner}` : `f:${f.path}`, path: f.path }
  })

const linkEdge = (f: AppFile, l: AppLink): GraphEdge => ({
  source: l.from ? `s:${f.path}#${l.from}` : `f:${f.path}`,
  target: l.to,
  kind: l.kind,
  ...(l.kind === 'imports' || l.kind === 're-exports' ? { subkind: 'static' } : {}),
  count: 1,
  targets: ['default'],
  confidence: 'exact',
})

export function appGraph(files: AppFile[], rules: Rule[] = RULES): Graph {
  const links = files.flatMap(f => (f.links ?? []).map(l => ({ edge: linkEdge(f, l), sites: l.sites ?? [] })))
  const externals = [...new Set(links.map(l => l.edge.target).filter(id => id.startsWith('x:')))].map((id): GraphNode => ({ id, kind: 'external', name: id.replace(/^x:\w+:/, '') }))
  const nodes: GraphNode[] = [
    ...files.map((f): GraphNode => ({
      id: `f:${f.path}`,
      kind: 'file',
      name: f.path.split('/').pop()!,
      path: f.path,
      tags: [...tagsFor(f.path), ...(f.tags ?? []), ...(f.ways ?? []).map(w => `paradigm:${w}`)],
      metrics: { loc: 10 },
    })),
    ...files.flatMap(symbolNodes),
    ...externals,
  ]
  const uses: GraphEdge[] = files.flatMap(f =>
    (f.uses ?? []).flatMap(u => [
      { source: `f:${f.path}`, target: `f:${u}`, kind: 'imports' as const, subkind: 'static', count: 1, targets: ['default'], confidence: 'exact' as const },
      { source: `f:${f.path}`, target: `f:${u}`, kind: 'calls' as const, count: 1, targets: ['default'], confidence: 'exact' as const },
    ]),
  )
  const edges = [...uses, ...links.map(l => l.edge)]
  // parallel to the edges, when some link says where it is
  const sites = links.some(l => l.sites.length) ? [...uses.map(() => []), ...links.map(l => l.sites)] : []
  const graph: Graph = {
    meta: {
      name: 'app',
      generatedAt: '',
      tool: { name: 'archrift', version: 'test' },
      analyzers: [],
      targets: ['default'],
      layers: LAYERS,
      concerns: [HTTP, DATES],
      counts: {},
      timings: {},
      cycles: [],
      diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 },
    },
    nodes,
    edges,
    sites,
  }
  graph.meta.cycles = importCycles(graph)
  graph.meta.rules = rules.map(r => summarize(r, graph))
  graph.meta.violations = evaluateRules(graph, rules)
  return graph
}

/**
 * An app for impact: money.ts's format uses its own round, report.ts uses format, parse-user.ts
 * only parse; a chart, a page and an API route above them; a barrel (index.ts) a page imports and a
 * page linking to another; tests (two mock a file), a test helper; money.ts and tax.ts use a package.
 */
export const IMPACT_FILES: AppFile[] = [
  {
    path: 'src/lib/money.ts',
    symbols: ['format', 'round', 'parse'],
    links: [
      { from: 'format', to: 's:src/lib/money.ts#round', kind: 'calls' },
      { to: 'x:npm:@acme/decimal', kind: 'imports' },
    ],
  },
  { path: 'src/lib/tax.ts', links: [{ to: 'x:npm:@acme/decimal', kind: 'imports' }] },
  {
    path: 'src/lib/report.ts',
    symbols: ['build'],
    links: [
      { to: 'f:src/lib/money.ts', kind: 'imports', sites: [1, 1] },
      { from: 'build', to: 's:src/lib/money.ts#format', kind: 'calls', sites: [7, 3, 5, 10] },
    ],
  },
  {
    path: 'src/lib/parse-user.ts',
    symbols: ['readUser'],
    links: [
      { to: 'f:src/lib/money.ts', kind: 'imports', sites: [2, 1] },
      { from: 'readUser', to: 's:src/lib/money.ts#parse', kind: 'calls', sites: [9, 5] },
    ],
  },
  { path: 'src/lib/index.ts', links: [{ to: 'f:src/lib/report.ts', kind: 're-exports' }] },
  {
    path: 'src/components/Chart.tsx',
    tags: ['feature:reports'],
    symbols: ['Chart'],
    links: [
      { to: 'f:src/lib/report.ts', kind: 'imports' },
      { from: 'Chart', to: 's:src/lib/report.ts#build', kind: 'calls' },
    ],
  },
  {
    path: 'src/app/reports/page.tsx',
    tags: ['entrypoint', 'route:/reports', 'feature:reports'],
    links: [
      { to: 'f:src/components/Chart.tsx', kind: 'imports' },
      { to: 's:src/components/Chart.tsx#Chart', kind: 'renders' },
    ],
  },
  { path: 'src/app/api/export/route.ts', tags: ['entrypoint', 'api:/api/export', 'feature:export'], uses: ['src/lib/report.ts'] },
  {
    path: 'src/app/other/page.tsx',
    tags: ['entrypoint', 'route:/other'],
    links: [
      { to: 'f:src/lib/index.ts', kind: 'imports' },
      { to: 'f:src/app/reports/page.tsx', kind: 'navigates', sites: [12, 8] },
    ],
  },
  { path: 'tests/report.test.ts', tags: ['test'], uses: ['src/lib/report.ts'] },
  { path: 'tests/money.test.ts', tags: ['test'], links: [{ to: 'f:src/lib/money.ts', kind: 'mocks' }] },
  { path: 'tests/export.test.ts', tags: ['test'], links: [{ to: 'f:src/lib/report.ts', kind: 'mocks' }] },
  {
    path: 'tests/helpers/factories.ts',
    tags: ['test'],
    symbols: ['amount'],
    links: [
      { to: 'f:src/lib/money.ts', kind: 'imports' },
      { from: 'amount', to: 's:src/lib/money.ts#round', kind: 'calls' },
    ],
  },
  { path: 'tests/chart.test.ts', tags: ['test'], uses: ['src/components/Chart.tsx', 'tests/helpers/factories.ts'] },
]

export function coherenceOfApp(graph: Graph): CoherenceModel {
  const files = graph.nodes.filter(n => n.kind === 'file')
  return coherenceModel({ files, concerns: graph.meta.concerns!, links: fileLinks(graph), blockOf: f => blockOf(f.path!) })
}
