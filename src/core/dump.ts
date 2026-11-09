// A deterministic, line-per-fact text form of a graph: used for fixture
// snapshots (reviewable diffs) and `archrift analyze --dump`.
import type { ColumnMeta, DatabaseMeta, Graph, GraphNode, TableMeta } from './model.ts'

export function dumpGraph(graph: Graph, options: { sites?: boolean } = {}): string {
  const lines: string[] = ['# nodes']
  for (const n of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) lines.push(dumpNode(n))
  lines.push('', '# edges')
  const edges = graph.edges.map((e, i) => ({ e, sites: graph.sites[i] ?? [] }))
  edges.sort(
    (a, b) =>
      a.e.source.localeCompare(b.e.source) ||
      a.e.target.localeCompare(b.e.target) ||
      a.e.kind.localeCompare(b.e.kind) ||
      (a.e.subkind ?? '').localeCompare(b.e.subkind ?? ''),
  )
  const allTargets = graph.meta.targets.join(',')
  for (const { e, sites } of edges) {
    const targets = e.targets.join(',')
    const parts = [
      `${e.source} -${e.kind}${e.subkind ? `/${e.subkind}` : ''}-> ${e.target}`,
      `×${e.count}`,
      targets !== allTargets ? `[${targets}]` : '',
      e.confidence === 'inferred' ? 'inferred' : '',
      options.sites !== false && sites.length ? sitesText(sites) : '',
    ]
    lines.push(parts.filter(Boolean).join('  '))
  }
  if (graph.meta.cycles.length) {
    lines.push('', '# cycles')
    for (const c of graph.meta.cycles) lines.push(c.join(', '))
  }
  lines.push(...databaseLines(graph.meta.databases))
  if (graph.meta.rules?.length) {
    lines.push('', '# rules')
    for (const r of graph.meta.rules) {
      const broken = (graph.meta.violations ?? []).filter(v => v.rule === r.name)
      lines.push(`${r.name}  ${r.kind}  ${r.severity}${r.target ? `  [${r.target}]` : ''}  ${broken.length ? `${broken.length} broken` : r.unmatched ? 'matches nothing' : 'ok'}`)
      for (const u of r.unmatched ?? []) lines.push(`  ? ${u}`)
      for (const v of broken) {
        if (v.measure) {
          lines.push(`  ${v.measure.symbol ?? v.from}  ${v.measure.metric} ${v.measure.value} ${v.measure.bound} ${v.measure.limit}`)
          continue
        }
        if (v.expects) {
          lines.push(`  ${v.expects.symbol ?? v.from}  never reaches ${v.expects.to}${v.targets.join(',') !== allTargets ? `  [${v.targets.join(',')}]` : ''}`)
          continue
        }
        const targets = v.targets.join(',') !== allTargets ? `  [${v.targets.join(',')}]` : ''
        lines.push(`  ${v.from} -> ${v.to}${targets}${v.path ? `  via ${v.path.join(' > ')}` : ''}${v.sources && v.sources.length > 1 ? `  (${v.sources.length} sources)` : ''}`)
      }
    }
  }
  const unresolved = graph.meta.diagnostics.unresolvedImports
  if (unresolved.length) {
    lines.push('', '# unresolved imports')
    for (const u of unresolved) lines.push(`${u.file}:${u.line} '${u.spec}'`)
  }
  return lines.join('\n') + '\n'
}

function databaseLines(dbs: DatabaseMeta[] | undefined): string[] {
  return dbs?.length ? ['', '# databases', ...dbs.flatMap(dumpDatabase)] : []
}

function dumpDatabase(d: DatabaseMeta): string[] {
  const head = [d.id, d.engine, d.sources.join(','), `module=${JSON.stringify(d.module)}`, `name=${JSON.stringify(d.name)}`, d.node ? `node=${d.node}` : '']
  return [head.filter(Boolean).join('  '), ...d.tables.flatMap(dumpTable)]
}

function dumpTable(t: TableMeta): string[] {
  return [
    [`  ${t.kind} ${t.name}`, t.entity ? `entity=${t.entity}` : '', `nodes=${t.nodes.join(', ')}`].filter(Boolean).join('  '),
    ...t.columns.map(dumpColumn),
    ...t.references.map(r => ['    fk', `(${r.columns.join(', ')}) -> ${r.table} (${r.to.join(', ')})`, r.onDelete ? `on delete ${r.onDelete}` : '', r.name ? `name=${r.name}` : ''].filter(Boolean).join('  ')),
    ...t.indexes.map(i => ['    index', `(${i.columns.join(', ')})`, i.unique ? 'unique' : '', i.multiEntry ? 'multi-entry' : '', i.name ? `name=${i.name}` : ''].filter(Boolean).join('  ')),
  ]
}

const COLUMN_FLAGS = ['pk', 'nullable', 'unique', 'generated', 'virtual'] as const

function dumpColumn(c: ColumnMeta): string {
  return ['    ' + c.name, c.type ?? '', ...COLUMN_FLAGS.filter(f => c[f]), c.target ? `-> ${c.target}` : '', c.line ? `:${c.line}` : ''].filter(Boolean).join('  ')
}

function dumpNode(n: GraphNode) {
  const parts = [n.id, n.kind + (n.subkind ? `/${n.subkind}` : '')]
  if (n.name !== lastSegment(n.id)) parts.push(`name=${JSON.stringify(n.name)}`)
  if (n.exported) parts.push('exported')
  if (n.range) parts.push(`${n.range[0]}:${n.range[1]}-${n.range[2]}:${n.range[3]}`)
  for (const [k, v] of Object.entries(n.metrics ?? {}).sort()) parts.push(`${k}=${v}`)
  if (n.tags?.length) parts.push(`[${[...n.tags].sort().join(',')}]`)
  if (n.signature) parts.push(`sig=${JSON.stringify(n.signature)}`)
  return parts.join('  ')
}

function lastSegment(id: string) {
  const body = id.slice(id.indexOf(':') + 1)
  const hash = body.lastIndexOf('#')
  if (hash >= 0) return body.slice(hash + 1).split('.').pop()
  return body.split('/').pop()
}

function sitesText(sites: number[]) {
  const out: string[] = []
  for (let i = 0; i < sites.length; i += 2) out.push(`@${sites[i]}:${sites[i + 1]}`)
  return out.join(' ')
}
