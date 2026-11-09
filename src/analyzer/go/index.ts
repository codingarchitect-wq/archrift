// Name resolution for the Go reader (docs/POLYGLOT.md, P5). A package is a
// directory (its `_test` package apart); its module is the nearest folder
// with a go.mod, whose `module` path maps import paths to directories. Every
// package-level name is visible in all files of the package; other packages
// are reached through a file's imports. Values are followed through their
// declared types: a field's, a parameter's, a function's results. A type's
// members are its fields, its methods (declared in any file of the package)
// and, by promotion, those of the types it embeds.
import { hashText } from '../cache.ts'
import type { RefRecord } from '../fragment.ts'
import type { GoDecl, GoExpr, GoFile, GoImport, GoModule, GoType } from './model.ts'

export interface GoPackage {
  /** The directory, or `dir#name` for an external test package (`package x_test`). */
  key: string
  dir: string
  name: string
  module?: GoModule
  /** The import path, for a package in a module. */
  importPath?: string
  files: GoFile[]
  /** Package-level names (functions, types, constants, variables) of all its files. */
  top: Map<string, GoDecl>
}

export type Imported =
  | { kind: 'project'; pkg: GoPackage; imp: GoImport }
  | { kind: 'external'; id: string; path: string; imp: GoImport }
  /** A path inside a project module where no package is. */
  | { kind: 'missing'; imp: GoImport }

export interface FileScope {
  file: GoFile
  pkg: GoPackage
  /** Imports by the name they bind (an alias, or the package's name). */
  names: Map<string, Imported>
  /** `import . "x"`. */
  dots: Imported[]
  /** Some outside package's name is a guess (`go-multierror`): an unknown `x.Y` isn't counted as unresolved. */
  vague: boolean
  /** An outside package is dot-imported: an unknown name may be one of its. */
  externalDot: boolean
}

/** A value: its type as written, and the file whose imports qualify it. */
export interface Value {
  t: GoType
  file: GoFile
}

/** An outside package's node: the standard library by its full path, others by their repository (three segments, or up to a `.git` one). */
export function goExternal(importPath: string): string {
  const parts = importPath.split('/')
  if (!parts[0].includes('.')) return `x:go:${importPath}`
  // Go's own rule for unknown hosts: a `.git` (`.hg` …) segment ends the repository
  const vcs = parts.findIndex(p => /\.(git|hg|svn|bzr)$/.test(p))
  return `x:go:${parts.slice(0, vcs >= 0 ? vcs + 1 : 3).join('/')}`
}

/** The name an outside package most likely declares: the last path segment without a major version or a go- prefix. */
export function guessPackageName(importPath: string): { name: string; vague: boolean } {
  const parts = importPath.split('/')
  let last = parts[parts.length - 1]
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2]
  last = last.replace(/\.v\d+$/, '')
  const clean = last.replace(/^go-/, '').replace(/[-.]go$/, '')
  return { name: clean.replace(/\W/g, '_'), vague: clean !== last || !/^[A-Za-z_]\w*$/.test(clean) }
}

const FUNCS = new Set(['function', 'method'])
export const isFunc = (d: GoDecl) => FUNCS.has(d.subkind)

export class GoIndex {
  readonly files = new Map<string, GoFile>()
  readonly decls = new Map<string, GoDecl>()
  readonly packages = new Map<string, GoPackage>()
  /** Modules, deepest folder first. */
  readonly modules: GoModule[]
  private readonly fileOfDecl = new Map<string, GoFile>()
  private readonly pkgOfFile = new Map<string, GoPackage>()
  /** Several when copies of a module sit in the tree (vendored, license reports): the nearest one wins. */
  private readonly byImportPath = new Map<string, GoPackage[]>()
  private readonly membersOf = new Map<string, Map<string, GoDecl>>()
  private readonly scopes = new Map<string, FileScope>()
  private readonly unknownMemo = new Map<string, boolean>()
  private containers?: Map<string, GoDecl[]>
  private readonly surfaceMemo = new Map<string, string>()
  private readonly closureMemo = new Map<string, string>()
  private readonly depsMemo = new Map<string, { packages: GoPackage[]; missing: string[] }>()

