// YAML files: Kubernetes manifests, Helm charts (Chart.yaml, values, the
// named templates of *.tpl helpers), docker-compose files and pipelines.
// Application configuration (Spring's application*.yml) is a building only:
// the messaging and datastore plugins read what it says.
import path from 'node:path'
import { isSeq } from 'yaml'
import type { Node as YamlNode } from 'yaml'
import { symbolId } from '../../core/ids.ts'
import type { DatastoreFact } from '../plugins/datastore-facts.ts'
import { SECRET_KEY, asArray, asString, countLoc, engineOfImage, get, imageName, isObject, pairsOf, parseYaml, positionOf, rangeOf, shape } from './common.ts'
import { findDefines, flattenValues, includesOf } from './helm.ts'
import { addResource, isResource } from './k8s.ts'
import type { InfraDecl, InfraFile } from './model.ts'

/** Top-level keys of a values file shown as symbols, at most. */
const MAX_VALUE_KEYS = 40

const decl = (file: InfraFile, name: string, subkind: string, range: InfraDecl['range'], signature: string, text: string, tags: string[] = []): InfraDecl => ({
  id: symbolId(file.path, name),
  kind: 'symbol',
  name,
  subkind,
  parent: `f:${file.path}`,
  range,
  signature,
  tags,
  loc: countLoc(text, range[0], range[2]),
  complexity: 1,
})

/** Kubernetes resources, and the templates a pipeline uses. */
export function readManifest(file: InfraFile, text: string, roots: readonly string[]): void {
  const parsed = parseYaml(text)
  if (parsed.errors) file.errors = true
  for (const doc of parsed.docs) {
    if (isResource(doc.value)) addResource({ file, text }, doc.value, doc.range, [doc.start, doc.end])
    else pipelineTemplates(file, doc.value, text, roots)
  }
  if (file.resources?.length) file.tags.push('k8s')
}

/** Azure Pipelines and GitLab-style `template: path` entries that name a file in the repository. */
function pipelineTemplates(file: InfraFile, value: unknown, text: string, roots: readonly string[]) {
  const found: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (isObject(v))
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'template' || k === 'include') && typeof x === 'string' && !x.includes('@') && /\.ya?ml$/.test(x)) found.push(x)
        else walk(x)
      }
  }
  walk(value)
  const dir = path.posix.dirname(file.path)
  // each occurrence at its own place: the next one after the last found
  const after = new Map<string, number>()
  for (const t of found) {
    const at = text.indexOf(t, after.get(t) ?? 0)
    if (at >= 0) after.set(t, at + t.length)
    const [line, col] = at >= 0 ? positionOf(text, at) : [1, 1]
    const paths = [path.posix.join(dir, t), ...roots.map(r => path.posix.join(r, t.replace(/^\//, '')))].map(p => path.posix.normalize(p))
    file.refs.push({ source: `f:${file.path}`, target: { to: 'file', paths: [...new Set(paths)].filter(p => !p.startsWith('..')) }, subkind: 'uses', line, col })
  }
}

/** Chart.yaml: the chart as a symbol; its dependencies refer to the charts they name. */
export function readChart(file: InfraFile, text: string): void {
  const parsed = parseYaml(text)
  const doc = parsed.docs[0]
  if (parsed.errors) file.errors = true
  const name = asString(get(doc?.value, 'name'))
  if (!doc || !name) return
  const version = asString(get(doc.value, 'version')) ?? ''
  const type = asString(get(doc.value, 'type'))
  const chart = decl(file, name, 'chart', doc.range, `chart ${name}${version ? ` ${version}` : ''}${type === 'library' ? ' (library)' : ''}`, text, ['helm'])
  file.decls.push(chart)
  file.chart = { name, version }
  const dir = path.posix.dirname(file.path)
  const deps = pairsOf(doc.contents).find(p => p.key === 'dependencies')?.pair.value
  for (const [i, d] of asArray(get(doc.value, 'dependencies')).entries()) {
    const depName = asString(get(d, 'name'))
    if (!depName) continue
    const repo = asString(get(d, 'repository')) ?? ''
    const local = repo.startsWith('file://') ? path.posix.normalize(path.posix.join(dir, repo.slice('file://'.length))) : undefined
    const item = isSeq(deps) ? (deps.items[i] as YamlNode | undefined) : undefined
    const [line, col] = item?.range ? [parsed.lines.linePos(item.range[0]).line, parsed.lines.linePos(item.range[0]).col] : [chart.range[0], chart.range[1]]
    file.refs.push({ source: chart.id, target: { to: 'chart', name: depName, ...(local && !local.startsWith('..') ? { dir: local } : {}) }, subkind: 'dependency', line, col })
  }
}

/**
 * A values file: its top-level keys as symbols (no values in signatures but
 * numbers and booleans), the images it sets, and for a database chart the
 * server and the databases it creates (Bitnami's `auth.database(s)`).
 */
export function readValues(file: InfraFile, text: string): void {
  const parsed = parseYaml(text)
  if (parsed.errors) file.errors = true
  const doc = parsed.docs[0]
  if (!doc) return
  for (const { key, pair } of pairsOf(doc.contents).slice(0, MAX_VALUE_KEYS)) {
    const k = pair.key as YamlNode
    const end = (pair.value?.range ?? k.range)![1]
    const range = rangeOf(parsed.lines, k.range![0], end)
    const value = get(doc.value, key)
    file.decls.push(decl(file, key, 'value', range, SECRET_KEY.test(key) ? key : `${key}: ${shape(value)}`, text))
  }
  // what templates see as .Values (and never a secret-looking key's value)
  file.values = flattenValues(doc.value, k => SECRET_KEY.test(k))
  const images = new Set<string>()
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (isObject(v)) {
      const repo = asString(v.repository)
      if (repo && (v.tag !== undefined || v.registry !== undefined || v.pullPolicy !== undefined)) {
        const img = imageName(repo)
        if (img) images.add(img)
      }
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'image' || k === 'imageName') && typeof x === 'string') {
          const img = imageName(x)
          if (img) images.add(img)
        } else walk(x)
      }
    }
  }
  walk(doc.value)
  file.tags.push(...[...images].sort().map(i => `image:${i}`))
  const engine = [...images].map(engineOfImage).find(e => e) ?? engineOfImage(path.posix.basename(file.path).replace(/(^|[-_.])(default-)?values.*$/, '') || path.posix.basename(path.posix.dirname(file.path)))
  if (!engine) return
  const owner = `f:${file.path}`
  const server: DatastoreFact = { type: 'declare', owner, engine, name: '', module: '', site: [doc.range[0], doc.range[1]] }
  ;(file.facts.datastore ??= []).push(server)
  const auth = get(doc.value, 'auth')
  for (const name of [asString(get(auth, 'database')), ...asArray(get(auth, 'databases')).map(asString)]) {
    if (!name) continue
    const at = text.indexOf(name)
    const fact: DatastoreFact = { type: 'declare', owner, engine, name, module: '', site: at >= 0 ? positionOf(text, at) : [doc.range[0], doc.range[1]] }
    file.facts.datastore.push(fact)
  }
}

