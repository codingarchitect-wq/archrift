// Turns per-file fragments into one Graph: directories and
// external nodes, import edges per target, reference edges, then metrics,
// import cycles and dead exports.
import { fileLevel, liftEdges } from '../core/aggregate.ts'
import { fanInOut } from '../core/algorithms.ts'
import { GraphIndex } from '../core/graph-index.ts'
import { ROOT_ID, dirId, excludedId, fileId, parentDir } from '../core/ids.ts'
import { findFeatures } from '../core/features.ts'
import { tagParadigms } from './coherence/paradigms.ts'
import { applyRules, importCycles } from '../core/rules.ts'
import { DEPENDENCY_KINDS } from '../core/model.ts'
import type { EdgeKind, Graph, GraphEdge, GraphMeta, GraphNode, Sites } from '../core/model.ts'
import { pathTags } from './config.ts'
import type { Config, Target } from './config.ts'
import type { FileFragment, ResolvedTarget } from './fragment.ts'
import type { AssembleApi, Plugin } from './plugins/types.ts'

export interface AssembleInput {
  name: string
  fragments: FileFragment[]
  config: Config
  targets: Target[]
  analyzers: GraphMeta['analyzers']
  tool: GraphMeta['tool']
  /** Lines of a text asset (css, json, …), undefined for binary or unreadable files. */
  assetLoc: (relPath: string) => number | undefined
  /** Absolute root, and a way to read a text file under it (plugins: the Prisma schema). */
  root: string
  readText: (relPath: string) => string | undefined
  /** Every file of the project (plugins reading configuration files). */
  files?: () => string[]
  plugins?: readonly Plugin[]
  timings: Record<string, number>
  cacheStats?: GraphMeta['cache']
}

/** Structural edges are found from both sides of a class hierarchy: keep one, don't add. */
const MAX_MERGED = new Set<EdgeKind>(['implements', 'overrides'])