  constructor(files: Iterable<GoFile>, modules: GoModule[]) {
    this.modules = [...modules].sort((a, b) => b.dir.length - a.dir.length || (a.dir < b.dir ? -1 : 1))
    for (const f of files) {
      this.files.set(f.path, f)
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
      const key = f.pkg.endsWith('_test') && f.pkg !== '_test' ? `${dir}#${f.pkg}` : dir
      let pkg = this.packages.get(key)
      if (!pkg) {
        const module = this.moduleOf(f.path)
        const importPath = module && key === dir ? (dir === module.dir ? module.path : `${module.path}/${dir.slice(module.dir ? module.dir.length + 1 : 0)}`) : undefined
        pkg = { key, dir, name: f.pkg, module, importPath, files: [], top: new Map() }
        this.packages.set(key, pkg)
        if (importPath) {
          const list = this.byImportPath.get(importPath)
          if (list) list.push(pkg)
          else this.byImportPath.set(importPath, [pkg])
        }
      }
      // a package's own files name it; a `_test.go` file of the same package doesn't rename it
      if (!f.path.endsWith('_test.go')) pkg.name = f.pkg
      pkg.files.push(f)
      this.pkgOfFile.set(f.path, pkg)
      for (const d of f.decls) {
        this.decls.set(d.id, d)
        this.fileOfDecl.set(d.id, f)
        if (d.kind === 'symbol' && !d.recv && !pkg.top.has(d.name)) pkg.top.set(d.name, d)
      }
    }
    for (const pkg of this.packages.values()) pkg.files.sort((a, b) => (a.path < b.path ? -1 : 1))
    for (const f of this.files.values()) {
      const pkg = this.pkgOfFile.get(f.path)!
      for (const d of f.decls) {
        if (d.kind === 'member') this.addMember(d.parent, d.name, d)
        else if (d.recv) {
          // a method declared away from its type's file: Type.method
          const owner = pkg.top.get(d.recv)
          if (owner?.type) this.addMember(owner.id, d.name.slice(d.recv.length + 1), d)
        }
      }
    }
  }

  private addMember(owner: string, name: string, d: GoDecl) {
    let m = this.membersOf.get(owner)
    if (!m) this.membersOf.set(owner, (m = new Map()))
    if (!m.has(name)) m.set(name, d)
  }

  fileOf(declId: string): GoFile | undefined {
    return this.fileOfDecl.get(declId)
  }

  pkgOf(file: GoFile): GoPackage {
    return this.pkgOfFile.get(file.path)!
  }

  /** The module a path belongs to: the deepest folder with a go.mod above it. */
  moduleOf(path: string): GoModule | undefined {
    return this.modules.find(m => m.dir === '' || path.startsWith(`${m.dir}/`))
  }

  /** What an import path names from a file: a project package, a path in a project module with no package, or an outside package. */
  resolveImport(imp: GoImport, from: GoFile): Imported {
    const pkgs = this.byImportPath.get(imp.path)
    if (pkgs) return { kind: 'project', pkg: pkgs.length === 1 ? pkgs[0] : nearest(pkgs, p => p.dir, from.path), imp }
    if (this.modules.some(m => imp.path === m.path || imp.path.startsWith(`${m.path}/`))) return { kind: 'missing', imp }
    return { kind: 'external', id: goExternal(imp.path), path: imp.path, imp }
  }

  scope(file: GoFile): FileScope {
    let s = this.scopes.get(file.path)
    if (s) return s
    s = { file, pkg: this.pkgOf(file), names: new Map(), dots: [], vague: false, externalDot: false }
    for (const imp of file.imports) {
      const r = this.resolveImport(imp, file)
      if (imp.name === '.') s.dots.push(r)
      if (imp.name === '_' || imp.name === '.') continue
      let name = imp.name
      if (!name) {
        if (r.kind === 'project') name = r.pkg.name
        else {
          const g = guessPackageName(imp.path)
          name = g.name
          if (g.vague) s.vague = true
        }
      }
      s.names.set(name, r)
    }
    s.externalDot = s.dots.some(d => d.kind !== 'project')
    this.scopes.set(file.path, s)
    return s
  }

  /** A package-level declaration of the file's package or of a dot-imported one. */
  topLevel(name: string, file: GoFile): GoDecl | undefined {
    const own = this.pkgOf(file).top.get(name)
    if (own) return own
    for (const d of this.scope(file).dots) if (d.kind === 'project') {
      const found = d.pkg.top.get(name)
      if (found) return found
    }
    return undefined
  }

  /** The project type a type stands for (pointers and aliases seen through); undefined for outside and built-in types. */
  typeDecl(t: GoType, file: GoFile, depth = 0): GoDecl | undefined {
    if ('ptr' in t) return this.typeDecl(t.ptr, file, depth)
    if (!('n' in t)) return undefined
    let d: GoDecl | undefined
    if (t.q) {
      const imp = this.scope(file).names.get(t.q)
      if (imp?.kind === 'project') d = imp.pkg.top.get(t.n)
    } else d = this.topLevel(t.n, file)
    if (!d?.type) return undefined
    if (d.alias && d.underlying && depth < 8) return this.typeDecl(d.underlying, this.fileOf(d.id)!, depth + 1) ?? d
    return d
  }

