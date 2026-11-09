// The infrastructure LanguageAnalyzer (docs/POLYGLOT.md, P5): YAML
// (Kubernetes manifests, Helm charts, docker-compose, pipelines, application
// configuration), shell scripts, SQL and Dockerfiles, in the root and the
// mounts, as buildings with symbols, links between them, and the topics and
// databases they create as `messaging` and `datastore` facts.
//
// Pass A reads each file on its own and is cached by the file's hash and
// what it is (a values file, a template …). Pass B renders the Helm
// templates with their chart and links names across files; it is cheap and
// runs every time. Secrets are never read: secret stores, certificates, keys
// and SOPS-encrypted files are skipped, and no value of a variable, an
// environment entry or a Secret reaches a signature or a fact.
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { hashText } from '../cache.ts'
import type { AnalyzeContext, FileFragment, LanguageAnalyzer } from '../fragment.ts'
import { countLoc, isEncrypted, isSecretPath } from './common.ts'
import { readDockerfile } from './dockerfile.ts'
import { linkRefs, renderTemplates } from './link.ts'
import type { InfraFile, InfraKind, InfraLanguage } from './model.ts'
import { readShell } from './shell.ts'
import { readSql } from './sql.ts'
import { readChart, readCompose, readHelpers, readManifest, readValues } from './yaml.ts'

/** Bump when what pass A produces changes. */
const VERSION = 4

const LANGUAGE: Record<InfraKind, InfraLanguage> = {
  manifest: 'yaml',
  chart: 'yaml',
  values: 'yaml',
  'helm-template': 'helm',
  'helm-helpers': 'helm',
  compose: 'yaml',
  'app-config': 'yaml',
  shell: 'shell',
  sql: 'sql',
  dockerfile: 'dockerfile',
}

