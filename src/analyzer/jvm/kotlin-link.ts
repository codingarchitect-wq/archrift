// Kotlin, pass B (docs/POLYGLOT.md, P3): every name in a file resolved to the
// declaration it means, through the index of all files. There is no type
// checker, so a value's type is what its declaration says: a property's or
// parameter's declared type, a function's return type, a constructor call.
// That is enough to follow Spring's constructor injection
// (`private val projectQueryService: ProjectQueryService` …
// `projectQueryService.findOne(id)` calls ProjectQueryService.findOne), and
// stops at what can't be known without inference (lambda parameters, generic
// element types): those calls get no edge rather than a wrong one.
import { fileId } from '../../core/ids.ts'
import type { EdgeKind } from '../../core/model.ts'
import type { RefRecord } from '../fragment.ts'
import { childOf, named, siteOf } from '../tree-sitter.ts'
import type { Node, Tree } from '../tree-sitter.ts'
import type { JvmIndex, Scope } from './index.ts'
import { exprOf, initializerOf, receiverOf, typeOf, typeRefOf } from './kotlin-decls.ts'
import type { JvmDecl, JvmFile, TypeRef } from './model.ts'
import { repositoryQuery, springCall, springDecl } from './spring.ts'
import type { SpringPass } from './spring.ts'

export interface LinkResult {
  refs: RefRecord[]
  facts: Record<string, unknown[]>
  /** Tags found in pass B (handlers' routes, entity tables), by declaration. */
  tags: Record<string, string[]>
  unresolved: number
}

/** A value: an instance of a type, or the type itself reached by name (its companion, an object, an enum). */
interface Value {
  decl: JvmDecl
  statics: boolean
}

/** A local name: what it holds, when its type is known; its declared type as written either way. */
interface Local {
  value?: Value
  type?: TypeRef
}

/** Debug aid, as for TypeScript: ARCHRIFT_TRACE_UNRESOLVED=1 prints every name counted as unresolved. */
const TRACE_UNRESOLVED = !!process.env.ARCHRIFT_TRACE_UNRESOLVED
const LITERALS = new Set(['null', 'true', 'false'])
/** tree-sitter makes a new object for a node on every access: compare by id. */
const same = (a: Node, b: Node | undefined | null) => !!b && a.id === b.id
/** Kotlin's own names that never resolve into the project, not counted as unresolved. */
const BUILTINS = new Set([
  'String', 'Int', 'Long', 'Short', 'Byte', 'Boolean', 'Double', 'Float', 'Char', 'Any', 'Unit', 'Nothing', 'Number', 'Comparable',
  'List', 'MutableList', 'Map', 'MutableMap', 'Set', 'MutableSet', 'Collection', 'Iterable', 'Sequence', 'Array', 'Pair', 'Triple',
  'IntArray', 'ByteArray', 'LongArray', 'CharSequence', 'Throwable', 'Exception', 'RuntimeException', 'IllegalStateException',
  'IllegalArgumentException', 'UnsupportedOperationException', 'NoSuchElementException', 'IndexOutOfBoundsException', 'Enum', 'Regex',
  'StringBuilder', 'Result', 'Lazy', 'Deprecated', 'Suppress', 'JvmStatic', 'JvmField', 'JvmOverloads', 'JvmName', 'Volatile', 'Synchronized',
  'Throws', 'Transient', 'Companion', 'UUID', 'Optional', 'LocalDate', 'LocalDateTime', 'Instant', 'Duration', 'Date', 'BigDecimal',
  'Retention', 'Target', 'AnnotationTarget', 'AnnotationRetention', 'MustBeDocumented', 'Repeatable', 'Annotation', 'NotImplementedError',
  'MutableCollection', 'MutableIterable', 'Comparator', 'HashMap', 'HashSet', 'ArrayList', 'LinkedHashMap', 'LinkedHashSet',
  'Class', 'Void', 'Thread', 'Runnable', 'System', 'Integer', 'Object', 'Math', 'InterruptedException', 'Error', 'Iterator', 'Function',
])

