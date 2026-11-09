// The Go LanguageAnalyzer (docs/POLYGLOT.md, P5): Go sources read with
// tree-sitter and resolved across files and packages by name.
//
// Two passes, as for the JVM. Pass A reads each file's declarations on its
// own and is cached by the file's hash. The declarations of all files make
// the index; pass B resolves every file's names against it and is cached by
// the file's hash plus a hash of the surfaces (names, kinds, types, not
// positions) of its package and of every package it imports, transitively:
// editing a function body re-links only that file, and changing a package's
// declarations re-links the packages that can see them. Interface
// satisfaction is structural and whole-program, so `implements` is computed
// from the index on every run (it is cheap) rather than cached per file.
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileIdOf } from '../../core/ids.ts'
import { hashText } from '../cache.ts'
import type { AnalyzeContext, FileFragment, ImportRecord, LanguageAnalyzer, RefRecord, ResolvedTarget } from '../fragment.ts'
import { parserFor } from '../tree-sitter.ts'
import type { Tree } from '../tree-sitter.ts'
import { readGo } from './decls.ts'
import { GoIndex } from './index.ts'
import { linkGo } from './link.ts'
import type { LinkResult } from './link.ts'
import type { GoDecl, GoFile, GoModule } from './model.ts'

/** Bump when what either pass produces changes. */
const VERSION = 1
const isGo = (p: string) => p.endsWith('.go')

interface Linked {
  /** The file's hash and its package closure's (index.closureOf). */
  key: string
  /** When the link read configuration paths: the module's surface then. */
  module?: string
  link: LinkResult
  imports: ImportRecord[]
}

interface CacheFile {
  key: string
  decls: Record<string, GoFile>
  links: Record<string, Linked>
}

interface Session {
  texts: Map<string, { mtimeMs: number; size: number; text: string; hash: string }>
  cache?: CacheFile
}

