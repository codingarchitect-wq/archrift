// Pass B of the infrastructure reader: Helm templates rendered with their
// chart's name and values (and the named templates they include, so a
// service chart that only includes a library chart's Deployment still shows
// its Deployment), then every name resolved: by kind and name, by labels, by
// chart, by named template, by path. Where several declarations could be
// meant, the ones nearest the file in the folder tree win.
import path from 'node:path'
import type { RefRecord } from '../fragment.ts'
import { parseYaml, positionOf } from './common.ts'
import { renderTemplate } from './helm.ts'
import type { HelmContext } from './helm.ts'
import { addResource, isResource } from './k8s.ts'
import type { HelmDefine, InfraFile, InfraRef, K8sResource } from './model.ts'

/** How many leading folders two paths share. */
function shared(a: string, b: string): number {
  const x = a.split('/')
  const y = b.split('/')
  let n = 0
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++
  return n
}

/** The candidates nearest `from` in the folder tree (all of them on a tie). */
function nearest<T extends { path: string }>(candidates: readonly T[], from: string): T[] {
  if (candidates.length < 2) return [...candidates]
  const scored = candidates.map(c => ({ c, s: c.path === from ? Number.MAX_SAFE_INTEGER : shared(c.path, from) }))
  const best = Math.max(...scored.map(x => x.s))
  return scored.filter(x => x.s === best).map(x => x.c)
}

const nsCompatible = (a?: string, b?: string) => !a || !b || a === b

/** The folder holding the chart a template belongs to (the nearest Chart.yaml above it). */
function chartDirOf(p: string, byPath: ReadonlyMap<string, InfraFile>): string | undefined {
  let dir = path.posix.dirname(p)
  for (;;) {
    const chart = byPath.get(dir === '.' ? 'Chart.yaml' : `${dir}/Chart.yaml`)
    if (chart?.chart) return dir
    if (dir === '.' || !dir) return undefined
    dir = path.posix.dirname(dir)
  }
}

/** Renders every Helm template, adding the resources it (and what it includes) declares to its file. */
export function renderTemplates(files: readonly InfraFile[], texts: ReadonlyMap<string, string>): void {
  const byPath = new Map(files.map(f => [f.path, f]))
  const defines = new Map<string, { path: string; define: HelmDefine }[]>()
  for (const f of files) for (const d of f.defines ?? []) defines.set(d.name, [...(defines.get(d.name) ?? []), { path: f.path, define: d }])

  for (const file of files) {
    if (file.kind !== 'helm-template') continue
    const text = texts.get(file.path)
    if (text === undefined) continue
    const dir = chartDirOf(file.path, byPath)
    const prefix = dir === undefined || dir === '.' ? '' : `${dir}/`
    const ctx: HelmContext = { chart: dir !== undefined ? byPath.get(`${prefix}Chart.yaml`)?.chart : undefined, values: byPath.get(`${prefix}values.yaml`)?.values ?? {} }
    const rendered = renderTemplate(text, ctx)
    file.complexity = rendered.complexity
    readRendered(file, rendered.text)

    for (const inc of rendered.includes) {
      const def = nearest(defines.get(inc.name) ?? [], file.path)[0]
      if (!def) continue
      const before = file.resources?.length ?? 0
      if (inc.standalone) {
        const body = renderTemplate(def.define.body, ctx).text
        const at = { range: [inc.line, inc.col, inc.line, inc.col + inc.name.length] as [number, number, number, number], via: inc.name }
        for (const doc of parseYaml(body).docs) if (isResource(doc.value)) addResource({ file, text: body }, doc.value, doc.range, [doc.start, doc.end], at)
      }
      const added = (file.resources ?? []).slice(before)
      const owners = added.length ? added.map(r => r.id) : [ownerAt(file, inc.line)]
      for (const source of owners) file.refs.push({ source, target: { to: 'define', name: inc.name }, subkind: 'include', line: inc.line, col: inc.col })
    }
    if (file.resources?.length) file.tags.push('k8s')
  }
}

/** The declaration a line is in, or the file. */
function ownerAt(file: InfraFile, line: number): string {
  const d = file.decls.find(x => x.kind === 'symbol' && x.range[0] <= line && x.range[2] >= line)
  return d?.id ?? `f:${file.path}`
}