export function linkKotlin(tree: Tree, file: JvmFile, declAt: Map<number, JvmDecl>, index: JvmIndex, maxSites: number): LinkResult {
  const refs = new Map<string, RefRecord>()
  const facts: Record<string, unknown[]> = {}
  const tags: Record<string, string[]> = {}
  let unresolved = 0
  const fid = fileId(file.path)
  const importedNames = new Set(file.imports.filter(i => !i.star).map(i => i.alias ?? i.fqn.slice(i.fqn.lastIndexOf('.') + 1)))
  const externalStar = file.imports.some(i => i.star && !index.isPackage(i.fqn))

  // the walk's state
  let owner = fid
  const types: JvmDecl[] = []
  /** Type parameters in scope (`<T>` of the enclosing classes and functions): names, not declarations. */
  const typeParams: Set<string>[] = []
  const isTypeParam = (name: string) => typeParams.some(s => s.has(name))
  const pushTypeParams = (n: Node) => {
    const tp = childOf(n, 'type_parameters')
    typeParams.push(new Set(tp ? named(tp).flatMap(p => (p.type === 'type_parameter' ? [childOf(p, 'identifier')?.text ?? ''] : [])) : []))
  }
  const locals: Map<string, Local>[] = []
  const receivers: (Value | undefined)[] = []
  let inListener = false
  const scope = (): Scope => ({ file, types: [...types] })

  const edge = (source: string, target: string, kind: EdgeKind, at: Node | [number, number], subkind?: string) => {
    if (source === target) return
    const key = `${source}\u0000${target}\u0000${kind}\u0000${subkind ?? ''}`
    const site = Array.isArray(at) ? at : siteOf(at)
    const r = refs.get(key)
    if (r) {
      r.count++
      if (r.sites.length < maxSites * 2) r.sites.push(site[0], site[1])
    } else refs.set(key, { source, target, kind, ...(subkind ? { subkind } : {}), count: 1, sites: maxSites > 0 ? [site[0], site[1]] : [] })
  }
  const pass: SpringPass = {
    index,
    module: index.moduleOf(file.path),
    emit: (channel, fact) => void (facts[channel] ??= []).push(fact),
    tag: (id, tag) => void (tags[id] ??= []).push(tag),
    edge: (source, target, kind, subkind, site) => edge(source, target, kind, site, subkind),
  }

  const valueMemo = new Map<string, Value | null>()
  /** What a declaration gives when used as a value: a type by name, or an instance of its declared type. */
  const valueOf = (d: JvmDecl): Value | undefined => {
    if (d.type) return { decl: d, statics: true }
    let v = valueMemo.get(d.id)
    if (v === undefined) {
      const t = d.valueType && index.resolveType(d.valueType.name, index.scopeOf(d))[0]
      valueMemo.set(d.id, (v = t ? { decl: t, statics: false } : null))
    }
    return v ?? undefined
  }
  const instanceOf = (t: TypeRef | undefined): Value | undefined => {
    const decl = t && index.resolveType(t.name, scope())[0]
    return decl ? { decl, statics: false } : undefined
  }
  const kindOf = (target: JvmDecl, call: boolean): EdgeKind => (target.type ? (call ? 'instantiates' : 'references') : call && target.subkind !== 'property' && target.subkind !== 'variable' ? 'calls' : 'references')
  const local = (name: string): Local | undefined => {
    for (let i = locals.length - 1; i >= 0; i--) {
      const l = locals[i].get(name)
      if (l) return l
    }
    return undefined
  }
  const define = (name: string, l: Local) => locals[locals.length - 1]?.set(name, l)
  const countUnresolved = (name: string, at?: Node | [number, number]) => {
    if (!/^[A-Z]/.test(name) || BUILTINS.has(name) || importedNames.has(name) || externalStar || isTypeParam(name)) return
    unresolved++
    if (TRACE_UNRESOLVED) process.stderr.write(`unresolved ${file.path}:${at ? (Array.isArray(at) ? at[0] : at.startPosition.row + 1) : '?'} ${name}\n`)
  }

  /** A simple name in an expression. */
  const name = (n: Node | { text: string; site: [number, number] }, call: boolean): { value?: Value; resolved: boolean; type?: TypeRef } => {
    const text = n.text
    const at: Node | [number, number] = 'site' in n ? n.site : n
    if (LITERALS.has(text)) return { resolved: true }
    const l = local(text)
    if (l) return { value: l.value, resolved: true, type: l.type }
    for (let k = types.length - 1; k >= 0; k--) {
      let ms = index.members(types[k], text, false)
      if (!ms.length) ms = index.members(types[k], text, true)
      // a supertype's companion members are in scope inside the subtype
      if (!ms.length) ms = index.inheritedStatics(types[k], text)
      if (ms.length) {
        for (const m of ms) edge(owner, m.id, kindOf(m, call), at)
        return { value: valueOf(ms[0]), resolved: true, type: ms[0].valueType }
      }
    }
    for (let r = receivers.length - 1; r >= 0; r--) {
      const recv = receivers[r]
      if (!recv) continue
      const ms = index.members(recv.decl, text, recv.statics)
      if (ms.length) {
        for (const m of ms) edge(owner, m.id, kindOf(m, call), at)
        return { value: valueOf(ms[0]), resolved: true, type: ms[0].valueType }
      }
    }
    const ts = index.resolveType([text], scope())
    if (ts.length) {
      for (const t of ts) edge(owner, t.id, call ? 'instantiates' : 'references', at)
      return { value: { decl: ts[0], statics: !call }, resolved: true }
    }
    const tops = index.resolveTop(text, scope())
    if (tops.length) {
      for (const t of tops) edge(owner, t.id, kindOf(t, call), at)
      return { value: valueOf(tops[0]), resolved: true, type: tops[0].valueType }
    }
    countUnresolved(text, at)
    return { resolved: false }
  }

  /** `this` or `this@Outer`: the enclosing type (or an extension's receiver). */
  const thisValue = (n: Node): Value | undefined => {
    const label = /@(\w+)/.exec(n.text)?.[1]
    if (label) {
      const t = [...types].reverse().find(x => x.name === label || x.name.endsWith(`.${label}`))
      return t ? { decl: t, statics: false } : undefined
    }
    const recv = receivers[receivers.length - 1]
    if (recv) return recv
    const t = types[types.length - 1]
    return t ? { decl: t, statics: t.type === 'object' } : undefined
  }
  const superValue = (): Value | undefined => {
    const t = types[types.length - 1]
    const s = t && (index.supertypes(t).find(x => x.call) ?? index.supertypes(t)[0])
    return s ? { decl: s.decl, statics: false } : undefined
  }

  /** `a.b.c`, with `call` when the last part is called. */
  const chain = (nav: Node, call: boolean): Value | undefined => {
    const ids: Node[] = []
    let head: Node = nav
    while (head.type === 'navigation_expression') {
      const parts = named(head)
      const last = parts[parts.length - 1]
      if (parts.length !== 2 || last.type !== 'identifier') {
        for (const p of parts) visit(p)
        return undefined
      }
      ids.unshift(last)
      head = parts[0]
    }
    let value: Value | undefined
    let start = 0
    if (head.type === 'identifier') {
      const h = name(head, false)
      value = h.value
      if (!h.resolved) {
        // a qualified name: com.x.Foo.bar
        for (let k = ids.length; k >= 1; k--) {
          const t = index.resolveType([head.text, ...ids.slice(0, k).map(i => i.text)], scope())
          if (t.length) {
            const isCall = call && k === ids.length
            edge(owner, t[0].id, isCall ? 'instantiates' : 'references', ids[k - 1])
            value = { decl: t[0], statics: !isCall }
            start = k
            break
          }
        }
      }
    } else if (head.type === 'this_expression') value = thisValue(head)
    else if (head.type === 'super_expression') value = superValue()
    else value = expr(head)
    for (let i = start; i < ids.length; i++) {
      const id = ids[i]
      const text = id.text
      const isCall = call && i === ids.length - 1
      if (text === 'Companion' && value?.statics) continue
      if (!value) {
        // an extension function, called on a value whose type isn't known
        if (isCall) value = extension(text, id)
        continue
      }
      const ms = index.members(value.decl, text, value.statics)
      if (ms.length) {
        for (const m of ms) edge(owner, m.id, kindOf(m, isCall), id)
        value = valueOf(ms[0])
        continue
      }
      if (value.statics) {
        const nested = index.nestedType(value.decl, text)
        if (nested.length) {
          edge(owner, nested[0].id, isCall ? 'instantiates' : 'references', id)
          value = { decl: nested[0], statics: !isCall }
          continue
        }
      }
      if (isCall && !value.statics) {
        // a method a Spring Data repository inherits: it reads or writes the entity
        const q = repositoryQuery(value.decl, text, index)
        if (q) {
          edge(owner, q.entity.id, 'queries', id, q.op)
          value = undefined
          continue
        }
      }
      value = isCall ? extension(text, id) : undefined
    }
    return value
  }

  /** A project extension function by name, for a call on something it may extend. */
  const extension = (text: string, at: Node): Value | undefined => {
    const fns = index.resolveTop(text, scope()).filter(d => d.tags.includes('extension'))
    for (const f of fns) edge(owner, f.id, 'calls', at)
    return fns[0] ? valueOf(fns[0]) : undefined
  }

  /** The declared type a call's receiver has, as written (KafkaTemplate, not resolvable into the project). */
  const receiverTypeOf = (callee: Node): string | undefined => {
    if (callee.type !== 'navigation_expression') return undefined
    const recv = callee.namedChild(0)
    if (recv?.type !== 'identifier') return undefined
    const l = local(recv.text)
    const t = l ? l.type : types.length ? (index.members(types[types.length - 1], recv.text, false)[0]?.valueType ?? undefined) : undefined
    return t?.name[t.name.length - 1]
  }

  const call = (n: Node): Value | undefined => {
    const callee = n.namedChild(0)
    if (!callee) return undefined
    let value: Value | undefined
    let calleeName: string | undefined
    if (callee.type === 'identifier') {
      value = name(callee, true).value
      calleeName = callee.text
    } else if (callee.type === 'navigation_expression') {
      value = chain(callee, true)
      const last = callee.namedChild(callee.namedChildCount - 1)
      calleeName = last?.type === 'identifier' ? last.text : undefined
    } else value = expr(callee)
    const argNodes: Node[] = []
    for (const c of named(n).slice(1)) {
      if (c.type === 'value_arguments') {
        for (const a of named(c)) {
          if (a.type !== 'value_argument') continue
          const parts = named(a)
          const v = parts[parts.length - 1]
          if (v) {
            argNodes.push(v)
            expr(v)
          }
        }
      } else if (c.type === 'type_arguments') typeRefs(c)
      else visit(c)
    }
    if (calleeName) {
      const enclosing = types[types.length - 1]
      springCall(
        {
          owner,
          name: calleeName,
          args: argNodes.slice(0, 1).map(a => index.evaluate(exprOf(a), scope()) ?? []),
          receiverType: receiverTypeOf(callee),
          site: siteOf(callee),
          inListener,
          inConfiguration: enclosing?.subkind === 'configuration',
        },
        pass,
      )
    }
    return value
  }

  /** Types in a type position: every user_type in it (type arguments too). */
  const typeRefs = (n: Node, kind: EdgeKind = 'type-ref') => {
    if (n.type === 'user_type') {
      const ids = named(n).filter(c => c.type === 'identifier')
      if (ids.length) {
        const t = index.resolveType(
          ids.map(i => i.text),
          scope(),
        )
        for (const d of t) edge(owner, d.id, kind, ids[0])
        if (!t.length) countUnresolved(ids[ids.length - 1].text, ids[0])
      }
    }
    for (const c of named(n)) if (c.type !== 'identifier') typeRefs(c, kind)
  }

  const annotations = (n: Node) => {
    const mods = childOf(n, 'modifiers')
    if (!mods) return
    for (const m of named(mods)) {
      if (m.type !== 'annotation') continue
      const inv = childOf(m, 'constructor_invocation')
      const t = inv ? childOf(inv, 'user_type') : childOf(m, 'user_type')
      if (t) typeRefs(t, 'references')
      for (const a of named(childOf(inv ?? m, 'value_arguments') ?? m)) {
        if (a.type !== 'value_argument') continue
        const parts = named(a)
        if (parts.length) expr(parts[parts.length - 1])
      }
    }
  }

  /** Overriding members link to what they override; an interface's member is implemented, a class's overridden. */
  const overrides = (d: JvmDecl, at: Node) => {
    if (!d.override) return
    for (const o of index.overridden(d)) edge(d.id, o.id, index.decls.get(o.parent)?.type === 'interface' ? 'implements' : 'overrides', at)
  }

  const params = (list: Node | undefined) => {
    if (!list) return
    for (const p of named(list)) {
      if (p.type === 'parameter' || p.type === 'class_parameter') {
        const pname = childOf(p, 'identifier')?.text
        const t = typeOf(p)
        for (const c of named(p)) if (c.type !== 'identifier' && c.type !== 'modifiers' && c.type !== 'parameter_modifiers') visit(c)
        if (pname) define(pname, { value: instanceOf(t), type: t })
      } else if (p.type === 'parameter_modifiers' || p.type === 'modifiers') {
        for (const a of named(p)) if (a.type === 'annotation') {
          const t = childOf(childOf(a, 'constructor_invocation') ?? a, 'user_type')
          if (t) typeRefs(t, 'references')
        }
      } else expr(p)
    }
  }

  const typeDecl = (n: Node) => {
    const decl = declAt.get(n.startIndex)
    if (!decl) {
      for (const c of named(n)) visit(c)
      return
    }
    const prevOwner = owner
    owner = decl.id
    annotations(n)
    pushTypeParams(n)
    for (const s of named(childOf(n, 'delegation_specifiers') ?? n)) {
      if (s.type !== 'delegation_specifier') continue
      const inv = childOf(s, 'constructor_invocation')
      const t = inv ? childOf(inv, 'user_type') : childOf(s, 'user_type')
      const ref = typeRefOf(t ?? undefined)
      if (t && ref) {
        // the header is outside the type's own body: its nested types aren't in scope
        const found = index.resolveType(ref.name, { file, types: [...types] })
        for (const d of found) edge(decl.id, d.id, inv || d.type !== 'interface' ? 'extends' : 'implements', t)
        if (!found.length) countUnresolved(ref.name[ref.name.length - 1], t)
        for (const c of named(t)) if (c.type === 'type_arguments') typeRefs(c)
      }
      if (inv) for (const a of named(childOf(inv, 'value_arguments') ?? inv)) expr(named(a).at(-1) ?? a)
    }
    typeParams.pop()
    types.push(decl)
    locals.push(new Map())
    pushTypeParams(n)
    params(childOf(childOf(n, 'primary_constructor') ?? n, 'class_parameters'))
    // without a primary constructor the fallback lists the class's own children, whose modifiers start where it does: only parameters count
    for (const p of named(childOf(childOf(n, 'primary_constructor') ?? n, 'class_parameters') ?? n).filter(c => c.type === 'class_parameter')) {
      const m = declAt.get(p.startIndex)
      if (m) {
        overrides(m, p)
        springDecl(m, scope(), pass)
      }
    }
    const body = childOf(n, 'class_body') ?? childOf(n, 'enum_class_body')
    if (body) for (const c of named(body)) visit(c)
    springDecl(decl, scope(), pass)
    typeParams.pop()
    locals.pop()
    types.pop()
    owner = prevOwner
  }

  const functionDecl = (n: Node) => {
    const decl = declAt.get(n.startIndex)
    const prevOwner = owner
    const prevListener = inListener
    if (decl) owner = decl.id
    annotations(n)
    if (decl) inListener = !!decl.annotations?.some(a => /KafkaListener|KafkaHandler|StreamListener/.test(a.name))
    pushTypeParams(n)
    const recvType = receiverOf(n)
    receivers.push(recvType ? instanceOf(recvType) : undefined)
    locals.push(new Map())
    for (const c of named(n)) {
      if (c.type === 'function_value_parameters') params(c)
      else if (c.type === 'function_body') for (const b of named(c)) visit(b)
      else if (c.type === 'user_type' || c.type === 'nullable_type') typeRefs(c)
      else if (c.type === 'type_constraints' || c.type === 'type_parameters') typeRefs(c)
    }
    if (decl) {
      overrides(decl, n)
      springDecl(decl, scope(), pass)
    }
    locals.pop()
    receivers.pop()
    typeParams.pop()
    owner = prevOwner
    inListener = prevListener
  }

  const propertyDecl = (n: Node) => {
    const decl = declAt.get(n.startIndex)
    const v = childOf(n, 'variable_declaration')
    const init = initializerOf(n)
    if (decl) {
      const prevOwner = owner
      owner = decl.id
      annotations(n)
      if (v) for (const c of named(v)) if (c.type !== 'identifier') typeRefs(c)
      for (const c of named(n)) if (!same(c, v) && c.type !== 'modifiers') visit(c)
      overrides(decl, n)
      springDecl(decl, scope(), pass)
      owner = prevOwner
      return
    }
    // a local variable
    annotations(n)
    let value: Value | undefined
    if (init) value = expr(init)
    for (const c of named(n)) if (!same(c, init) && !same(c, v) && c.type !== 'modifiers' && c.type !== 'multi_variable_declaration') visit(c)
    if (v) {
      for (const c of named(v)) if (c.type !== 'identifier') typeRefs(c)
      const t = typeOf(v)
      const lname = childOf(v, 'identifier')?.text
      if (lname) define(lname, { value: t ? (instanceOf(t) ?? value) : value, type: t })
    }
    const multi = childOf(n, 'multi_variable_declaration')
    if (multi) for (const d of named(multi)) {
      const lname = childOf(d, 'identifier')?.text
      if (lname) define(lname, { type: typeOf(d) })
    }
  }

  const lambda = (n: Node) => {
    locals.push(new Map([['it', {}]]))
    for (const c of named(n)) {
      if (c.type === 'lambda_parameters') {
        for (const p of named(c)) {
          const ids = p.type === 'variable_declaration' ? [p] : named(p).filter(x => x.type === 'variable_declaration')
          for (const d of ids) {
            const lname = childOf(d, 'identifier')?.text
            const t = typeOf(d)
            if (t) typeRefs(d)
            if (lname) define(lname, { value: instanceOf(t), type: t })
          }
        }
      } else visit(c)
    }
    locals.pop()
  }

  /** An expression: visits it, draws its edges, and gives its value when known. */
  const expr = (n: Node): Value | undefined => {
    switch (n.type) {
      case 'identifier':
        return name(n, false).value
      case 'navigation_expression':
        return chain(n, false)
      case 'call_expression':
        return call(n)
      case 'this_expression':
        return thisValue(n)
      case 'super_expression':
        return superValue()
      case 'parenthesized_expression': {
        const inner = n.namedChild(0)
        return inner ? expr(inner) : undefined
      }
      case 'as_expression': {
        const parts = named(n)
        if (parts[0]) expr(parts[0])
        const t = parts.find((p, i) => i > 0 && (p.type === 'user_type' || p.type === 'nullable_type'))
        if (t) typeRefs(t)
        return instanceOf(typeRefOf(t))
      }
      case 'string_literal':
      case 'multiline_string_literal': {
        const kids = named(n)
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i]
          if (c.type === 'interpolation') {
            const inner = c.namedChild(0)
            if (inner) expr(inner)
          } else if (c.type === 'string_content' && c.text === '$' && kids[i + 1]?.type === 'string_content') {
            const m = /^[A-Za-z_]\w*/.exec(kids[i + 1].text)
            if (m) name({ text: m[0], site: siteOf(kids[i + 1]) }, false)
          }
        }
        return undefined
      }
      case 'lambda_literal':
        lambda(n)
        return undefined
      case 'annotated_lambda':
        for (const c of named(n)) visit(c)
        return undefined
      case 'object_literal': {
        for (const c of named(n)) {
          if (c.type === 'delegation_specifiers') typeRefs(c)
          else if (c.type === 'class_body') for (const m of named(c)) visit(m)
          else visit(c)
        }
        return undefined
      }
      case 'callable_reference': {
        const parts = named(n)
        const target = parts[parts.length - 1]
        if (target?.type !== 'identifier' || target.text === 'class') {
          for (const p of parts) if (p.type === 'user_type' || p.type === 'identifier') typeRefs(p, 'references')
          return undefined
        }
        const recv = parts.length > 1 ? parts[0] : undefined
        if (recv) {
          const t = index.resolveType(named(recv).filter(c => c.type === 'identifier').map(c => c.text).concat(recv.type === 'identifier' ? [recv.text] : []), scope())
          const ms = t[0] ? index.members(t[0], target.text, false).concat(index.members(t[0], target.text, true)) : []
          for (const m of ms) edge(owner, m.id, 'references', target)
          if (!ms.length && t[0]) edge(owner, t[0].id, 'references', recv)
        } else name(target, false)
        return undefined
      }
      case 'binary_expression': {
        const op = n.child(1)?.type
        const l = n.namedChild(0)
        const r = n.namedChild(1)
        const lv = l ? expr(l) : undefined
        const rv = r ? expr(r) : undefined
        return op === '?:' ? (lv ?? rv) : undefined
      }
      default:
        for (const c of named(n)) visit(c)
        return undefined
    }
  }

  /** A node in statement position: declarations open scopes, anything else is an expression. */
  const visit = (n: Node): void => {
    switch (n.type) {
      case 'package_header':
      case 'import':
      case 'import_list':
      case 'line_comment':
      case 'block_comment':
        return
      case 'class_declaration':
      case 'object_declaration':
        return typeDecl(n)
      case 'annotated_expression': {
        // an annotation class pass A took back from the grammar (kotlin-decls.ts)
        const decl = declAt.get(n.startIndex)
        if (!decl) return void expr(n)
        const prevOwner = owner
        owner = decl.id
        let inner: Node | undefined = n
        while (inner?.type === 'annotated_expression') {
          const parts: Node[] = named(inner)
          for (const a of parts) if (a.type === 'annotation') visit(a)
          inner = parts.find(c => c.type !== 'annotation')
        }
        springDecl(decl, scope(), pass)
        owner = prevOwner
        return
      }
      case 'companion_object': {
        const body = childOf(n, 'class_body')
        annotations(n)
        for (const s of named(childOf(n, 'delegation_specifiers') ?? n)) if (s.type === 'delegation_specifier') typeRefs(s)
        if (body) for (const c of named(body)) visit(c)
        return
      }
      case 'function_declaration':
        return functionDecl(n)
      case 'property_declaration':
        return propertyDecl(n)
      case 'secondary_constructor': {
        const decl = declAt.get(n.startIndex)
        const prevOwner = owner
        if (decl) owner = decl.id
        annotations(n)
        locals.push(new Map())
        for (const c of named(n)) {
          if (c.type === 'function_value_parameters') params(c)
          else if (c.type !== 'modifiers') visit(c)
        }
        locals.pop()
        owner = prevOwner
        return
      }
      case 'constructor_delegation_call':
        for (const a of named(childOf(n, 'value_arguments') ?? n)) expr(named(a).at(-1) ?? a)
        return
      case 'enum_entry': {
        const decl = declAt.get(n.startIndex)
        const prevOwner = owner
        if (decl) owner = decl.id
        for (const c of named(n)) if (c.type !== 'identifier') visit(c)
        owner = prevOwner
        return
      }
      case 'anonymous_initializer':
      case 'block':
      case 'control_structure_body':
      case 'statements':
        locals.push(new Map())
        for (const c of named(n)) visit(c)
        locals.pop()
        return
      case 'type_alias': {
        const decl = declAt.get(n.startIndex)
        const prevOwner = owner
        if (decl) owner = decl.id
        for (const c of named(n)) if (c.type !== 'identifier') typeRefs(c)
        owner = prevOwner
        return
      }
      case 'user_type':
      case 'nullable_type':
      case 'type_arguments':
      case 'type_constraints':
        return typeRefs(n)
      case 'for_statement': {
        locals.push(new Map())
        for (const c of named(n)) {
          if (c.type === 'variable_declaration') {
            const lname = childOf(c, 'identifier')?.text
            const t = typeOf(c)
            if (t) typeRefs(c)
            if (lname) define(lname, { value: instanceOf(t), type: t })
          } else if (c.type === 'multi_variable_declaration') {
            for (const d of named(c)) {
              const lname = childOf(d, 'identifier')?.text
              if (lname) define(lname, {})
            }
          } else visit(c)
        }
        locals.pop()
        return
      }
      case 'catch_block': {
        locals.push(new Map())
        const id = childOf(n, 'identifier')
        const t = named(n).find(c => c.type === 'user_type')
        if (t) typeRefs(t)
        if (id) define(id.text, { value: instanceOf(typeRefOf(t)), type: typeRefOf(t) })
        for (const c of named(n)) if (!same(c, id) && !same(c, t)) visit(c)
        locals.pop()
        return
      }
      case 'when_subject': {
        const v = childOf(n, 'variable_declaration')
        for (const c of named(n)) if (!same(c, v)) visit(c)
        const lname = v && childOf(v, 'identifier')?.text
        if (lname) define(lname, { type: typeOf(v!) })
        return
      }
      case 'value_argument': {
        const parts = named(n)
        if (parts.length) expr(parts[parts.length - 1])
        return
      }
      case 'label':
      case 'modifiers':
        return
      case 'annotation': {
        const inv = childOf(n, 'constructor_invocation')
        const t = childOf(inv ?? n, 'user_type')
        if (t) typeRefs(t, 'references')
        for (const a of named(childOf(inv ?? n, 'value_arguments') ?? n)) if (a.type === 'value_argument') visit(a)
        return
      }
      default:
        expr(n)
    }
  }

  locals.push(new Map())
  for (const c of named(tree.rootNode)) visit(c)

  return { refs: [...refs.values()], facts, tags, unresolved }
}