  /** The value a declaration holds: a variable's, field's or constant's type; a function as a value. */
  valueOf(d: GoDecl, depth = 0): Value | undefined {
    const file = this.fileOf(d.id)
    if (!file || d.type) return undefined
    if (d.valueType) return { t: d.valueType, file }
    if (d.initCall && depth < 8) {
      const fn = d.initCall.q ? this.qualified(d.initCall.q, d.initCall.n, file) : this.topLevel(d.initCall.n, file)
      if (fn && isFunc(fn)) return this.resultsOf(fn)[0]
      if (fn?.type) return { t: { n: fn.name }, file: this.fileOf(fn.id)! }
      return undefined
    }
    if (isFunc(d) || d.results) return { t: { fn: d.results ?? [] }, file }
    return undefined
  }

  /** `pkg.Name` from a file: the declaration in the imported project package. */
  qualified(q: string, name: string, file: GoFile): GoDecl | undefined {
    const imp = this.scope(file).names.get(q)
    return imp?.kind === 'project' ? imp.pkg.top.get(name) : undefined
  }

  resultsOf(d: GoDecl): Value[] {
    const file = this.fileOf(d.id)
    return file ? (d.results ?? []).map(t => ({ t, file })) : []
  }

  /** A slice's, array's, map's or channel's element (also through a named type over one). */
  elemOf(v: Value, depth = 0): Value | undefined {
    const t = v.t
    if ('ptr' in t) return this.elemOf({ t: t.ptr, file: v.file }, depth)
    if ('slice' in t) return { t: t.slice, file: v.file }
    if ('map' in t) return { t: t.map, file: v.file }
    if ('chan' in t) return { t: t.chan, file: v.file }
    if ('n' in t && depth < 8) {
      const d = this.typeDecl(t, v.file)
      if (d?.type === 'type' && d.underlying) return this.elemOf({ t: d.underlying, file: this.fileOf(d.id)! }, depth + 1)
    }
    return undefined
  }

  /** A map's key type. */
  keyOf(v: Value): Value | undefined {
    const t = v.t
    if ('map' in t) return { t: t.key, file: v.file }
    if ('n' in t) {
      const d = this.typeDecl(t, v.file)
      if (d?.type === 'type' && d.underlying && 'map' in d.underlying) return { t: d.underlying.key, file: this.fileOf(d.id)! }
    }
    return undefined
  }

  /** A field or method of a type: its own, then promoted from embedded types; a defined type over a struct has its fields. */
  member(t: GoDecl, name: string, seen = new Set<string>()): GoDecl | undefined {
    if (seen.has(t.id)) return undefined
    seen.add(t.id)
    const own = this.membersOf.get(t.id)?.get(name)
    if (own) return own
    const file = this.fileOf(t.id)!
    for (const e of t.embeds ?? []) {
      const et = this.typeDecl(e, file)
      const found = et && this.member(et, name, seen)
      if (found) return found
    }
    if (t.type === 'type' && t.underlying) {
      const u = this.typeDecl(t.underlying, file)
      if (u) return this.member(u, name, seen)
    }
    return undefined
  }

  /** Whether a type may have members this index can't see: it embeds (or is defined over) an outside type. */
  hasUnknownMembers(t: GoDecl, seen = new Set<string>()): boolean {
    const memo = this.unknownMemo.get(t.id)
    if (memo !== undefined) return memo
    if (seen.has(t.id)) return false
    seen.add(t.id)
    const file = this.fileOf(t.id)!
    let unknown = false
    for (const e of t.embeds ?? []) {
      const et = this.typeDecl(e, file)
      if (!et || this.hasUnknownMembers(et, seen)) unknown = true
    }
    if (t.type === 'type' && t.underlying) {
      const u = this.typeDecl(t.underlying, file)
      if (!u || this.hasUnknownMembers(u, seen)) unknown = true
    }
    this.unknownMemo.set(t.id, unknown)
    return unknown
  }

  /** A string constant's value (literals, other constants, concatenations); undefined when not known before run time. */
  evaluate(e: GoExpr, file: GoFile, depth = 0): string | undefined {
    if (depth > 12) return undefined
    if ('s' in e) return e.s
    if ('cat' in e) {
      let out = ''
      for (const part of e.cat) {
        const v = this.evaluate(part, file, depth + 1)
        if (v === undefined) return undefined
        out += v
      }
      return out
    }
    const d = e.q ? this.qualified(e.q, e.ref, file) : this.topLevel(e.ref, file)
    return d?.init ? this.evaluate(d.init, this.fileOf(d.id)!, depth + 1) : undefined
  }