/** A rendered template's resources; documents YAML can't read still give their kind and name. */
function readRendered(file: InfraFile, text: string) {
  const parsed = parseYaml(text)
  for (const doc of parsed.docs) if (isResource(doc.value)) addResource({ file, text }, doc.value, doc.range, [doc.start, doc.end])
  if (!parsed.errors) return
  file.errors = true
  // documents by their separators, each read for `kind:` and `metadata.name` alone
  const bounds = [0, ...[...text.matchAll(/^---[^\n]*$/gm)].flatMap(m => [m.index, m.index + m[0].length]), text.length]
  for (let i = 0; i < bounds.length; i += 2) {
    const [from, to] = [bounds[i], bounds[i + 1]]
    const chunk = text.slice(from, to)
    const kind = /^kind:\s*["']?(\w+)/m.exec(chunk)?.[1]
    const name = /^metadata:[^\n]*\n(?:[ \t]+[^\n]*\n)*?[ \t]+name:\s*["']?([^"'\s#]+)/m.exec(chunk)?.[1]
    if (!kind || !name) continue
    const lead = chunk.length - chunk.trimStart().length
    const [start] = positionOf(text, from + lead)
    const [end] = positionOf(text, from + chunk.trimEnd().length)
    addResource({ file, text }, { apiVersion: 'v1', kind, metadata: { name } }, [start, 1, end, 1], [from, to])
  }
}

/** Every reference of every file resolved to node ids, aggregated per (source, target, subkind). */
export function linkRefs(files: readonly InfraFile[], maxSites: number): Map<string, RefRecord[]> {
  const paths = new Set(files.map(f => f.path))
  const decls = new Set(files.flatMap(f => f.decls.map(d => d.id)))
  const resources = new Map<string, (K8sResource & { path: string })[]>()
  const workloads: (K8sResource & { path: string })[] = []
  const charts = new Map<string, { id: string; path: string }[]>()
  const chartByDir = new Map<string, string>()
  const defines = new Map<string, { id: string; path: string }[]>()
  for (const f of files) {
    for (const r of f.resources ?? []) {
      const key = `${r.kind}\0${r.name}`
      resources.set(key, [...(resources.get(key) ?? []), { ...r, path: f.path }])
      if (r.podLabels) workloads.push({ ...r, path: f.path })
    }
    if (f.chart) {
      const id = f.decls.find(d => d.subkind === 'chart')?.id
      if (id) {
        charts.set(f.chart.name, [...(charts.get(f.chart.name) ?? []), { id, path: f.path }])
        chartByDir.set(path.posix.dirname(f.path), id)
      }
    }
    for (const d of f.defines ?? []) defines.set(d.name, [...(defines.get(d.name) ?? []), { id: d.id, path: f.path }])
  }

  const resolve = (f: InfraFile, r: InfraRef): string[] => {
    const t = r.target
    switch (t.to) {
      case 'file': {
        const p = t.paths.find(x => paths.has(x) && x !== f.path)
        return p ? [`f:${p}`] : []
      }
      case 'decl':
        return decls.has(t.id) && t.id !== r.source ? [t.id] : []
      case 'k8s': {
        const found = t.kinds.flatMap(k => resources.get(`${k}\0${t.name}`) ?? []).filter(x => x.id !== r.source && nsCompatible(x.namespace, t.namespace))
        return nearest(found, f.path).map(x => x.id)
      }
      case 'pods': {
        const want = Object.entries(t.labels)
        const found = workloads.filter(w => w.id !== r.source && nsCompatible(w.namespace, t.namespace) && want.every(([k, v]) => w.podLabels![k] === v))
        return nearest(found, f.path).map(x => x.id)
      }
      case 'chart': {
        const byDir = t.dir !== undefined ? chartByDir.get(t.dir) : undefined
        if (byDir) return [byDir]
        return nearest(charts.get(t.name) ?? [], f.path).map(x => x.id).filter(id => id !== r.source)
      }
      case 'define':
        return nearest(defines.get(t.name) ?? [], f.path).map(x => x.id).filter(id => id !== r.source)
    }
  }

  const out = new Map<string, RefRecord[]>()
  for (const f of files) {
    const refs = new Map<string, RefRecord>()
    for (const r of f.refs) {
      for (const target of resolve(f, r)) {
        const key = `${r.source}\0${target}\0${r.subkind ?? ''}`
        const existing = refs.get(key)
        if (existing) {
          existing.count++
          if (existing.sites.length < maxSites * 2) existing.sites.push(r.line, r.col)
        } else refs.set(key, { source: r.source, target, kind: 'references', ...(r.subkind ? { subkind: r.subkind } : {}), count: 1, sites: maxSites > 0 ? [r.line, r.col] : [] })
      }
    }
    out.set(f.path, [...refs.values()])
  }
  return out
}
