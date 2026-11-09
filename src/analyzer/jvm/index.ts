// Name resolution for the JVM reader (docs/POLYGLOT.md, P3): with no compiler
// to ask, a name is looked up the way Kotlin scopes it — the enclosing types
// and their supertypes, explicit imports, the file's own package, star
// imports — in an index of every Kotlin declaration and Avro record. A name
// declared in several modules resolves to the caller's own module first, then
// to the modules its build file names, then to any.
import type { Expr, JvmDecl, JvmFile, TypeRef } from './model.ts'

export interface Scope {
  file: JvmFile
  /** Enclosing types, outermost first. */
  types: JvmDecl[]
}

/** Gradle (or Go, Maven) modules: folders with a build file, and the modules each one's build file names. */
export interface Modules {
  /** Module folders, longest first. */
  dirs: string[]
  deps: Map<string, Set<string>>
}

export class JvmIndex {
  readonly files = new Map<string, JvmFile>()
  readonly decls = new Map<string, JvmDecl>()
  private readonly fileOfDecl = new Map<string, JvmFile>()
  private readonly typesByFqn = new Map<string, JvmDecl[]>()
  private readonly topByFqn = new Map<string, JvmDecl[]>()
  private readonly pkgTypes = new Map<string, Map<string, JvmDecl[]>>()
  private readonly pkgTop = new Map<string, Map<string, JvmDecl[]>>()
  private readonly packages = new Set<string>()
  private readonly membersOf = new Map<string, Map<string, JvmDecl[]>>()
  private readonly nestedOf = new Map<string, Map<string, JvmDecl>>()
  private readonly outerOf = new Map<string, JvmDecl>()
  private readonly superMemo = new Map<string, { decl: JvmDecl; call: boolean }[]>()
  private readonly modules: Modules
  private readonly moduleMemo = new Map<string, string>()

  constructor(files: Iterable<JvmFile>, modules: Modules) {
    this.modules = modules
    for (const f of files) {
      this.files.set(f.path, f)
      this.packages.add(f.pkg)
      for (const d of f.decls) {
        this.decls.set(d.id, d)
        this.fileOfDecl.set(d.id, f)
      }
    }
    for (const f of this.files.values()) {
      for (const d of f.decls) {
        if (d.type) {
          if (d.fqn) push(this.typesByFqn, d.fqn, d)
          const dot = d.name.lastIndexOf('.')
          if (dot < 0) pushIn(this.pkgTypes, f.pkg, d.name, d)
          else {
            const outer = this.decls.get(`${d.id.slice(0, d.id.indexOf('#') + 1)}${d.name.slice(0, dot)}`)
            if (outer) {
              this.outerOf.set(d.id, outer)
              let m = this.nestedOf.get(outer.id)
              if (!m) this.nestedOf.set(outer.id, (m = new Map()))
              m.set(d.name.slice(dot + 1), d)
            }
          }
        } else if (d.kind === 'symbol') {
          if (d.fqn) push(this.topByFqn, d.fqn, d)
          pushIn(this.pkgTop, f.pkg, d.name, d)
        } else pushIn(this.membersOf, d.parent, d.name, d)
      }
    }
  }

  fileOf(declId: string): JvmFile | undefined {
    return this.fileOfDecl.get(declId)
  }

  /** The module a file belongs to: the deepest folder with a build file above it ('' when none). */
  moduleOf(path: string): string {
    let m = this.moduleMemo.get(path)
    if (m === undefined) {
      m = this.modules.dirs.find(d => path.startsWith(`${d}/`)) ?? ''
      this.moduleMemo.set(path, m)
    }
    return m
  }

  /** The scope a declaration's own types are written in: its file and the types around it. */
  scopeOf(decl: JvmDecl): Scope {
    const file = this.fileOfDecl.get(decl.id)!
    const types: JvmDecl[] = []
    let t: JvmDecl | undefined = decl.type ? decl : decl.kind === 'member' ? this.decls.get(decl.parent) : undefined
    while (t) {
      types.unshift(t)
      t = this.outerOf.get(t.id)
    }
    return { file, types }
  }

  /**
   * Of several declarations of one name, those nearest the code asking: its module, then the modules
   * its build file names, then the ones theirs name, and so on (a shared schema reaches a service
   * through the libraries it names); any when none of them declares it.
   */
  pick(candidates: readonly JvmDecl[] | undefined, from: string): JvmDecl[] {
    if (!candidates?.length) return []
    if (candidates.length === 1) return [...candidates]
    const moduleOfDecl = (d: JvmDecl) => this.moduleOf(this.fileOfDecl.get(d.id)!.path)
    let ring = [this.moduleOf(from)]
    const seen = new Set(ring)
    while (ring.length) {
      const near = new Set(ring)
      const found = candidates.filter(d => near.has(moduleOfDecl(d)))
      if (found.length) return found
      ring = ring.flatMap(m => [...(this.modules.deps.get(m) ?? [])]).filter(m => !seen.has(m) && seen.add(m))
    }
    return [...candidates]
  }

