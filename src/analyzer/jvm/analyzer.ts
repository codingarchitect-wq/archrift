// The JVM LanguageAnalyzer (docs/POLYGLOT.md, P3): Kotlin sources and Avro
// schemas, read with tree-sitter and resolved across files by name.
//
// Two passes. Pass A reads each file's declarations on its own and is cached
// by the file's hash. The declarations of all files make the index; pass B
// resolves every file's names against it and is cached by the file's hash
// plus a hash of what the index exposes (names, kinds, types, constants, not
// positions), so editing a function body re-links only that file.
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { hashText } from '../cache.ts'
import type { AnalyzeContext, FileFragment, ImportRecord, LanguageAnalyzer, ResolvedTarget } from '../fragment.ts'
import { parserFor } from '../tree-sitter.ts'
import type { Tree } from '../tree-sitter.ts'
import { readAvro } from './avro.ts'
import { JvmIndex } from './index.ts'
import type { Modules } from './index.ts'
import { readKotlin } from './kotlin-decls.ts'
import { linkKotlin } from './kotlin-link.ts'
import type { LinkResult } from './kotlin-link.ts'
import type { JvmDecl, JvmFile } from './model.ts'
import { writeCache } from '../cache-write.ts'

/** Bump when what either pass produces changes. */
const VERSION = 11
const isKotlin = (p: string) => p.endsWith('.kt')
const isAvro = (p: string) => p.endsWith('.avsc')
const BUILD_FILE = /(^|\/)(build\.gradle(\.kts)?|pom\.xml|go\.mod)$/
/** First segments whose packages are named by two parts (java.util), not three (org.springframework.kafka). */
const SHORT_ROOTS = new Set(['java', 'javax', 'kotlin', 'kotlinx', 'jakarta', 'android', 'androidx', 'scala'])

interface Linked {
  hash: string
  link: LinkResult
  imports: ImportRecord[]
}

interface CacheFile {
  key: string
  decls: Record<string, JvmFile>
  indexHash: string
  links: Record<string, Linked>
}

interface Session {
  texts: Map<string, { mtimeMs: number; size: number; text: string; hash: string }>
  cache?: CacheFile
}

/** An outside package's node: `x:jvm:org.springframework.kafka` (up to three segments, never the declaration imported). */
export function jvmExternal(fqn: string): string {
  const parts = fqn.split('.')
  const upper = parts.findIndex(p => /^[A-Z]/.test(p))
  // an import names a declaration, so its last segment is never part of the package
  const n = Math.max(1, Math.min(SHORT_ROOTS.has(parts[0]) ? 2 : 3, upper < 0 ? parts.length - 1 : upper))
  return `x:jvm:${parts.slice(0, n).join('.')}`
}

