// The TypeScript/JavaScript LanguageAnalyzer: loads the projects, reuses
// cached fragments where nothing they depend on changed, type-checks the
// rest program by program, and resolves every module specifier per target.
//
// In a session (watch mode) it keeps what the next run can reuse: file texts
// (re-read when their mtime or size changes), parsed source files (so
// TypeScript reuses the old program's structure and binding), the programs,
// the fragments and how their specifiers resolved.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'
import { FragmentCache, globalCacheKey, hashText } from '../cache.ts'
import type { AnalyzeContext, ExtractedFile, FileFragment, ImportRecord, LanguageAnalyzer, SpecifierKind } from '../fragment.ts'
import type { EdgeKind } from '../../core/model.ts'
import { PLUGINS } from '../plugins/index.ts'
import { extractFile } from './extract.ts'
import { loadProjects } from './project.ts'
import { Resolver } from './resolve.ts'

const IMPORT_KIND: Record<SpecifierKind, { kind: EdgeKind; subkind?: string }> = {
  static: { kind: 'imports', subkind: 'static' },
  'type-only': { kind: 'imports', subkind: 'type-only' },
  'side-effect': { kind: 'imports', subkind: 'side-effect' },
  dynamic: { kind: 'imports', subkind: 'dynamic' },
  require: { kind: 'imports', subkind: 'require' },
  're-export': { kind: 're-exports', subkind: 'static' },
  're-export-type': { kind: 're-exports', subkind: 'type-only' },
  mock: { kind: 'mocks' },
  worker: { kind: 'spawns-worker' },
}

interface TsSession {
  files: Map<string, { mtimeMs: number; size: number; text: string; hash: string }>
  /** Parsed files by name: project files while their text is unchanged, library files for good. */
  sourceFiles: Map<string, ts.SourceFile>
  programs: (ts.Program | undefined)[]
  cache?: FragmentCache
  cacheKey?: string
  /** The resolutions of the last run, valid while the set of files and the options stay the same. */
  imports: Map<string, ImportRecord[]>
  layout?: string
}