  /**
   * Where a configuration struct sits in the configuration tree, as field
   * names from the root: `KafkaProperties` → ['Kafka'] when exactly one
   * exported field of its module has that type (`Configuration.Kafka`); []
   * for a root (no field has its type); undefined when several do.
   */
  containerPath(t: GoDecl, seen = new Set<string>()): string[] | undefined {
    if (seen.has(t.id)) return undefined
    seen.add(t.id)
    if (!this.containers) {
      this.containers = new Map()
      for (const d of this.decls.values()) {
        if (d.kind !== 'member' || d.subkind !== 'property' || !d.exported || !d.valueType || d.tags.includes('embedded')) continue
        const ft = this.typeDecl(d.valueType, this.fileOf(d.id)!)
        if (!ft?.type) continue
        const list = this.containers.get(ft.id)
        if (list) list.push(d)
        else this.containers.set(ft.id, [d])
      }
    }
    const module = this.moduleOf(this.fileOf(t.id)!.path)
    const fields = (this.containers.get(t.id) ?? []).filter(f => this.moduleOf(this.fileOf(f.id)!.path) === module)
    if (!fields.length) return []
    if (fields.length > 1) return undefined
    const parent = this.decls.get(fields[0].parent)
    const up = parent && this.containerPath(parent, seen)
    return up && [...up, fields[0].name]
  }

  /** A concrete type's methods, its own and promoted ones, by name. */
  methodSet(t: GoDecl, seen = new Set<string>()): Map<string, GoDecl> {
    const out = new Map<string, GoDecl>()
    if (seen.has(t.id)) return out
    seen.add(t.id)
    for (const [name, m] of this.membersOf.get(t.id) ?? []) if (m.subkind === 'method') out.set(name, m)
    const file = this.fileOf(t.id)!
    for (const e of t.embeds ?? []) {
      const et = this.typeDecl(e, file)
      if (et) for (const [name, m] of this.methodSet(et, seen)) if (!out.has(name)) out.set(name, m)
    }
    return out
  }

  /** An interface's methods with those of the interfaces it embeds; undefined when it embeds an outside one. */
  interfaceMethods(t: GoDecl, seen = new Set<string>()): Map<string, GoDecl> | undefined {
    const out = new Map<string, GoDecl>()
    if (seen.has(t.id)) return out
    seen.add(t.id)
    for (const [name, m] of this.membersOf.get(t.id) ?? []) if (m.subkind === 'method') out.set(name, m)
    const file = this.fileOf(t.id)!
    for (const e of t.embeds ?? []) {
      const et = this.typeDecl(e, file)
      if (et?.type !== 'interface') return undefined
      const inner = this.interfaceMethods(et, seen)
      if (!inner) return undefined
      for (const [name, m] of inner) if (!out.has(name)) out.set(name, m)
    }
    return out
  }

  /**
   * Go's interfaces are satisfied structurally: a type implements every
   * project interface (with at least one method) whose methods its method
   * set has, matched by name and by the number of parameters and results.
   * Only within a module, or into a module its go.mod requires. Gives
   * `implements` from the type to the interface and from each method to the
   * interface method, by the file holding the source.
   */
  implementations(maxSites: number): Map<string, RefRecord[]> {
    const ifaces: { decl: GoDecl; methods: Map<string, GoDecl>; module?: GoModule }[] = []
    const byMethod = new Map<string, number[]>()
    for (const d of this.decls.values()) {
      if (d.type !== 'interface') continue
      const methods = this.interfaceMethods(d)
      if (!methods?.size) continue
      const i = ifaces.push({ decl: d, methods, module: this.moduleOf(this.fileOf(d.id)!.path) }) - 1
      for (const name of methods.keys()) {
        const list = byMethod.get(name)
        if (list) list.push(i)
        else byMethod.set(name, [i])
      }
    }
    const out = new Map<string, RefRecord[]>()
    const add = (source: GoDecl, target: GoDecl) => {
      const file = this.fileOf(source.id)!.path
      const list = out.get(file) ?? []
      list.push({ source: source.id, target: target.id, kind: 'implements', count: 1, sites: maxSites > 0 ? [source.range[0], source.range[1]] : [] })
      out.set(file, list)
    }
    const same = (a: GoDecl, b: GoDecl) => (a.params?.length ?? 0) === (b.params?.length ?? 0) && (a.results?.length ?? 0) === (b.results?.length ?? 0)
    for (const d of this.decls.values()) {
      if (!d.type || d.type === 'interface') continue
      const set = this.methodSet(d)
      if (!set.size) continue
      const module = this.moduleOf(this.fileOf(d.id)!.path)
      const hits = new Map<number, number>()
      for (const [name, m] of set) for (const i of byMethod.get(name) ?? []) if (same(m, ifaces[i].methods.get(name)!)) hits.set(i, (hits.get(i) ?? 0) + 1)
      for (const [i, n] of hits) {
        const iface = ifaces[i]
        if (n !== iface.methods.size) continue
        if (iface.module !== module && !(module && iface.module && module.requires.includes(iface.module.path) && this.nearestModule(iface.module.path, module.dir) === iface.module)) continue
        add(d, iface.decl)
        for (const [name, im] of iface.methods) add(set.get(name)!, im)
      }
    }
    return out
  }