export const jvmAnalyzer: LanguageAnalyzer = {
  id: 'jvm',
  version: String(VERSION),
  detect: ctx => ctx.files().some(f => isKotlin(f) || isAvro(f)),
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
    const paths = all.filter(p => isKotlin(p) || isAvro(p))
    const modules = time('jvm.modules', () => findModules(all, ctx))

    let session = ctx.session?.get('jvm') as Session | undefined
    if (ctx.session && !session) ctx.session.set('jvm', (session = { texts: new Map() }))
    const texts = new Map<string, { text: string; hash: string }>()
    time('jvm.read', () => {
      for (const p of paths) {
        const abs = ctx.abs(p)
        const stat = session ? fs.statSync(abs) : undefined
        const known = session?.texts.get(p)
        if (known && stat && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
          texts.set(p, known)
          continue
        }
        const text = fs.readFileSync(abs, 'utf8')
        const entry = { text, hash: hashText(text) }
        texts.set(p, entry)
        if (session && stat) session.texts.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, ...entry })
      }
    })

    const key = hashText(JSON.stringify({ v: VERSION, targets: ctx.targets.map(t => t.name), maxSites: ctx.config.maxSitesPerEdge, modules }))
    const cacheFile = ctx.cacheDir ? path.join(ctx.cacheDir, 'jvm.json') : undefined
    let cache = session?.cache
    if (!cache && cacheFile && fs.existsSync(cacheFile)) {
      try {
        cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CacheFile
      } catch {
        cache = undefined
      }
    }
    if (cache?.key !== key) cache = { key, decls: {}, indexHash: '', links: {} }

    // pass A: declarations, from the cache when the file is unchanged
    const kotlin = await parserFor('kotlin')
    const trees = new Map<string, { tree: Tree; declAt: Map<number, JvmDecl> }>()
    const files: JvmFile[] = []
    let hits = 0
    time('jvm.declarations', () => {
      for (const p of paths) {
        const { text, hash } = texts.get(p)!
        const cached = cache!.decls[p]
        if (cached?.hash === hash) {
          files.push(cached)
          hits++
          continue
        }
        if (isAvro(p)) files.push(readAvro(text, p, hash))
        else {
          const tree = kotlin.parse(text)!
          const read = readKotlin(tree, p, hash, text)
          trees.set(p, { tree, declAt: read.declAt })
          files.push(read.file)
        }
      }
    })
    const index = time('jvm.index', () => new JvmIndex(files, modules))
    const indexHash = hashText(JSON.stringify(files.map(surfaceOf)))
    const sameIndex = cache.indexHash === indexHash

    // pass B: names resolved, from the cache when the file and the index are unchanged
    const links = new Map<string, Linked>()
    let relinked = 0
    time('jvm.link', () => {
      for (const f of files) {
        const cached = cache!.links[f.path]
        if (sameIndex && cached?.hash === f.hash) {
          links.set(f.path, cached)
          continue
        }
        let link: LinkResult
        if (f.language === 'avro') link = linkAvro(f, index, ctx.config.maxSitesPerEdge)
        else {
          let t = trees.get(f.path)
          if (!t) {
            const { text, hash } = texts.get(f.path)!
            const tree = kotlin.parse(text)!
            t = { tree, declAt: readKotlin(tree, f.path, hash, text).declAt }
            trees.set(f.path, t)
          }
          link = linkKotlin(t.tree, f, t.declAt, index, ctx.config.maxSitesPerEdge)
        }
        links.set(f.path, { hash: f.hash, link, imports: importsOf(f, index, ctx) })
        relinked++
      }
    })
    for (const t of trees.values()) t.tree.delete()
    kotlin.delete()
    ctx.cacheStats.hits += hits
    ctx.cacheStats.misses += paths.length - hits
    ctx.log(`${paths.length} Kotlin/Avro files: ${paths.length - hits} read, ${relinked} linked, the rest from cache`)

    const next: CacheFile = { key, decls: Object.fromEntries(files.map(f => [f.path, f])), indexHash, links: Object.fromEntries(links) }
    if (session) session.cache = next
    if (cacheFile && relinked)
      time('jvm.cacheWrite', () => writeCache(cacheFile, JSON.stringify(next)))

    for (const f of files) {
      const { link, imports } = links.get(f.path)!
      yield {
        path: f.path,
        hash: f.hash,
        loc: f.loc,
        complexity: f.complexity,
        tags: [
          ...(f.errors ? ['parse-errors'] : []),
          // a file declaring an entity is where its store's data is described (db:sql, db:mongodb)
          ...new Set(f.decls.filter(d => d.tags.includes('entity')).flatMap(d => d.tags.filter(t => t.startsWith('db:')))),
          // a controller serves these paths (as a Next.js route file does): features and runtime scenarios start here
          ...[...new Set(Object.values(link.tags).flatMap(ts => ts.filter(t => t.startsWith('http:')).map(t => `api:${t.slice(t.indexOf(' ') + 1)}`)))].sort(),
        ],
        symbols: f.decls.map(d => ({
          id: d.id,
          kind: d.kind,
          name: d.name,
          subkind: d.subkind,
          parent: d.parent,
          range: d.range,
          exported: d.exported,
          ...(d.signature ? { signature: d.signature } : {}),
          tags: [...d.tags, ...(link.tags[d.id] ?? [])],
          loc: d.loc,
          complexity: d.complexity,
        })),
        refs: link.refs,
        specifiers: [],
        deps: {},
        unresolvedIdentifiers: link.unresolved,
        ...(Object.keys(link.facts).length ? { facts: link.facts } : {}),
        language: f.language,
        imports,
      }
    }
  },
}