  /** A type by name as written in `scope` (`Foo`, `Outer.Inner`, `com.x.Foo`, an import alias). */
  resolveType(name: readonly string[], scope: Scope, seen = new Set<string>()): JvmDecl[] {
    if (!name.length) return []
    let found = this.typeHead(name[0], scope)
    let i = 1
    if (!found.length) {
      // a qualified name: the longest prefix that is a type
      for (let k = name.length; k >= 2 && !found.length; k--) {
        const fqn = name.slice(0, k).join('.')
        found = this.pick(this.typesByFqn.get(fqn), scope.file.path)
        i = k
      }
    }
    for (; i < name.length && found.length; i++) found = found.flatMap(t => this.nestedType(t, name[i]))
    return found.flatMap(t => this.dealias(t, seen))
  }

  /** A type alias stands for its target. */
  private dealias(t: JvmDecl, seen: Set<string>): JvmDecl[] {
    if (t.type !== 'alias' || !t.valueType) return [t]
    if (seen.has(t.id)) return []
    seen.add(t.id)
    const target = this.resolveType(t.valueType.name, this.scopeOf(t), seen)
    return target.length ? target : [t]
  }

  private typeHead(simple: string, scope: Scope): JvmDecl[] {
    const from = scope.file.path
    // the enclosing types, their nested types and those of their supertypes
    for (let k = scope.types.length - 1; k >= 0; k--) {
      const t = scope.types[k]
      if (t.name.endsWith(simple) && (t.name === simple || t.name.endsWith(`.${simple}`))) return [t]
      const nested = this.nestedType(t, simple)
      if (nested.length) return nested
    }
    for (const imp of scope.file.imports) {
      if (imp.star) continue
      const last = imp.alias ?? imp.fqn.slice(imp.fqn.lastIndexOf('.') + 1)
      if (last !== simple) continue
      const t = this.pick(this.typesByFqn.get(imp.fqn), from)
      if (t.length) return t
    }
    const own = this.pick(this.pkgTypes.get(scope.file.pkg)?.get(simple), from)
    if (own.length) return own
    for (const imp of scope.file.imports) {
      if (!imp.star) continue
      const inPkg = this.pick(this.pkgTypes.get(imp.fqn)?.get(simple), from)
      if (inPkg.length) return inPkg
      // `import a.B.*`: B's nested types
      for (const outer of this.pick(this.typesByFqn.get(imp.fqn), from)) {
        const nested = this.nestedType(outer, simple)
        if (nested.length) return nested
      }
    }
    return []
  }

  /** A nested type of `t` or of its supertypes. */
  nestedType(t: JvmDecl, simple: string, seen = new Set<string>()): JvmDecl[] {
    if (seen.has(t.id)) return []
    seen.add(t.id)
    const own = this.nestedOf.get(t.id)?.get(simple)
    if (own) return [own]
    for (const s of this.supertypes(t)) {
      const found = this.nestedType(s.decl, simple, seen)
      if (found.length) return found
    }
    return []
  }

  /** A type's resolved supertypes (project types only). */
  supertypes(t: JvmDecl): { decl: JvmDecl; call: boolean }[] {
    let s = this.superMemo.get(t.id)
    if (!s) {
      this.superMemo.set(t.id, (s = []))
      const scope = this.scopeOf(t)
      // a type's header is outside its own body: its nested types aren't in scope there
      const header = { file: scope.file, types: scope.types.slice(0, -1) }
      for (const sup of t.supers ?? []) for (const decl of this.resolveType(sup.type.name, header)) if (decl.id !== t.id) s.push({ decl, call: sup.call })
    }
    return s
  }

  /**
   * Members of a type by name, from the type itself up through its supertypes.
   * `statics`: reached through the type's name (companion members, an object's
   * or enum's members); otherwise through an instance.
   */
  members(t: JvmDecl, name: string, statics: boolean, seen = new Set<string>()): JvmDecl[] {
    if (seen.has(t.id)) return []
    seen.add(t.id)
    const own = (this.membersOf.get(t.id)?.get(name) ?? []).filter(m =>
      statics ? m.companion || t.type === 'object' || t.type === 'enum' || m.subkind === 'enum-entry' : !m.companion || t.type === 'object',
    )
    if (own.length) return own
    if (statics && t.type !== 'object') return []
    for (const s of this.supertypes(t)) {
      const found = this.members(s.decl, name, statics, seen)
      if (found.length) return found
    }
    return []
  }

  /** A type's own members, in declaration order (constructor properties first). */
  ownMembers(t: JvmDecl): JvmDecl[] {
    return (this.fileOfDecl.get(t.id)?.decls ?? []).filter(d => d.kind === 'member' && d.parent === t.id)
  }