/** docker-compose: services as symbols; `depends_on`, the Dockerfile a service builds and files it mounts. */
export function readCompose(file: InfraFile, text: string): void {
  const parsed = parseYaml(text)
  if (parsed.errors) file.errors = true
  const doc = parsed.docs[0]
  if (!doc) return
  const services = pairsOf(doc.contents).find(p => p.key === 'services')?.pair.value
  const dir = path.posix.dirname(file.path)
  const images = new Set<string>()
  for (const { key: name, pair } of pairsOf(services)) {
    const k = pair.key as YamlNode
    const range = rangeOf(parsed.lines, k.range![0], (pair.value?.range ?? k.range)![1])
    const svc = get(doc.value, 'services', name)
    const image = asString(get(svc, 'image'))
    const build = get(svc, 'build')
    const context = asString(build) ?? asString(get(build, 'context'))
    const signature = image ? `image: ${image}` : context ? `build: ${context}` : name
    const d = decl(file, name, 'compose-service', range, signature, text)
    const img = image && imageName(image)
    if (img) {
      d.tags.push(`image:${img}`)
      images.add(img)
    }
    file.decls.push(d)
    const siteOf = (needle: string): [number, number] => {
      const at = text.indexOf(needle, pair.value?.range?.[0] ?? 0)
      return at >= 0 ? positionOf(text, at) : [range[0], range[1]]
    }
    const deps = get(svc, 'depends_on')
    for (const other of Array.isArray(deps) ? deps.map(asString) : isObject(deps) ? Object.keys(deps) : []) {
      if (!other) continue
      const [line, col] = siteOf(other)
      file.refs.push({ source: d.id, target: { to: 'decl', id: symbolId(file.path, other) }, subkind: 'depends-on', line, col })
    }
    if (context) {
      const dockerfile = asString(get(build, 'dockerfile')) ?? 'Dockerfile'
      const [line, col] = siteOf(context)
      file.refs.push({ source: d.id, target: { to: 'file', paths: [path.posix.normalize(path.posix.join(dir, context, dockerfile))] }, subkind: 'builds', line, col })
    }
    // files it mounts: ./init.sql:/docker-entrypoint-initdb.d/init.sql
    for (const v of asArray(get(svc, 'volumes'))) {
      const source = asString(v)?.split(':')[0] ?? asString(get(v, 'source'))
      if (!source || !/^\.{1,2}\//.test(source)) continue
      const [line, col] = siteOf(source)
      file.refs.push({ source: d.id, target: { to: 'file', paths: [path.posix.normalize(path.posix.join(dir, source))] }, subkind: 'uses', line, col })
    }
  }
  file.tags.push(...[...images].sort().map(i => `image:${i}`))
}

/** A chart's helpers (*.tpl): each named template as a symbol, kept as text for the templates that include it. */
export function readHelpers(file: InfraFile, text: string): void {
  file.defines = []
  file.complexity = 1 + (text.match(/\{\{-?\s*(if|else|range|with)\b/g)?.length ?? 0)
  for (const d of findDefines(text)) {
    const [line, col] = positionOf(text, d.at)
    const [endLine] = positionOf(text, d.end)
    const body = text.slice(d.start, d.end)
    const kind = /^kind:\s*(\w+)/m.exec(body)?.[1]
    const id = symbolId(file.path, d.name)
    if (file.decls.some(x => x.id === id)) continue
    file.decls.push({
      id,
      kind: 'symbol',
      name: d.name,
      subkind: 'helm-define',
      parent: `f:${file.path}`,
      range: [line, col, endLine, 1],
      signature: `define "${d.name}"${kind ? ` → ${kind}` : ''}`,
      tags: ['helm'],
      loc: countLoc(text, line, endLine),
      complexity: 1 + (body.match(/\{\{-?\s*(if|else|range|with)\b/g)?.length ?? 0),
    })
    file.defines.push({ id, name: d.name, body, line: positionOf(text, d.start)[0] })
    for (const inc of includesOf(body)) {
      const [l, c] = positionOf(text, d.start + inc.offset)
      file.refs.push({ source: id, target: { to: 'define', name: inc.name }, subkind: 'include', line: l, col: c })
    }
  }
}