export function assemble(input: AssembleInput): Graph {
  const { config, fragments } = input
  const targetNames = input.targets.map(t => t.name)
  const tagsOf = pathTags(config)
  const nodes = new Map<string, GraphNode>()
  const diagnostics: GraphMeta['diagnostics'] = { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 }

  nodes.set(ROOT_ID, { id: ROOT_ID, kind: 'directory', name: input.name, path: '' })
  const ensureDir = (path: string): string => {
    const id = dirId(path)
    if (!nodes.has(id)) {
      const parent = ensureDir(parentDir(path))
      nodes.set(id, { id, kind: 'directory', name: path.slice(path.lastIndexOf('/') + 1), parent, path })
    }
    return id
  }
  const addFileNode = (path: string, tags: string[], metrics: Record<string, number>) => {
    tags.push(...tagsOf(path))
    nodes.set(fileId(path), {
      id: fileId(path),
      kind: 'file',
      name: path.slice(path.lastIndexOf('/') + 1),
      parent: ensureDir(parentDir(path)),
      path,
      ...(tags.length ? { tags } : {}),
      metrics,
    })
  }

  for (const f of fragments) {
    addFileNode(f.path, [...f.tags, f.language], { loc: f.loc, complexity: f.complexity, symbols: f.symbols.filter(s => s.kind === 'symbol').length })
    diagnostics.unresolvedIdentifiers += f.unresolvedIdentifiers
    for (const s of f.symbols) {
      const n: GraphNode = { id: s.id, kind: s.kind, name: s.name, subkind: s.subkind, parent: s.parent, path: f.path, range: s.range }
      if (s.exported) n.exported = true
      if (s.signature) n.signature = s.signature
      if (s.tags.length) n.tags = [...s.tags]
      n.metrics = { loc: s.loc, complexity: s.complexity }
      nodes.set(s.id, n)
    }
  }

  const nodeFor = (r: ResolvedTarget): string | undefined => {
    switch (r.kind) {
      case 'file': {
        // a project file without a fragment (the program didn't load it)
        const id = fileId(r.path)
        return nodes.has(id) ? id : undefined
      }
      case 'asset': {
        const id = fileId(r.path)
        if (!nodes.has(id)) {
          const loc = input.assetLoc(r.path)
          addFileNode(r.path, ['asset'], loc === undefined ? {} : { loc })
        }
        return id
      }
      case 'excluded': {
        const id = excludedId(r.path)
        if (!nodes.has(id)) nodes.set(id, { id, kind: 'external', name: r.path, tags: ['excluded'] })
        return id
      }
      case 'external': {
        if (!nodes.has(r.id)) {
          const [, kind, name] = /^x:([^:]+):(.*)$/.exec(r.id)!
          nodes.set(r.id, { id: r.id, kind: 'external', name, tags: [kind] })
        }
        return r.id
      }
      case 'unresolved':
        return undefined
    }
  }

  // ── edges ──
  const edges = new Map<string, { edge: GraphEdge; sites: Sites }>()
  const addEdge = (e: Omit<GraphEdge, 'confidence'> & { confidence?: GraphEdge['confidence'] }, sites: number[], maxSites: number) => {
    const key = `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.subkind ?? ''}`
    const existing = edges.get(key)
    if (!existing) {
      edges.set(key, { edge: { ...e, targets: [...e.targets], confidence: e.confidence ?? 'exact' }, sites: sites.slice(0, maxSites * 2) })
      return
    }
    existing.edge.count = MAX_MERGED.has(e.kind) ? Math.max(existing.edge.count, e.count) : existing.edge.count + e.count
    for (const t of e.targets) if (!existing.edge.targets.includes(t)) existing.edge.targets.push(t)
    if (!MAX_MERGED.has(e.kind)) existing.sites.push(...sites.slice(0, Math.max(0, maxSites * 2 - existing.sites.length)))
  }
  const maxSites = config.maxSitesPerEdge

  // A target leaves out the files that other targets import but it never
  // does: `impl.ts` in a build that resolves `./impl` to `impl.desktop.ts`.
  // `counterpart` records that replacement per non-primary target.
  const primary = targetNames[0]
  const counterpart = new Map(targetNames.map(t => [t, new Map<string, string>()]))
  for (const f of fragments) {
    for (const imp of f.imports) {
      const p = imp.resolved[primary]
      for (const t of targetNames.slice(1)) {
        const r = imp.resolved[t]
        if (p.kind === 'file' && r.kind === 'file' && p.path !== r.path) counterpart.get(t)!.set(p.path, r.path)
      }
    }
  }
  const importsFrom = (t: string, present: (path: string) => boolean) => {
    const set = new Set<string>()
    for (const f of fragments) {
      if (!present(f.path)) continue
      for (const imp of f.imports) {
        const r = imp.resolved[t]
        if (r.kind === 'file' || r.kind === 'asset') set.add(r.path)
      }
    }
    return set
  }
  let importedIn = new Map(targetNames.map(t => [t, importsFrom(t, () => true)]))
  const importedAnywhere = new Set([...importedIn.values()].flatMap(s => [...s]))
  const absent = (path: string | undefined, target: string) =>
    path !== undefined && importedAnywhere.has(path) && !importedIn.get(target)!.has(path)
  // a file a target leaves out doesn't import anything in it either: shrink to a fixpoint
  for (let changed = targetNames.length > 1; changed; ) {
    const next = new Map(targetNames.map(t => [t, importsFrom(t, p => !absent(p, t))]))
    changed = targetNames.some(t => next.get(t)!.size !== importedIn.get(t)!.size)
    importedIn = next
  }

  for (const f of fragments) {
    const source = fileId(f.path)
    for (const imp of f.imports) {
      const byNode = new Map<string, string[]>()
      for (const t of targetNames) {
        const id = nodeFor(imp.resolved[t])
        if (id && !absent(f.path, t)) byNode.set(id, [...(byNode.get(id) ?? []), t])
      }
      if (!targetNames.some(t => nodeFor(imp.resolved[t]))) diagnostics.unresolvedImports.push({ file: f.path, spec: imp.spec, line: imp.line })
      for (const [target, targets] of byNode)
        addEdge({ source, target, kind: imp.kind, subkind: imp.subkind, count: 1, targets }, [imp.line, imp.col], maxSites)
    }
  }

  // Symbol references are resolved with the primary target's program. They
  // exist in every target that has both files; a target that replaces the
  // referenced file gets the same reference to the counterpart's declaration.
  for (const f of fragments) {
    for (const r of f.refs) {
      const s = nodes.get(r.source)
      const t = nodes.get(r.target)
      if (!s || !t) {
        diagnostics.danglingEdges++
        continue
      }
      const targets = targetNames.filter(x => !absent(s.path, x) && !absent(t.path, x))
      const sub = r.subkind ? { subkind: r.subkind } : {}
      if (targets.length) addEdge({ source: r.source, target: r.target, kind: r.kind, ...sub, count: r.count, targets }, r.sites, maxSites)
      for (const x of targetNames) {
        const replacement = t.path !== undefined && absent(t.path, x) && !absent(s.path, x) ? counterpart.get(x)!.get(t.path) : undefined
        if (replacement === undefined) continue
        const twin = t.kind === 'file' ? fileId(replacement) : `s:${replacement}${r.target.slice(`s:${t.path}`.length)}`
        if (nodes.has(twin)) addEdge({ source: r.source, target: twin, kind: r.kind, ...sub, count: r.count, targets: [x] }, r.sites, maxSites)
      }
    }
  }

  // plugins: resolve their facts, add their nodes and edges (in order; test reach last)
  const api: AssembleApi = {
    root: input.root,
    config,
    targets: targetNames,
    fragments,
    nodes,
    facts: <T>(plugin: string) => fragments.flatMap(f => ((f.facts?.[plugin] ?? []) as T[]).map(fact => ({ file: f.path, fact }))),
    addFile: (path, tags, metrics) => {
      if (!nodes.has(fileId(path))) addFileNode(path, [...tags], metrics)
      return fileId(path)
    },
    addNode: node => void nodes.set(node.id, node),
    addEdge: (e, sites = []) => {
      if (nodes.has(e.source) && nodes.has(e.target)) addEdge(e, sites, maxSites)
    },
    edges: () => [...edges.values()].map(x => x.edge),
    readText: input.readText,
    files: input.files ?? (() => []),
    meta: {},
  }
  for (const plugin of input.plugins ?? []) plugin.assemble?.(api)
  // coherence: which way each file does each job (docs/COHERENCE.md)
  const t0 = performance.now()
  const files = [...nodes.values()].filter(n => n.kind === 'file')
  const concerns = tagParadigms({ files, fragments, config, readText: input.readText })
  input.timings.paradigms = Math.round(performance.now() - t0)

  const sortedNodes = [...nodes.values()].sort((a, b) => cmp(a.id, b.id))
  // by source, target, kind, subkind: the map key joins them with \0, which sorts before any other character
  const sortedEdges = [...edges.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, e]) => e)
  for (const { edge } of sortedEdges) edge.targets.sort((a, b) => targetNames.indexOf(a) - targetNames.indexOf(b))

  const graph: Graph = {
    meta: {
      name: input.name,
      generatedAt: new Date().toISOString(),
      tool: input.tool,
      analyzers: input.analyzers,
      targets: targetNames,
      ...(config.layers?.length ? { layers: config.layers.map(l => l.name) } : {}),
      ...(config.groups?.length ? { groups: config.groups.map(g => g.name) } : {}),
      // always set: an empty list is "measured, none found"; none at all, a graph analyzed before coherence
      concerns,
      ...pluginMeta(api.meta),
      counts: {},
      timings: input.timings,
      cycles: [],
      diagnostics,
      ...(input.cacheStats ? { cache: input.cacheStats } : {}),
    },
    nodes: sortedNodes,
    edges: sortedEdges.map(e => e.edge),
    sites: sortedEdges.map(e => e.sites),
  }
  computeMetrics(graph)
  countDatabases(graph)
  tagFeatures(graph, config)
  if (config.rules.length) applyRules(graph, config.rules)
  return graph
}