export const goAnalyzer: LanguageAnalyzer = {
  id: 'go',
  version: String(VERSION),
  detect: ctx => ctx.files().some(isGo),
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
    const paths = all.filter(isGo)
    const modules = time('go.modules', () => findGoModules(all, ctx))

    let session = ctx.session?.get('go') as Session | undefined
    if (ctx.session && !session) ctx.session.set('go', (session = { texts: new Map() }))
    const texts = new Map<string, { text: string; hash: string }>()
    time('go.read', () => {
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
    const cacheFile = ctx.cacheDir ? path.join(ctx.cacheDir, 'go.json') : undefined
    let cache = session?.cache
    if (!cache && cacheFile && fs.existsSync(cacheFile)) {
      try {
        cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CacheFile
      } catch {
        cache = undefined
      }
    }
    if (cache?.key !== key) cache = { key, decls: {}, links: {} }

    // pass A: declarations, from the cache when the file is unchanged
    const parser = await parserFor('go')
    const trees = new Map<string, { tree: Tree; declAt: Map<number, GoDecl> }>()
    const files: GoFile[] = []
    let hits = 0
    time('go.declarations', () => {
      for (const p of paths) {
        const { text, hash } = texts.get(p)!
        const cached = cache!.decls[p]
        if (cached?.hash === hash) {
          files.push(cached)
          hits++
          continue
        }
        const tree = parser.parse(text)!
        const read = readGo(tree, p, hash, text)
        trees.set(p, { tree, declAt: read.declAt })
        files.push(read.file)
      }
    })
    const index = time('go.index', () => new GoIndex(files, modules))

    // pass B: names resolved, from the cache when the file and what it can see are unchanged
    const moduleSurfaces = new Map<GoModule | undefined, string>()
    const moduleSurface = (m: GoModule | undefined) => {
      let s = moduleSurfaces.get(m)
      if (s === undefined) moduleSurfaces.set(m, (s = index.moduleSurface(m)))
      return s
    }
    const links = new Map<string, Linked>()
    let relinked = 0
    time('go.link', () => {
      for (const f of files) {
        const pkg = index.pkgOf(f)
        const linkKey = hashText(`${f.hash}\n${index.closureOf(pkg)}`)
        const cached = cache!.links[f.path]
        if (cached?.key === linkKey && (cached.module === undefined || cached.module === moduleSurface(pkg.module))) {
          links.set(f.path, cached)
          continue
        }
        let t = trees.get(f.path)
        if (!t) {
          const { text, hash } = texts.get(f.path)!
          const tree = parser.parse(text)!
          t = { tree, declAt: readGo(tree, f.path, hash, text).declAt }
          trees.set(f.path, t)
        }
        const link = linkGo(t.tree, f, t.declAt, index, ctx.config.maxSitesPerEdge)
        links.set(f.path, { key: linkKey, ...(link.module ? { module: moduleSurface(pkg.module) } : {}), link, imports: importsOf(f, link, index, ctx) })
        relinked++
      }
    })
    for (const t of trees.values()) t.tree.delete()
    parser.delete()
    ctx.cacheStats.hits += hits
    ctx.cacheStats.misses += paths.length - hits
    ctx.log(`${paths.length} Go files: ${paths.length - hits} read, ${relinked} linked, the rest from cache`)

    const next: CacheFile = { key, decls: Object.fromEntries(files.map(f => [f.path, f])), links: Object.fromEntries(links) }
    if (session) session.cache = next
    if (cacheFile && relinked)
      time('go.cacheWrite', () => {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
        fs.writeFileSync(cacheFile, JSON.stringify(next))
      })

    // whole-program parts: interface satisfaction, and tags a file put on another's declarations (a handler's route)
    const implementations = time('go.implements', () => index.implementations(ctx.config.maxSitesPerEdge))
    const tags = new Map<string, string[]>()
    for (const { link } of links.values())
      for (const [id, list] of Object.entries(link.tags)) {
        const known = tags.get(id) ?? []
        for (const t of list) if (!known.includes(t)) known.push(t)
        tags.set(id, known)
      }

    for (const f of files) {
      const { link, imports } = links.get(f.path)!
      const refs: RefRecord[] = [...link.refs, ...(implementations.get(f.path) ?? [])]
      yield {
        path: f.path,
        hash: f.hash,
        loc: f.loc,
        complexity: f.complexity,
        tags: f.errors ? ['parse-errors'] : [],
        symbols: f.decls.map(d => ({
          id: d.id,
          kind: d.kind,
          name: d.name,
          subkind: d.subkind,
          parent: d.parent,
          range: d.range,
          exported: d.exported,
          ...(d.signature ? { signature: d.signature } : {}),
          tags: [...d.tags, ...(tags.get(d.id) ?? [])],
          loc: d.loc,
          complexity: d.complexity,
        })),
        refs,
        specifiers: [],
        deps: {},
        unresolvedIdentifiers: link.unresolved,
        ...(Object.keys(link.facts).length ? { facts: link.facts } : {}),
        language: 'go',
        imports,
      }
    }
  },
}

/** Folders with a go.mod: their module path, and the module paths they require. */
function findGoModules(all: string[], ctx: AnalyzeContext): GoModule[] {
  const out: GoModule[] = []
  for (const f of all) {
    if (f !== 'go.mod' && !f.endsWith('/go.mod')) continue
    let text = ''
    try {
      text = fs.readFileSync(ctx.abs(f), 'utf8')
    } catch {
      continue
    }
    const m = /^\s*module\s+"?([^\s"]+)"?/m.exec(text)
    if (!m) continue
    const requires = [...text.matchAll(/^\s*(?:require\s+)?([\w.~-]+(?:\/[\w.~-]+)*)\s+v\d[\w.+-]*/gm)].map(r => r[1]).filter(p => p !== 'require')
    out.push({ dir: f === 'go.mod' ? '' : f.slice(0, -'/go.mod'.length), path: m[1], requires: [...new Set(requires)].sort() })
  }
  return out.sort((a, b) => (a.dir < b.dir ? -1 : 1))
}

/**
 * A file's imports, resolved per build target (the same in each): to the
 * files of the imported package its references reach, or to the package's
 * first file when it reaches none (`_` imports, or only constants of
 * another file … that resolved nowhere); to `x:go:` for outside packages.
 */
function importsOf(f: GoFile, link: LinkResult, index: GoIndex, ctx: AnalyzeContext): ImportRecord[] {
  const used = new Map<string, Set<string>>()
  for (const r of link.refs) {
    const target = fileIdOf(r.target)?.slice(2)
    const tf = target && index.files.get(target)
    if (!tf) continue
    const key = index.pkgOf(tf).key
    const set = used.get(key) ?? new Set<string>()
    set.add(target)
    used.set(key, set)
  }
  const out: ImportRecord[] = []
  for (const imp of f.imports) {
    const r = index.resolveImport(imp, f)
    let targets: ResolvedTarget[]
    if (r.kind === 'project') {
      const files = used.get(r.pkg.key)
      const first = r.pkg.files.find(x => !x.path.endsWith('_test.go')) ?? r.pkg.files[0]
      targets = files?.size ? [...files].sort().map(p => ({ kind: 'file' as const, path: p })) : [{ kind: 'file', path: first.path }]
    } else if (r.kind === 'external') targets = [{ kind: 'external', id: r.id }]
    else targets = [{ kind: 'unresolved' }]
    const subkind = imp.name === '_' ? 'side-effect' : 'static'
    for (const t of targets) out.push({ spec: imp.path, kind: 'imports', subkind, line: imp.line, col: imp.col, resolved: Object.fromEntries(ctx.targets.map(x => [x.name, t])) })
  }
  return out
}