  /** What other packages see of a package: its declarations without positions or sizes. */
  surfaceOf(pkg: GoPackage): string {
    let s = this.surfaceMemo.get(pkg.key)
    if (s === undefined) {
      s = hashText(
        JSON.stringify(
          pkg.files.map(f => [
            f.path,
            f.pkg,
            f.imports.map(i => `${i.path}|${i.name ?? ''}`),
            f.decls.map(d => [d.id, d.kind, d.subkind, d.parent, d.exported, d.tags, d.type, d.underlying, d.alias, d.embeds, d.valueType, d.initCall, d.results, d.params, d.recv, d.typeParams, d.init]),
          ]),
        ),
      )
      this.surfaceMemo.set(pkg.key, s)
    }
    return s
  }

  /**
   * A hash of everything a file of the package can resolve names into: the
   * surfaces of the package and of the packages it imports, transitively
   * (a type a value goes through is declared in one of them), and which
   * imports point at no package.
   */
  closureOf(pkg: GoPackage): string {
    let h = this.closureMemo.get(pkg.key)
    if (h !== undefined) return h
    const seen = new Set<string>()
    const parts: string[] = []
    const stack = [pkg]
    while (stack.length) {
      const p = stack.pop()!
      if (seen.has(p.key)) continue
      seen.add(p.key)
      parts.push(`${p.key}=${this.surfaceOf(p)}`)
      const deps = this.depsOf(p)
      stack.push(...deps.packages)
      for (const m of deps.missing) parts.push(`missing:${m}`)
    }
    h = hashText(parts.sort().join('\n'))
    this.closureMemo.set(pkg.key, h)
    return h
  }

  /** Of the modules with a module path, the one nearest a folder. */
  nearestModule(modulePath: string, dir: string): GoModule | undefined {
    const candidates = this.modules.filter(m => m.path === modulePath)
    return candidates.length > 1 ? nearest(candidates, m => m.dir, `${dir}/`) : candidates[0]
  }

  /** The project packages a package's files import, and the import paths in project modules that name no package. */
  private depsOf(pkg: GoPackage): { packages: GoPackage[]; missing: string[] } {
    let d = this.depsMemo.get(pkg.key)
    if (!d) {
      const packages = new Set<GoPackage>()
      const missing = new Set<string>()
      for (const f of pkg.files)
        for (const imp of f.imports) {
          const r = this.resolveImport(imp, f)
          if (r.kind === 'project') packages.add(r.pkg)
          else if (r.kind === 'missing') missing.add(imp.path)
        }
      this.depsMemo.set(pkg.key, (d = { packages: [...packages], missing: [...missing] }))
    }
    return d
  }

  /** A hash of every package of a module (struct containment for configuration paths reaches across it). */
  moduleSurface(module: GoModule | undefined): string {
    return hashText(
      [...this.packages.values()]
        .filter(p => p.module === module)
        .map(p => `${p.key}=${this.surfaceOf(p)}`)
        .sort()
        .join('\n'),
    )
  }
}

/** Of several candidates, the one whose folder shares the most leading path segments with `path`. */
function nearest<T>(candidates: T[], dirOf: (c: T) => string, path: string): T {
  const parts = path.split('/')
  const shared = (dir: string) => {
    const d = dir.split('/')
    let i = 0
    while (i < d.length && d[i] === parts[i]) i++
    return i
  }
  let best = candidates[0]
  let score = -1
  for (const c of candidates) {
    const n = shared(dirOf(c))
    if (n > score) {
      best = c
      score = n
    }
  }
  return best
}