/** What plugins add to the meta, when they found anything. */
function pluginMeta(meta: AssembleApi['meta']): Partial<GraphMeta> {
  return meta.databases ? { databases: meta.databases } : {}
}

/** How much schema the databases hold (the summary prints it). */
function countDatabases(graph: Graph) {
  const dbs = graph.meta.databases
  if (!dbs?.length) return
  const tables = dbs.flatMap(d => d.tables)
  graph.meta.counts.databases = dbs.length
  graph.meta.counts.tables = tables.length
  graph.meta.counts.foreignKeys = tables.reduce((n, t) => n + t.references.length, 0)
}

/** Functional features (core/features.ts): `feature:<name>` on the files each owns, `feature-shared` on common code. */
function tagFeatures(graph: Graph, config: Config) {
  const t0 = performance.now()
  const found = findFeatures(graph, config.features)
  if (!found.features.length) return
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  for (const [file, feature] of found.owner) (byId.get(file)!.tags ??= []).push(`feature:${feature}`)
  for (const file of found.shared) (byId.get(file)!.tags ??= []).push('feature-shared')
  graph.meta.features = found.features
  graph.meta.counts.features = found.features.length
  graph.meta.counts.sharedFiles = found.shared.size
  graph.meta.timings.features = Math.round(performance.now() - t0)
}