export const tsAnalyzer: LanguageAnalyzer = {
  id: 'typescript',
  version: ts.version,
  detect: () => true,
  async *analyze(ctx: AnalyzeContext): AsyncIterable<FileFragment> {
    const time = <T>(label: string, fn: () => T): T => {
      const t0 = performance.now()
      try {
        return fn()
      } finally {
        ctx.timings[label] = (ctx.timings[label] ?? 0) + Math.round(performance.now() - t0)
      }
    }

    let session = ctx.session?.get('typescript') as TsSession | undefined
    if (ctx.session && !session) ctx.session.set('typescript', (session = { files: new Map(), sourceFiles: new Map(), programs: [], imports: new Map() }))
    const set = time('projects', () => loadProjects(ctx.root, ctx.config, ctx.mounts))
    const resolver = new Resolver(ctx.root, set, ctx.targets)
    const texts = new Map<string, string>()
    const hashes = new Map<string, string>() // rel → hash
    time('read', () => {
      for (const abs of set.owner.keys()) {
        const stat = session ? fs.statSync(abs) : undefined
        const known = session?.files.get(abs)
        if (known && stat && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
          texts.set(abs, known.text)
          hashes.set(set.rel(abs), known.hash)
          continue
        }
        const text = fs.readFileSync(abs, 'utf8')
        const hash = hashText(text)
        texts.set(abs, text)
        hashes.set(set.rel(abs), hash)
        if (session && stat) session.files.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, text, hash })
      }
      if (session) for (const abs of session.files.keys()) if (!set.owner.has(abs)) session.files.delete(abs)
    })
    const hashOf = (rel: string) => hashes.get(rel)

    const cacheKey = globalCacheKey(ctx.root, {
      ts: ts.version,
      options: set.projects.map((p, i) => resolver.primaryOptions(i)),
      targets: ctx.targets,
      maxSites: ctx.config.maxSitesPerEdge,
      plugins: PLUGINS.map(p => `${p.name}@${p.version}`),
    })
    // a session keeps its cache in memory; anything global changing starts it over
    const cache = session?.cache && session.cacheKey === cacheKey ? session.cache : new FragmentCache(ctx.cacheDir, cacheKey)
    const firstRun = !session?.cache
    if (session && session.cacheKey !== cacheKey) {
      session.cache = cache
      session.cacheKey = cacheKey
      session.imports.clear()
    }
    // the same files under the same options resolve the same way
    const layout = hashText(cacheKey + [...set.owner.keys()].sort().join('\n'))
    if (session && session.layout !== layout) {
      session.imports.clear()
      session.layout = layout
    }
    const resolveAll = (abs: string, file: ExtractedFile): ImportRecord[] =>
      time('resolve', () =>
        file.specifiers.map(s => ({ spec: s.spec, ...IMPORT_KIND[s.kind], line: s.line, col: s.col, resolved: resolver.resolve(s, abs, set.owner.get(abs)!) })),
      )
    const extracted = new Map<string, ExtractedFile>() // abs → extraction
    const imports = new Map<string, ImportRecord[]>()
    // in a session: unchanged files that depend on changed ones wait to see whether what they use changed
    const deferred = new Map<string, { entry: ExtractedFile; changedDeps: string[] }>()
    for (const abs of set.owner.keys()) {
      const hit = cache.lookup(set.rel(abs), hashOf)
      if (!hit) {
        const candidate = session?.programs.length ? cache.candidate(set.rel(abs), hashOf) : undefined
        if (candidate) deferred.set(abs, candidate)
        continue
      }
      // a specifier that now resolves elsewhere (new or moved file) can change what its identifiers resolve to
      const resolved = session?.imports.get(abs) ?? resolveAll(abs, hit)
      if (hit.resolution !== resolutionHash(resolved)) continue
      extracted.set(abs, hit)
      imports.set(abs, resolved)
    }
    ctx.cacheStats.hits += extracted.size
    ctx.log(`${set.owner.size} files in ${set.projects.length} project(s), ${extracted.size} from cache`)

    const pendingIn = (pi: number) => set.projects[pi].fileNames.filter(f => set.owner.get(f) === pi && !extracted.has(f) && !deferred.has(f))
    // what each changed file showed its dependents, before and after the change
    const before = new Map<string, string[]>()
    const after = new Map<string, Set<string>>()
    if (session)
      set.projects.forEach((_, pi) => {
        const old = session.programs[pi]
        if (!old) return
        const checker = old.getTypeChecker()
        for (const abs of pendingIn(pi)) {
          const entry = cache.entry(set.rel(abs))
          const sf = old.getSourceFile(abs)
          if (entry && sf) time('surface', () => before.set(set.rel(abs), surfaceOf(entry, sf, checker)))
        }
      })
    const extractOne = (abs: string, program: ts.Program, checker: ts.TypeChecker) => {
      const sf = program.getSourceFile(abs)
      if (!sf) return
      const file = extractFile(sf, hashes.get(set.rel(abs))!, {
        checker,
        rel: set.rel,
        isProjectFile: f => set.owner.has(f),
        hashOf,
        maxSites: ctx.config.maxSitesPerEdge,
        plugins: PLUGINS,
      })
      extracted.set(abs, file)
      if (before.has(set.rel(abs))) time('surface', () => after.set(set.rel(abs), new Set(surfaceOf(file, sf, checker))))
    }

    set.projects.forEach((project, pi) => {
      const pending = pendingIn(pi)
      // a session keeps its programs up to date even when nothing needs extracting, so the next change is quick
      if (!pending.length && !session) return
      ctx.cacheStats.misses += pending.length
      const options = resolver.primaryOptions(pi)
      const host = ts.createCompilerHost(options, true)
      const getSourceFile = host.getSourceFile
      host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
        const text = texts.get(fileName)
        const known = session?.sourceFiles.get(fileName)
        // the same SourceFile object for an unchanged file lets TypeScript reuse the old program's work
        if (known && (text === undefined || known.text === text)) return known
        const sf = text !== undefined ? ts.createSourceFile(fileName, text, languageVersion, true) : getSourceFile.call(host, fileName, languageVersion, onError, shouldCreate)
        if (session && sf) session.sourceFiles.set(fileName, sf)
        return sf
      }
      let program: ts.Program | undefined = time('program', () =>
        ts.createProgram({ rootNames: project.fileNames, options, host, oldProgram: session?.programs[pi] }),
      )
      if (session) session.programs[pi] = program
      const checker = time('program', () => program!.getTypeChecker())
      time('extract', () => pending.forEach(abs => extractOne(abs, program!, checker)))
      program = undefined // let the program and checker be collected before the next one
    })

    // a dependent stays valid when every file it depends on still shows everything it showed before, unchanged
    // (a new declaration can't change what an unchanged file refers to)
    for (const [abs, { entry, changedDeps }] of deferred) {
      const stable = changedDeps.every(d => before.has(d) && after.has(d) && before.get(d)!.every(line => after.get(d)!.has(line)))
      if (stable) {
        const resolved = session?.imports.get(abs) ?? resolveAll(abs, entry)
        if (entry.resolution === resolutionHash(resolved)) {
          for (const d of changedDeps) entry.deps[d] = hashOf(d)!
          extracted.set(abs, entry)
          imports.set(abs, resolved)
          ctx.cacheStats.hits++
          continue
        }
      }
      const pi = set.owner.get(abs)!
      const program = session!.programs[pi]!
      ctx.cacheStats.misses++
      time('extract', () => extractOne(abs, program, program.getTypeChecker()))
    }

    for (const [abs, file] of extracted) {
      if (imports.has(abs)) continue
      const resolved = resolveAll(abs, file)
      file.resolution = resolutionHash(resolved)
      imports.set(abs, resolved)
    }
    if (session) {
      session.imports = imports
      cache.put(extracted.values())
    }
    // a session writes the cache once, at the start; later runs keep it in memory
    if (firstRun) time('cacheWrite', () => cache.save([...extracted.values()]))

    for (const [abs, file] of extracted)
      yield { ...file, language: /\.[cm]?jsx?$/.test(abs) ? 'javascript' : 'typescript', imports: imports.get(abs)! }
  },
}

/**
 * What a file shows the files that use it: its declarations (ids, kinds,
 * signatures, members) and the types the checker gives its exports, which
 * catches an inferred return type changing under an unchanged signature.
 */
function surfaceOf(file: ExtractedFile, sf: ts.SourceFile, checker: ts.TypeChecker): string[] {
  const declarations = file.symbols.map(s => `${s.id}|${s.kind}|${s.subkind}|${s.exported}|${s.signature ?? ''}`)
  const module = checker.getSymbolAtLocation(sf)
  const types = module
    ? checker.getExportsOfModule(module).map(e => {
        const symbol = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e
        return `${e.name}:${checker.typeToString(checker.getTypeOfSymbol(symbol), undefined, ts.TypeFormatFlags.NoTruncation)}`
      })
    : []
  return [...declarations, ...types]
}

function resolutionHash(imports: ImportRecord[]) {
  return hashText(JSON.stringify(imports.map(i => i.resolved)))
}