/** What a file is to the reader, from its path and the files around it; undefined: not read. */
export function classify(p: string, files: ReadonlySet<string>): InfraKind | undefined {
  if (isSecretPath(p)) return undefined
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (/\.(sh|bash)$/.test(base)) return 'shell'
  if (/\.sql$/i.test(base)) return 'sql'
  if (/^Dockerfile([._-][\w.-]*)?$/.test(base) || /\.dockerfile$/i.test(base)) return 'dockerfile'
  const inTemplates = /(^|\/)templates\//.test(p) && hasChartAbove(p.slice(0, p.search(/(^|\/)templates\//)), files)
  if (/\.tpl$/.test(base)) return inTemplates ? 'helm-helpers' : undefined
  if (!/\.ya?ml$/.test(base)) return undefined
  if (/^Chart\.ya?ml$/.test(base)) return 'chart'
  if (inTemplates) return 'helm-template'
  if (/^(docker-)?compose([-.][\w.-]+)?\.ya?ml$/.test(base)) return 'compose'
  if (/(^|[-_.])values([-_.][\w.-]+)?\.ya?ml$/.test(base)) return 'values'
  if (/^(application|bootstrap)([-.][\w.-]+)?\.ya?ml$/.test(base) || /(^|\/)src\/[\w-]+\/resources\//.test(p)) return 'app-config'
  return 'manifest'
}

function hasChartAbove(dir: string, files: ReadonlySet<string>): boolean {
  return files.has(dir ? `${dir}/Chart.yaml` : 'Chart.yaml')
}

/** Pass A: one file on its own. */
export function readFile(p: string, kind: InfraKind, text: string, hash: string, roots: readonly string[]): InfraFile {
  const file: InfraFile = { path: p, hash, kind, language: LANGUAGE[kind], loc: countLoc(text), complexity: 1, tags: [], decls: [], refs: [], facts: {} }
  try {
    switch (kind) {
      case 'manifest':
        readManifest(file, text, roots)
        break
      case 'chart':
        readChart(file, text)
        break
      case 'values':
        readValues(file, text)
        break
      case 'compose':
        readCompose(file, text)
        break
      case 'helm-helpers':
        readHelpers(file, text)
        break
      case 'shell':
        readShell(file, text, roots)
        break
      case 'sql':
        readSql(file, text)
        break
      case 'dockerfile':
        readDockerfile(file, text)
        break
      case 'app-config':
        file.tags.push('app-config')
        break
      case 'helm-template':
        break // rendered in pass B, with its chart
    }
  } catch {
    // a file the reader can't follow stays a building
    Object.assign(file, { decls: [], refs: [], facts: {}, errors: true })
  }
  // the language becomes a tag of its own; the kind when it says more (a chart, a values file)
  if (kind !== 'app-config' && kind !== 'manifest' && kind !== 'helm-template' && kind !== LANGUAGE[kind]) file.tags.push(kind)
  return file
}

interface CacheFile {
  key: string
  files: Record<string, InfraFile>
}

interface Session {
  texts: Map<string, { mtimeMs: number; size: number; text: string; hash: string }>
  cache?: CacheFile
}

/** Whether a YAML text holds a Kubernetes resource. */
const looksLikeManifest = (text: string) => /^apiVersion:/m.test(text) && /^kind:/m.test(text)

export const infraAnalyzer: LanguageAnalyzer = {
  id: 'config',
  version: String(VERSION),
  detect(ctx) {
    const files = ctx.files()
    const set = new Set(files)
    let manifests = 0
    for (const p of files) {
      const kind = classify(p, set)
      if (!kind || kind === 'app-config') continue
      if (kind !== 'manifest') return true
      // plain YAML counts when it is a Kubernetes manifest (a few looked at, not every pipeline)
      if (manifests++ < 200) {
        try {
          if (looksLikeManifest(fs.readFileSync(ctx.abs(p), 'utf8'))) return true
        } catch {
          // unreadable: not one
        }
      }
    }
    return false
  },
  async *analyze(ctx: AnalyzeContext): AsyncIterable<FileFragment> {
    const time = <T>(label: string, fn: () => T): T => {
      const t0 = performance.now()
      try {
        return fn()
      } finally {
        ctx.timings[label] = (ctx.timings[label] ?? 0) + Math.round(performance.now() - t0)
      }
    }
    const all = ctx.files()
    const set = new Set(all)
    const items = all.flatMap(p => {
      const kind = classify(p, set)
      return kind ? [{ path: p, kind }] : []
    })
    const mounts = new Set(ctx.mounts.map(m => m.name))
    const rootsOf = (p: string) => {
      const top = p.slice(0, p.indexOf('/'))
      return [mounts.has(top) ? top : '']
    }

    let session = ctx.session?.get('config') as Session | undefined
    if (ctx.session && !session) ctx.session.set('config', (session = { texts: new Map() }))
    const texts = new Map<string, string>()
    const hashes = new Map<string, string>()
    time('config.read', () => {
      for (const { path: p } of items) {
        const abs = ctx.abs(p)
        try {
          const stat = session ? fs.statSync(abs) : undefined
          const known = session?.texts.get(p)
          if (known && stat && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
            texts.set(p, known.text)
            hashes.set(p, known.hash)
            continue
          }
          const text = fs.readFileSync(abs, 'utf8')
          const hash = hashText(text)
          texts.set(p, text)
          hashes.set(p, hash)
          if (session && stat) session.texts.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, text, hash })
        } catch {
          // gone or unreadable: left out
        }
      }
    })

    const key = hashText(JSON.stringify({ v: VERSION, maxSites: ctx.config.maxSitesPerEdge }))
    const cacheFile = ctx.cacheDir ? path.join(ctx.cacheDir, 'config.json') : undefined
    let cache = session?.cache
    if (!cache && cacheFile && fs.existsSync(cacheFile)) {
      try {
        cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CacheFile
      } catch {
        cache = undefined
      }
    }
    if (cache?.key !== key) cache = { key, files: {} }

    const files: InfraFile[] = []
    let hits = 0
    time('config.files', () => {
      for (const { path: p, kind } of items) {
        const text = texts.get(p)
        if (text === undefined || isEncrypted(text)) continue
        const hash = hashes.get(p)!
        const cached = cache!.files[p]
        if (cached?.hash === hash && cached.kind === kind && kind !== 'helm-template') {
          files.push(cached)
          hits++
        } else files.push(readFile(p, kind, text, hash, rootsOf(p)))
      }
    })
    const misses = files.length - hits
    ctx.cacheStats.hits += hits
    ctx.cacheStats.misses += misses
    // templates are rendered every time (pass B adds their resources), so they stay out of the cache
    const next: CacheFile = { key, files: Object.fromEntries(files.filter(f => f.kind !== 'helm-template').map(f => [f.path, f])) }
    if (session) session.cache = next
    const changed = Object.entries(next.files).some(([p, f]) => cache!.files[p] !== f) || Object.keys(cache.files).some(p => !next.files[p])
    if (cacheFile && changed)
      time('config.cacheWrite', () => {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
        fs.writeFileSync(cacheFile, JSON.stringify(next))
      })

    const refs = time('config.link', () => {
      renderTemplates(files, texts)
      return linkRefs(files, ctx.config.maxSitesPerEdge)
    })
    const templates = files.filter(f => f.kind === 'helm-template').length
    ctx.log(`${files.length} infrastructure files: ${misses - templates} read, ${templates} templates rendered, the rest from cache`)

    for (const f of files) {
      yield {
        path: f.path,
        hash: f.hash,
        loc: f.loc,
        complexity: f.complexity,
        tags: [...f.tags, ...(f.errors ? ['parse-errors'] : [])],
        symbols: f.decls.map(d => ({
          id: d.id,
          kind: d.kind,
          name: d.name,
          subkind: d.subkind,
          parent: d.parent,
          range: d.range,
          exported: false,
          ...(d.signature ? { signature: d.signature } : {}),
          tags: [...d.tags],
          loc: d.loc,
          complexity: d.complexity,
        })),
        refs: refs.get(f.path) ?? [],
        specifiers: [],
        deps: {},
        unresolvedIdentifiers: 0,
        ...(Object.keys(f.facts).length ? { facts: f.facts } : {}),
        language: f.language,
        imports: [],
      }
    }
  },
}