function computeMetrics(graph: Graph) {
  const index = new GraphIndex(graph)
  const isTestFile = (id: string) => index.fileOf(id)?.tags?.includes('test') ?? false
  const metric = (n: GraphNode, k: string, v: number) => ((n.metrics ??= {})[k] = v)
  const tag = (n: GraphNode, t: string) => (n.tags ??= []).push(t)

  // files: coupling over all dependency kinds, lifted to file level
  const fileEdges = liftEdges(index, fileLevel(index), e => DEPENDENCY_KINDS.has(e.kind))
  const internal = fileEdges.filter(e => index.node(e.target)?.kind === 'file')
  const files = fanInOut(internal.filter(e => !isTestFile(e.source)))
  const outs = fanInOut(internal)
  const externals = fanInOut(fileEdges.filter(e => index.node(e.target)?.kind === 'external'))
  // symbols and members: who refers to them (declarations or file-level code), and what they refer to
  const declEdges = graph.edges.filter(e => isDecl(index.node(e.target)))
  const declIns = fanInOut(declEdges.filter(e => !isTestFile(e.source)))
  const declOuts = fanInOut(declEdges.filter(e => isDecl(index.node(e.source))))

  for (const n of graph.nodes) {
    if (n.kind === 'file' && !n.tags?.includes('asset')) {
      const ca = files.fanIn(n.id)
      const ce = outs.fanOut(n.id)
      metric(n, 'fanIn', ca)
      metric(n, 'fanOut', ce)
      metric(n, 'externalDeps', externals.fanOut(n.id))
      if (ca + ce > 0) metric(n, 'instability', Math.round((ce / (ca + ce)) * 100) / 100)
    } else if (isDecl(n)) {
      metric(n, 'fanIn', declIns.fanIn(n.id))
      metric(n, 'fanOut', declOuts.fanOut(n.id))
    }
  }

  // directories: sizes of their subtree
  for (const n of [...graph.nodes].reverse()) {
    if (n.kind !== 'file' || n.parent === undefined) continue
    for (const d of [index.node(n.parent)!, ...index.ancestors(n.parent)]) {
      metric(d, 'files', (d.metrics?.files ?? 0) + 1)
      metric(d, 'loc', (d.metrics?.loc ?? 0) + (n.metrics?.loc ?? 0))
    }
  }

  graph.meta.cycles = importCycles(graph)
  for (const c of graph.meta.cycles) for (const id of c) tag(index.node(id)!, 'in-cycle')

  // dead exports: exported, and nothing outside the file refers to it (test-only: only tests do)
  let dead = 0
  let testOnly = 0
  for (const n of graph.nodes) {
    // a Go method declared away from its type's file is a symbol, but it is judged with its type, as members are
    if (n.kind !== 'symbol' || !n.exported || n.subkind === 'method') continue
    const file = index.fileOf(n.id)!
    if (file.tags?.some(t => t === 'test' || t === 'entrypoint' || t === 'declaration')) continue
    // a framework creates and calls it (a Spring bean): nothing in the code has to
    if (n.tags?.includes('entrypoint')) continue
    const members = index.children.get(n.id) ?? []
    const users = [n.id, ...members]
      .flatMap(id => index.in(id))
      .map(e => index.fileOf(e.source))
      .filter(from => from !== undefined && from.id !== file.id)
    if (users.some(from => !from!.tags?.includes('test'))) continue
    if (users.length) {
      tag(n, 'test-only')
      testOnly++
    } else {
      tag(n, 'dead-export')
      dead++
    }
  }

  const count = (kind: string) => graph.nodes.filter(n => n.kind === kind).length
  const byKind: Record<string, number> = {}
  for (const e of graph.edges) byKind[`edges.${e.kind}`] = (byKind[`edges.${e.kind}`] ?? 0) + 1
  graph.meta.counts = {
    directories: count('directory'),
    files: graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('asset')).length,
    assets: graph.nodes.filter(n => n.tags?.includes('asset')).length,
    symbols: count('symbol'),
    members: count('member'),
    externals: count('external'),
    edges: graph.edges.length,
    ...byKind,
    cycles: graph.meta.cycles.length,
    deadExports: dead,
    testOnlyExports: testOnly,
    loc: graph.nodes.filter(n => n.kind === 'file').reduce((a, n) => a + (n.metrics?.loc ?? 0), 0),
  }
}

const isDecl = (n: GraphNode | undefined) => n?.kind === 'symbol' || n?.kind === 'member'
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