  /** Companion (and object) members of a type's supertypes: usable unqualified inside the type. */
  inheritedStatics(t: JvmDecl, name: string, seen = new Set<string>()): JvmDecl[] {
    if (seen.has(t.id)) return []
    seen.add(t.id)
    for (const s of this.supertypes(t)) {
      const found = this.members(s.decl, name, true)
      if (found.length) return found
      const deeper = this.inheritedStatics(s.decl, name, seen)
      if (deeper.length) return deeper
    }
    return []
  }

  /** What overrides `m` (a member with `override`): the same-named member up the supertypes. */
  overridden(m: JvmDecl): JvmDecl[] {
    const owner = this.decls.get(m.parent)
    if (!owner) return []
    for (const s of this.supertypes(owner)) {
      const found = this.members(s.decl, m.name, false)
      if (found.length) return found
    }
    return []
  }

  /** A top-level function or property by name in scope: imports, the package, star imports. */
  resolveTop(simple: string, scope: Scope): JvmDecl[] {
    const from = scope.file.path
    for (const imp of scope.file.imports) {
      if (imp.star) continue
      const last = imp.alias ?? imp.fqn.slice(imp.fqn.lastIndexOf('.') + 1)
      if (last !== simple) continue
      const found = this.resolveImport(imp.fqn, from).filter(d => !d.type)
      if (found.length) return found
    }
    const own = this.pick(this.pkgTop.get(scope.file.pkg)?.get(simple), from)
    if (own.length) return own
    for (const imp of scope.file.imports) {
      if (!imp.star) continue
      const inPkg = this.pick(this.pkgTop.get(imp.fqn)?.get(simple), from)
      if (inPkg.length) return inPkg
      for (const owner of this.pick(this.typesByFqn.get(imp.fqn), from)) {
        const m = this.members(owner, simple, true)
        if (m.length) return m
      }
    }
    return []
  }

  /** What an import names in the project: a type, a top-level declaration, or a type's member. */
  resolveImport(written: string, from: string): JvmDecl[] {
    // `import a.B.Companion.c` is B's companion member c
    const fqn = written.replace(/\.Companion(?=\.|$)/g, '')
    const t = this.pick(this.typesByFqn.get(fqn), from)
    if (t.length) return t
    const top = this.pick(this.topByFqn.get(fqn), from)
    if (top.length) return top
    const dot = fqn.lastIndexOf('.')
    return this.pick(this.typesByFqn.get(fqn.slice(0, dot)), from).flatMap(owner => this.members(owner, fqn.slice(dot + 1), true))
  }

  isPackage(name: string): boolean {
    return this.packages.has(name)
  }

  /**
   * A constant's value(s): string literals, concatenations and string
   * templates over other constants, arrays. Undefined when any part isn't
   * known before run time.
   */
  evaluate(e: Expr, scope: Scope, depth = 0): string[] | undefined {
    if (depth > 12) return undefined
    if ('s' in e) return [e.s]
    if ('arr' in e) {
      const out: string[] = []
      for (const x of e.arr) {
        const v = this.evaluate(x, scope, depth + 1)
        if (!v) return undefined
        out.push(...v)
      }
      return out
    }
    if ('cat' in e) {
      let acc = ['']
      for (const x of e.cat) {
        const v = this.evaluate(x, scope, depth + 1)
        if (!v || v.length !== 1) return undefined
        acc = acc.map(a => a + v[0])
      }
      return acc
    }
    if ('ref' in e) {
      const decl = this.resolveValue(e.ref, scope)
      if (!decl?.init) return undefined
      return this.evaluate(decl.init, this.scopeOf(decl), depth + 1)
    }
    return undefined
  }

  /** The declaration a name or a.b chain stands for as a value, without a receiver: a constant, an object's property. */
  resolveValue(chain: readonly string[], scope: Scope): JvmDecl | undefined {
    if (!chain.length) return undefined
    // a member of the enclosing types (a companion constant used inside its class)
    if (chain.length === 1) {
      for (let k = scope.types.length - 1; k >= 0; k--) {
        const m = this.members(scope.types[k], chain[0], true)[0] ?? this.members(scope.types[k], chain[0], false)[0]
        if (m) return m
      }
      return this.resolveTop(chain[0], scope)[0]
    }
    // Type.CONST, Outer.Inner.CONST, pkg.Type.CONST, Type.Companion.CONST
    const owner = this.resolveType(chain.slice(0, -1).filter(p => p !== 'Companion'), scope)[0]
    return owner ? this.members(owner, chain[chain.length - 1], true)[0] : undefined
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

function pushIn<V>(m: Map<string, Map<string, V[]>>, outer: string, k: string, v: V) {
  let inner = m.get(outer)
  if (!inner) m.set(outer, (inner = new Map()))
  push(inner, k, v)
}

/** A TypeRef's head as a flat name list (`Map<K, V>` → ['Map']). */
export const typeName = (t: TypeRef | undefined) => t?.name ?? []
