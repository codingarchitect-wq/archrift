// What the CLI writes and prints after an analysis, shared by its commands
// and the project hub.
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../analyzer/config.ts'
import { resolveMounts } from '../analyzer/mounts.ts'
import { loadProjects } from '../analyzer/ts/project.ts'
import { dumpGraph } from '../core/dump.ts'
import type { Graph } from '../core/model.ts'
import { encodeGraph } from '../core/serialize.ts'

/**
 * The shape of `check --format json` and `diff --format json`, which other tools read (CI gates, the
 * software factory's quality step): raised when a field changes meaning or goes away, not when one is added.
 */
export const JSON_SCHEMA_VERSION = 1

export const sitesPath = (out: string) => `${out.replace(/\.json$/, '')}.sites.json`

/** graph.json, its sites next to it, and optionally a readable dump. */
export function writeGraph(graph: Graph, out: string, dump?: string) {
  const encoded = encodeGraph(graph)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(encoded.graph))
  fs.writeFileSync(sitesPath(out), JSON.stringify(encoded.sites))
  if (dump) fs.writeFileSync(dump, dumpGraph(graph))
}

/** Source files the project has, to size the analysis worker's heap (0 when it can't tell; the analysis will say why). */
export function countFiles(root: string, config: Config): number {
  try {
    return loadProjects(root, config, resolveMounts(root, config.mounts)).owner.size
  } catch {
    return 0
  }
}

const kb = (file: string) => `${Math.round(fs.statSync(file).size / 1024).toLocaleString('en-US')} KB`

/** The summary `analyze` and `serve` print: sizes, edges, findings, history, rules, timings, where it went. */
export function printSummary(graph: Graph, out: string, log: (msg: string) => void) {
  const c = graph.meta.counts
  const t = graph.meta.timings
  const d = graph.meta.diagnostics
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-US')
  const edgeKinds = Object.entries(c)
    .filter(([k]) => k.startsWith('edges.'))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.slice(6)} ${n(v)}`)
  const aliasUnresolved = d.unresolvedImports.filter(u => !u.spec.startsWith('.'))
  log(
    [
      `archrift analyze ${graph.meta.name}`,
      `  ${n(c.files)} files (${n(c.loc)} lines) · ${n(c.symbols)} symbols · ${n(c.members)} members · ${n(c.externals)} externals · ${n(c.assets)} assets`,
      `  ${n(c.edges)} edges: ${edgeKinds.join(' · ')}`,
      `  ${n(c.cycles)} import cycles${graph.meta.cycles.length ? ` (largest ${graph.meta.cycles[0].length} files)` : ''} · ${n(c.deadExports)} dead exports · ${n(c.testOnlyExports)} used only by tests`,
      ...(graph.meta.history
        ? [
            `  history: ${n(graph.meta.history.commits)} commits by ${n(graph.meta.history.authors)} authors since ${new Date(graph.meta.history.since * 1000).toISOString().slice(0, 10)} · ${n(c['edges.co-changes'])} co-change pairs`,
          ]
        : []),
      ...(c.databases ? [`  databases: ${n(c.databases)} with ${n(c.tables)} tables and ${n(c.foreignKeys)} foreign keys`] : []),
      ...(graph.meta.violations ? [`  rules: ${n(c.violations)} violations · ${n(c.warnings)} warnings${c.unmatchedRules ? ` · ${n(c.unmatchedRules)} matching nothing` : ''} (archrift check lists them)`] : []),
      `  ${n(d.unresolvedImports.length)} unresolved imports (${n(aliasUnresolved.length)} non-relative) · ${n(d.unresolvedIdentifiers)} unresolved identifiers · ${n(d.danglingEdges)} dangling edges`,
      `  cache: ${n(graph.meta.cache?.hits)} hits / ${n(graph.meta.cache?.misses)} misses`,
      `  time: ${Object.entries(t)
        .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
        .join(' · ')}`,
      `  heap: ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB used · wrote ${path.relative(process.cwd(), out)} (${kb(out)}) + sites (${kb(sitesPath(out))})`,
    ].join('\n'),
  )
  for (const u of d.unresolvedImports.slice(0, 20)) log(`    unresolved: ${u.file}:${u.line} '${u.spec}'`)
}
