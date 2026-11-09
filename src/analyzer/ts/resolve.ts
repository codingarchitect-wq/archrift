// Module resolution per build target. A target is the project's
// compiler options plus its moduleSuffixes, which reproduces bundler setups
// like Turbopack's resolveExtensions (verified against it in M0).
import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import ts from 'typescript'
import { builtinId, npmId, packageName } from '../../core/ids.ts'
import type { Target } from '../config.ts'
import type { ResolvedTarget, SpecifierRecord } from '../fragment.ts'
import type { ProjectSet } from './project.ts'
import { isSourceFile } from './project.ts'

export class Resolver {
  private readonly set: ProjectSet
  private readonly targets: Target[]
  private readonly options: ts.CompilerOptions[][] // [project][target]
  private readonly caches: ts.ModuleResolutionCache[][]
  private readonly aliases: { prefix: string; dirs: string[] }[][] // [project]

  constructor(root: string, set: ProjectSet, targets: Target[]) {
    this.set = set
    this.targets = targets
    this.options = set.projects.map(p => targets.map(t => ({ ...p.options, moduleSuffixes: t.moduleSuffixes })))
    this.caches = this.options.map(perTarget => perTarget.map(o => ts.createModuleResolutionCache(root, s => s, o)))
    this.aliases = set.projects.map(p => {
      const base = (p.options.pathsBasePath as string | undefined) ?? (p.configFile ? path.dirname(p.configFile) : root)
      return Object.entries(p.options.paths ?? {}).flatMap(([key, dirs]) =>
        key.endsWith('*') ? [{ prefix: key.slice(0, -1), dirs: dirs.filter(d => d.endsWith('*')).map(d => path.resolve(base, d.slice(0, -1))) }] : [],
      )
    })
  }

  /** Options for the primary target, which the program (and so symbol resolution) uses. */
  primaryOptions(project: number) {
    return this.options[project][0]
  }

  resolve(spec: SpecifierRecord, fromAbs: string, project: number): Record<string, ResolvedTarget> {
    const out: Record<string, ResolvedTarget> = {}
    this.targets.forEach((t, ti) => (out[t.name] = this.resolveFor(spec, fromAbs, project, ti)))
    return out
  }

  private resolveFor(spec: SpecifierRecord, fromAbs: string, project: number, target: number): ResolvedTarget {
    const s = spec.spec
    if (s.startsWith('node:') || (isBuiltin(s) && !this.isLocal(s))) return { kind: 'external', id: builtinId(s) }
    if (spec.kind === 'worker') return this.fileTarget(path.resolve(path.dirname(fromAbs), s))

    const r = ts.resolveModuleName(s, fromAbs, this.options[project][target], ts.sys, this.caches[project][target]).resolvedModule
    if (r) {
      if (r.isExternalLibraryImport || r.resolvedFileName.includes('/node_modules/'))
        return { kind: 'external', id: npmId(this.isLocal(s) ? (r.packageId?.name ?? s) : packageName(s)) }
      return this.fileTarget(path.resolve(r.resolvedFileName))
    }
    // not a module TypeScript can resolve: CSS, images, JSON without resolveJsonModule, …
    for (const base of this.candidates(s, fromAbs, project)) if (isFile(base)) return this.fileTarget(base)
    if (!this.isLocal(s) && !this.isAliased(s, project)) return { kind: 'external', id: npmId(packageName(s)) }
    return { kind: 'unresolved' }
  }

  private fileTarget(abs: string): ResolvedTarget {
    if (this.set.owner.has(abs)) return { kind: 'file', path: this.set.rel(abs) }
    const rel = this.set.rel(abs)
    if (rel.startsWith('..')) return { kind: 'external', id: `x:outside:${rel}` }
    if (this.set.excluded(rel) || isSourceFile(rel)) return { kind: 'excluded', path: rel }
    return isFile(abs) ? { kind: 'asset', path: rel } : { kind: 'unresolved' }
  }

  private isLocal(s: string) {
    return s.startsWith('.') || s.startsWith('/')
  }

  private isAliased(s: string, project: number) {
    return this.aliases[project].some(a => s.startsWith(a.prefix))
  }

  private candidates(s: string, fromAbs: string, project: number): string[] {
    if (this.isLocal(s)) return [path.resolve(path.dirname(fromAbs), s)]
    return this.aliases[project].filter(a => s.startsWith(a.prefix)).flatMap(a => a.dirs.map(d => path.join(d, s.slice(a.prefix.length))))
  }
}

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