/** What other files see of a file: its declarations without positions or sizes. */
function surfaceOf(f: JvmFile) {
  return [
    f.path,
    f.pkg,
    f.imports.map(i => `${i.fqn}|${i.alias ?? ''}|${i.star}`),
    f.decls.map(d => [d.id, d.kind, d.subkind, d.parent, d.fqn, d.type, d.supers, d.valueType, d.init, d.companion, d.override, d.uses, d.tags, d.annotations?.map(a => [a.name, a.args])]),
  ]
}

/** Folders with a build file, and the other modules each build file names (a library by its folder's name). */
function findModules(all: string[], ctx: AnalyzeContext): Modules {
  const builds = all.filter(f => BUILD_FILE.test(f))
  const dirs = [...new Set(builds.map(f => path.posix.dirname(f)).filter(d => d !== '.'))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
  const deps = new Map<string, Set<string>>()
  for (const b of builds) {
    const dir = path.posix.dirname(b)
    let text = ''
    try {
      text = fs.readFileSync(ctx.abs(b), 'utf8')
    } catch {
      continue
    }
    const set = deps.get(dir) ?? new Set<string>()
    for (const other of dirs) {
      const name = other.slice(other.lastIndexOf('/') + 1)
      if (other !== dir && name.length > 3 && text.includes(name)) set.add(other)
    }
    deps.set(dir, set)
  }
  return { dirs, deps }
}

/** A file's imports, resolved per build target (the same in each): to the declaring file, or to an outside package. */
function importsOf(f: JvmFile, index: JvmIndex, ctx: AnalyzeContext): ImportRecord[] {
  const out: ImportRecord[] = []
  for (const imp of f.imports) {
    let target: ResolvedTarget
    if (imp.star) {
      // a project package's star import names no one file: its uses are references
      if (index.isPackage(imp.fqn)) continue
      target = { kind: 'external', id: jvmExternal(`${imp.fqn}.X`) }
    } else {
      const decl = index.resolveImport(imp.fqn, f.path)[0]
      const file = decl && index.fileOf(decl.id)
      if (file && file.path === f.path) continue
      target = file ? { kind: 'file', path: file.path } : { kind: 'external', id: jvmExternal(imp.fqn) }
    }
    out.push({ spec: imp.star ? `${imp.fqn}.*` : imp.fqn, kind: 'imports', subkind: 'static', line: imp.line, col: imp.col, resolved: Object.fromEntries(ctx.targets.map(t => [t.name, target])) })
  }
  return out
}

/** Avro's pass B: a field's record and enum types. */
function linkAvro(f: JvmFile, index: JvmIndex, maxSites: number): LinkResult {
  const refs = new Map<string, LinkResult['refs'][number]>()
  let unresolved = 0
  const scope = { file: f, types: [] }
  for (const d of f.decls) {
    for (const name of d.uses ?? []) {
      const t = index.resolveType(name.split('.'), scope)[0]
      if (!t) {
        unresolved++
        continue
      }
      const key = `${d.id}\u0000${t.id}`
      if (!refs.has(key)) refs.set(key, { source: d.id, target: t.id, kind: 'type-ref', count: 1, sites: maxSites > 0 ? [d.range[0], d.range[1]] : [] })
    }
  }
  return { refs: [...refs.values()], facts: {}, tags: {}, unresolved }
}
