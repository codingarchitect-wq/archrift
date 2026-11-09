// Go, pass B (docs/POLYGLOT.md, P5): every name in a file resolved to the
// declaration it means, through the index of all files. There is no type
// checker, so a value's type is what its declaration says: a parameter's or
// receiver's type, `var x T`, a composite literal `T{…}`, a function's
// declared results (`store := NewStore()`), a field's type
// (`s.store.Save()` calls the method of the field's type), with methods
// promoted from embedded structs. Values whose type would need inference
// (generic type arguments, closures' results passed around) get no edge
// rather than a wrong one.
//
// Framework calls are recognized here too (frameworks.ts): HTTP handler
// registrations and requests (`http` facts) and Kafka consumers, producers
// and topic declarations (`messaging` facts).
import { fileId } from '../../core/ids.ts'
import type { EdgeKind } from '../../core/model.ts'
import type { RefRecord } from '../fragment.ts'
import { named, siteOf } from '../tree-sitter.ts'
import type { Node, Tree } from '../tree-sitter.ts'
import { receiverTypeParams, resultsOf, stringOf, typeOf, typeParamsOf } from './decls.ts'
import { httpCall, kafkaCall, kafkaLiteral, lowerCamel } from './frameworks.ts'
import type { Arg, CallInfo, FrameworkPass } from './frameworks.ts'
import { isFunc } from './index.ts'
import type { GoIndex, Imported, Value } from './index.ts'
import type { GoDecl, GoFile, GoType } from './model.ts'

export interface LinkResult {
  refs: RefRecord[]
  facts: Record<string, unknown[]>
  /** Tags found in pass B (handlers' routes), by declaration: possibly in other files of the package or of imported ones. */
  tags: Record<string, string[]>
  unresolved: number
  /** Configuration paths were read through struct containment, which reaches across the module. */
  module?: true
}

/** A local name: what it holds when known, and what the framework recognizers want to know about it. */
export interface Local {
  v?: Value
  /** A string it was given (`topic := "orders"`). */
  str?: string
  /** A selector chain it was given (`t := configuration.Kafka.Topic`): configuration paths go through it. */
  chain?: Chain
  /** A router group's path prefix (`v1 := r.Group("/v1")`). */
  prefix?: string
}

/** `root.a.b`: the root as it resolved then, and the fields after it. */
export interface Chain {
  root?: Local
  rootDecl?: GoDecl
  fields: string[]
}

/** What an expression is: a value of a type, a project declaration, a type, a package. */
interface X {
  v?: Value
  /** A call's results. */
  results?: Value[]
  decl?: GoDecl
  /** It names a project type (`T`, `pkg.T`), not a value. */
  type?: GoDecl
  pkg?: Imported
  local?: Local
  /** A member of an outside package: its import path and name (`net/http`, `HandleFunc`). */
  ext?: { path: string; name: string }
}

/** Debug aid, as for TypeScript: ARCHRIFT_TRACE_UNRESOLVED=1 prints every name counted as unresolved. */
const TRACE_UNRESOLVED = !!process.env.ARCHRIFT_TRACE_UNRESOLVED
/** The universe block: never counted as unresolved (a package may shadow them). */
const BUILTINS = new Set([
  'true', 'false', 'nil', 'iota', 'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min',
  'new', 'panic', 'print', 'println', 'real', 'recover', 'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error',
  'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
])
const STATEMENTS_SKIPPED = new Set(['comment', 'break_statement', 'continue_statement', 'goto_statement', 'fallthrough_statement', 'empty_statement', 'label_name'])
const TYPE_NODES = new Set(['type_identifier', 'qualified_type', 'generic_type', 'pointer_type', 'slice_type', 'array_type', 'implicit_length_array_type', 'map_type', 'channel_type', 'function_type', 'struct_type', 'interface_type', 'parenthesized_type'])

export function linkGo(tree: Tree, file: GoFile, declAt: Map<number, GoDecl>, index: GoIndex, maxSites: number): LinkResult {
  const refs = new Map<string, RefRecord>()
  const facts: Record<string, unknown[]> = {}
  const tags: Record<string, string[]> = {}
  let unresolved = 0
  let usedModule = false
  const fid = fileId(file.path)
  const scope = index.scope(file)
  const module = index.moduleOf(file.path)

  let owner = fid
  const locals: Map<string, Local>[] = []
  const typeParams: Set<string>[] = []
  /** Identifier and selector nodes (by id) → the declaration they resolved to. */
  const resolvedAt = new Map<number, GoDecl>()

  const edge = (source: string, target: string, kind: EdgeKind, at: Node | [number, number]) => {
    if (source === target) return
    const key = `${source}\u0000${target}\u0000${kind}`
    const site = Array.isArray(at) ? at : siteOf(at)
    const r = refs.get(key)
    if (r) {
      r.count++
      if (r.sites.length < maxSites * 2) r.sites.push(site[0], site[1])
    } else refs.set(key, { source, target, kind, count: 1, sites: maxSites > 0 ? [site[0], site[1]] : [] })
  }
  const countUnresolved = (name: string, at: Node) => {
    unresolved++
    if (TRACE_UNRESOLVED) process.stderr.write(`unresolved ${file.path}:${at.startPosition.row + 1} ${name}\n`)
  }
  const local = (name: string): Local | undefined => {
    for (let i = locals.length - 1; i >= 0; i--) {
      const l = locals[i].get(name)
      if (l) return l
    }
    return undefined
  }
  const define = (name: string, l: Local) => {
    if (name !== '_') locals[locals.length - 1].set(name, l)
  }
  const isTypeParam = (name: string) => typeParams.some(s => s.has(name))
  const val = (t: GoType): Value => ({ t, file })

  type Found = { local: Local } | { decl: GoDecl } | { pkg: Imported } | { builtin: true } | { typeParam: true } | undefined
  /** Go's scopes, innermost first: locals, type parameters, the package, the file's imports, dot imports, the universe. */
  const lookup = (name: string): Found => {
    const l = local(name)
    if (l) return { local: l }
    if (isTypeParam(name)) return { typeParam: true }
    const own = scope.pkg.top.get(name)
    if (own) return { decl: own }
    const imp = scope.names.get(name)
    if (imp) return { pkg: imp }
    const dot = index.topLevel(name, file)
    if (dot) return { decl: dot }
    if (BUILTINS.has(name)) return { builtin: true }
    return undefined
  }
  /** The value a project type gives when converted to or instantiated. */
  const valueOfType = (d: GoDecl): Value => ({ t: { n: d.name }, file: index.fileOf(d.id)! })

  // ── types in type positions ──

  const typeRefs = (n: Node, kind: EdgeKind = 'type-ref'): void => {
    switch (n.type) {
      case 'type_identifier': {
        const name = n.text
        if (isTypeParam(name) || local(name)) return
        const d = index.topLevel(name, file)
        if (d) {
          edge(owner, d.id, kind, n)
          resolvedAt.set(n.id, d)
        } else if (!BUILTINS.has(name) && !scope.externalDot) countUnresolved(name, n)
        return
      }
      case 'qualified_type': {
        const q = n.childForFieldName('package')
        const nm = n.childForFieldName('name')
        if (!q || !nm) return
        const imp = scope.names.get(q.text)
        if (imp?.kind !== 'project') return
        const d = imp.pkg.top.get(nm.text)
        if (d) {
          edge(owner, d.id, kind, nm)
          resolvedAt.set(n.id, d)
        } else countUnresolved(`${q.text}.${nm.text}`, nm)
        return
      }
      case 'generic_type': {
        const base = n.childForFieldName('type')
        if (base) typeRefs(base, kind)
        const args = n.childForFieldName('type_arguments')
        if (args) typeRefs(args)
        return
      }
      case 'field_identifier':
      case 'identifier':
      case 'package_identifier':
      case 'comment':
        return
      case 'parameter_list':
        // parameter names are not types: only their types
        for (const p of named(n)) {
          const t = p.childForFieldName('type')
          if (t) typeRefs(t)
        }
        return
      default:
        for (const c of named(n)) typeRefs(c, kind === 'instantiates' ? 'type-ref' : kind)
    }
  }

  /** `T{…}`, `new(T)`: the type is instantiated; its type arguments, and the elements' types of a slice or map, are type refs. */
  const instantiates = (n: Node) => {
    if (n.type === 'type_identifier' || n.type === 'qualified_type' || n.type === 'generic_type') typeRefs(n, 'instantiates')
    else typeRefs(n)
  }

  // ── expressions ──

  /** A name in an expression; `operand`: the x of `x.Y`, which may be an outside package whose name is a guess. */
  const identX = (n: Node, call: boolean, operand = false): X => {
    const name = n.text
    if (name === '_') return {}
    const f = lookup(name)
    if (!f) {
      if (!scope.externalDot && !(operand && scope.vague)) countUnresolved(name, n)
      return {}
    }
    if ('local' in f) return { v: f.local.v, local: f.local }
    if ('pkg' in f) return { pkg: f.pkg }
    if (!('decl' in f)) return {}
    const d = f.decl
    resolvedAt.set(n.id, d)
    if (d.type) {
      edge(owner, d.id, 'type-ref', n)
      return { type: d, v: call ? valueOfType(d) : undefined }
    }
    edge(owner, d.id, call && isFunc(d) ? 'calls' : 'references', n)
    return { decl: d, v: index.valueOf(d) }
  }

  /** `x.f`: a package member, a method expression, or a field or method of x's type. */
  const selector = (n: Node, call: boolean): X & { recv?: X } => {
    const op = n.childForFieldName('operand')
    const f = n.childForFieldName('field')
    if (!op || !f) return {}
    const field = f.text
    const base: X = op.type === 'identifier' ? identX(op, false, true) : expr(op)
    if (base.pkg) {
      const imp = base.pkg
      if (imp.kind === 'external') return { recv: base, ext: { path: imp.path, name: field } }
      if (imp.kind !== 'project') return { recv: base }
      const d = imp.pkg.top.get(field)
      if (!d) {
        countUnresolved(`${op.text}.${field}`, f)
        return { recv: base }
      }
      resolvedAt.set(n.id, d)
      if (d.type) {
        edge(owner, d.id, 'type-ref', f)
        return { recv: base, type: d, v: call ? valueOfType(d) : undefined }
      }
      edge(owner, d.id, call && isFunc(d) ? 'calls' : 'references', f)
      return { recv: base, decl: d, v: index.valueOf(d) }
    }
    // a method expression: T.m
    const t = base.type ?? (base.v && index.typeDecl(base.v.t, base.v.file))
    if (!t) return { recv: base }
    const m = index.member(t, field)
    if (!m) {
      if (!index.hasUnknownMembers(t) && t.type !== 'type') countUnresolved(`${t.name}.${field}`, f)
      return { recv: base }
    }
    resolvedAt.set(n.id, m)
    edge(owner, m.id, call && m.subkind === 'method' ? 'calls' : 'references', f)
    return { recv: base, decl: m, v: index.valueOf(m) }
  }

  const call = (n: Node): X => {
    const fn = n.childForFieldName('function')
    const args = n.childForFieldName('arguments')
    const targs = n.childForFieldName('type_arguments')
    if (!fn) return {}
    if (targs) typeRefs(targs)
    const argNodes = args ? named(args).filter(a => a.type !== 'comment') : []
    // the built-ins that take types
    const found = fn.type === 'identifier' && (fn.text === 'new' || fn.text === 'make') ? lookup(fn.text) : undefined
    if (found && 'builtin' in found) {
      const t = argNodes[0]
      if (!t) return {}
      if (fn.text === 'new') {
        instantiates(t)
        return { v: val({ ptr: typeOf(t) }) }
      }
      typeRefs(t)
      for (const a of argNodes.slice(1)) expr(a)
      return { v: val(typeOf(t)) }
    }
    let callee: X & { recv?: X }
    if (fn.type === 'identifier') callee = identX(fn, true)
    else if (fn.type === 'selector_expression') callee = selector(fn, true)
    else callee = expr(fn)
    const argX = argNodes.map(a => (TYPE_NODES.has(a.type) && a.type !== 'type_identifier' ? (typeRefs(a), {}) : expr(a)))
    let results: Value[] = []
    if (callee.type) results = [valueOfType(callee.type)]
    else if (callee.decl && isFunc(callee.decl)) results = index.resultsOf(callee.decl)
    else if (callee.v && 'fn' in callee.v.t) results = callee.v.t.fn.map(t => ({ t, file: callee.v!.file }))
    else if (fn.type === 'identifier' && fn.text === 'append') results = argX[0]?.v ? [argX[0].v] : []
    const name = fn.type === 'identifier' ? fn.text : fn.type === 'selector_expression' ? fn.childForFieldName('field')?.text : undefined
    if (name && !callee.type) frameworks(n, name, callee, argNodes, argX)
    return { v: results[0], results }
  }

  /** `T{…}` and `&T{…}`; an elided nested literal (`[]T{{…}}`) instantiates the element type. */
  const literal = (n: Node): X => {
    const tn = n.childForFieldName('type')
    const body = n.childForFieldName('body')
    if (!tn) return {}
    instantiates(tn)
    const v = val(typeOf(tn))
    if (body) literalBody(body, v)
    kafkaLiteral(tn, body, pass)
    return { v }
  }

  const literalBody = (body: Node, v: Value | undefined) => {
    const t = v && index.typeDecl(v.t, v.file)
    const under = t?.type === 'type' && t.underlying ? t.underlying : v?.t
    // a struct literal's keys are field names; so are an unknown type's (an outside slice type's elements)
    const keyed = !under || (!('slice' in under) && !('map' in under))
    const elem = v && !keyed ? index.elemOf(v) : undefined
    const element = (el: Node | null, ev: Value | undefined) => {
      const inner = el && named(el)[0]
      if (!inner) return
      if (inner.type === 'literal_value') {
        const et = ev && index.typeDecl(ev.t, ev.file)
        if (et) edge(owner, et.id, 'instantiates', inner)
        literalBody(inner, ev)
      } else expr(inner)
    }
    for (const c of named(body)) {
      if (c.type === 'literal_element') element(c, elem)
      else if (c.type === 'keyed_element') {
        const k = c.childForFieldName('key')
        const value = c.childForFieldName('value')
        const kInner = k && named(k)[0]
        let fieldValue: Value | undefined
        if (keyed && kInner?.type === 'identifier') {
          // a struct literal's key is a field name
          const fld = t && index.member(t, kInner.text)
          fieldValue = fld ? index.valueOf(fld) : undefined
        } else if (k) element(k, v && index.keyOf(v))
        element(value, keyed ? fieldValue : elem)
      }
    }
  }

  const funcLiteral = (n: Node): X => {
    locals.push(new Map())
    const params = n.childForFieldName('parameters')
    if (params) parameters(params)
    const result = n.childForFieldName('result')
    if (result) results(result)
    const body = n.childForFieldName('body')
    if (body) block(body)
    locals.pop()
    return { v: val({ fn: resultsOf(result) }) }
  }

  /** An expression: visits it, draws its edges, and gives what it is when known. */
  const expr = (n: Node): X => {
    switch (n.type) {
      case 'identifier':
        return identX(n, false)
      case 'selector_expression':
        return selector(n, false)
      case 'call_expression':
        return call(n)
      case 'composite_literal':
        return literal(n)
      case 'func_literal':
        return funcLiteral(n)
      case 'parenthesized_expression': {
        const inner = named(n)[0]
        return inner ? expr(inner) : {}
      }
      case 'unary_expression': {
        const op = n.childForFieldName('operator')?.type
        const operand = n.childForFieldName('operand')
        if (!operand) return {}
        const x = expr(operand)
        if (op === '<-') return { v: x.v && index.elemOf(x.v) }
        if (op === '&' || op === '*') return x
        return {}
      }
      case 'type_assertion_expression': {
        const operand = n.childForFieldName('operand')
        const t = n.childForFieldName('type')
        if (operand) expr(operand)
        if (!t) return {}
        typeRefs(t)
        return { v: val(typeOf(t)) }
      }
      case 'type_conversion_expression': {
        // also what `F[int](x)` parses as: a call of a generic function
        const t = n.childForFieldName('type')
        const operand = n.childForFieldName('operand')
        const base = t?.type === 'generic_type' ? t.childForFieldName('type') : undefined
        const fnDecl = base && (base.type === 'type_identifier' ? index.topLevel(base.text, file) : base.type === 'qualified_type' ? index.qualified(base.childForFieldName('package')?.text ?? '', base.childForFieldName('name')?.text ?? '', file) : undefined)
        if (fnDecl && isFunc(fnDecl)) {
          edge(owner, fnDecl.id, 'calls', base!)
          const targs = t!.childForFieldName('type_arguments')
          if (targs) typeRefs(targs)
          if (operand) expr(operand)
          const results = index.resultsOf(fnDecl)
          return { v: results[0], results }
        }
        if (t) typeRefs(t)
        if (operand) expr(operand)
        return t ? { v: val(typeOf(t)) } : {}
      }
      case 'index_expression': {
        const operand = n.childForFieldName('operand')
        const idx = n.childForFieldName('index')
        const x = operand ? expr(operand) : {}
        if (idx) expr(idx)
        if (x.decl && isFunc(x.decl)) return x // F[T]: an instantiated generic function
        return { v: x.v && index.elemOf(x.v) }
      }
      case 'slice_expression': {
        const operand = n.childForFieldName('operand')
        const x = operand ? expr(operand) : {}
        for (const c of named(n)) if (c.id !== operand?.id) expr(c)
        return { v: x.v }
      }
      case 'generic_type':
      case 'qualified_type':
      case 'type_identifier':
      case 'pointer_type':
      case 'slice_type':
      case 'array_type':
      case 'map_type':
      case 'channel_type':
      case 'function_type':
      case 'struct_type':
      case 'interface_type':
        typeRefs(n)
        return { v: val(typeOf(n)) }
      case 'interpreted_string_literal':
      case 'raw_string_literal':
      case 'int_literal':
      case 'float_literal':
      case 'imaginary_literal':
      case 'rune_literal':
      case 'true':
      case 'false':
      case 'nil':
      case 'iota':
      case 'comment':
        return {}
      default:
        for (const c of named(n)) expr(c)
        return {}
    }
  }

  // ── declarations and statements ──

  const parameters = (list: Node, variadicIsSlice = true) => {
    for (const p of named(list)) {
      if (p.type !== 'parameter_declaration' && p.type !== 'variadic_parameter_declaration') continue
      const t = p.childForFieldName('type')
      if (!t) continue
      typeRefs(t)
      const gt = typeOf(t)
      const v = val(p.type === 'variadic_parameter_declaration' && variadicIsSlice ? { slice: gt } : gt)
      for (const nm of p.childrenForFieldName('name')) define(nm.text, { v })
    }
  }
  /** Results: their types, and named results are locals. */
  const results = (r: Node) => {
    if (r.type === 'parameter_list') parameters(r)
    else typeRefs(r)
  }

  const block = (n: Node) => {
    locals.push(new Map())
    for (const c of named(n)) visit(c)
    locals.pop()
  }

  const funcDecl = (n: Node) => {
    const nm = n.childForFieldName('name')
    const decl = nm ? declAt.get(nm.startIndex) : undefined
    const prev = owner
    owner = decl?.id ?? fid
    const tps = new Set<string>([...typeParamsOf(n.childForFieldName('type_parameters')), ...(decl?.typeParams ?? [])])
    typeParams.push(tps)
    locals.push(new Map())
    const tpl = n.childForFieldName('type_parameters')
    if (tpl) for (const p of named(tpl)) {
      const c = p.childForFieldName('type')
      if (c) typeRefs(c)
    }
    const recv = n.childForFieldName('receiver')
    if (recv) {
      for (const p of named(recv)) {
        const t = p.childForFieldName('type')
        if (!t) continue
        for (const tp of receiverTypeParams(t)) tps.add(tp)
        // a member method's receiver is its own type: only a method declared in another file than its type refers to it
        if (decl?.kind !== 'member') typeRefs(t)
        for (const r of p.childrenForFieldName('name')) define(r.text, { v: val(typeOf(t)) })
      }
    }
    const params = n.childForFieldName('parameters')
    if (params) parameters(params)
    const result = n.childForFieldName('result')
    if (result) results(result)
    const body = n.childForFieldName('body')
    if (body) block(body)
    locals.pop()
    typeParams.pop()
    owner = prev
  }

  const typeDecl = (spec: Node) => {
    const nm = spec.childForFieldName('name')
    const t = spec.childForFieldName('type')
    const decl = nm ? declAt.get(nm.startIndex) : undefined
    if (!t) return
    const prev = owner
    if (decl) owner = decl.id
    typeParams.push(new Set(typeParamsOf(spec.childForFieldName('type_parameters'))))
    const tpl = spec.childForFieldName('type_parameters')
    if (tpl) for (const p of named(tpl)) {
      const c = p.childForFieldName('type')
      if (c) typeRefs(c)
    }
    if (t.type === 'struct_type' && decl) {
      const list = named(t).find(c => c.type === 'field_declaration_list')
      for (const f of list ? named(list) : []) {
        const ft = f.childForFieldName('type')
        if (f.type !== 'field_declaration' || !ft) continue
        const first = f.childrenForFieldName('name')[0] ?? ft
        owner = declAt.get(first.startIndex)?.id ?? decl.id
        typeRefs(ft)
      }
    } else if (t.type === 'interface_type' && decl) {
      for (const m of named(t)) {
        if (m.type === 'method_elem') {
          const mn = m.childForFieldName('name')
          owner = (mn && declAt.get(mn.startIndex)?.id) ?? decl.id
          const params = m.childForFieldName('parameters')
          if (params) typeRefs(params)
          const result = m.childForFieldName('result')
          if (result) typeRefs(result)
        } else if (m.type === 'type_elem') {
          owner = decl.id
          const parts = named(m)
          // an embedded interface: the interface extends it
          if (parts.length === 1) typeRefs(parts[0], 'extends')
          else for (const p of parts) typeRefs(p)
        }
      }
    } else typeRefs(t)
    typeParams.pop()
    owner = prev
  }

  /** var and const declarations, at package level (each name its own owner) or in a function. */
  const varDecl = (n: Node, topLevel: boolean) => {
    const isConst = n.type === 'const_declaration'
    for (const spec of n.descendantsOfType(isConst ? 'const_spec' : 'var_spec')) {
      if (!spec || (spec.parent?.id !== n.id && spec.parent?.parent?.id !== n.id)) continue
      const names = spec.childrenForFieldName('name')
      const t = spec.childForFieldName('type')
      const valueList = spec.childForFieldName('value')
      const values = valueList ? named(valueList).filter(v => v.type !== 'comment') : []
      const prev = owner
      if (topLevel) owner = (names[0] && declAt.get(names[0].startIndex)?.id) ?? fid
      if (t) typeRefs(t)
      const xs: X[] = []
      values.forEach((v, i) => {
        if (topLevel) owner = (names[i] && declAt.get(names[i].startIndex)?.id) ?? (names[0] && declAt.get(names[0].startIndex)?.id) ?? fid
        xs.push(expr(v))
      })
      owner = prev
      if (topLevel) continue
      const multi = values.length === 1 && names.length > 1 ? xs[0]?.results : undefined
      names.forEach((nm, i) => {
        const x = multi ? { v: multi[i] } : xs[i]
        define(nm.text, { ...localFrom(values[i], x), ...(t ? { v: val(typeOf(t)) } : {}) })
      })
    }
  }

  /** What a local keeps from the expression it was given. */
  const localFrom = (n: Node | undefined, x: X | undefined): Local => {
    const l: Local = { v: x?.v }
    if (!n) return l
    const s = strings(n)
    if (s?.length === 1) l.str = s[0]
    const c = chainOf(n)
    if (c) l.chain = c
    if (x?.local?.prefix !== undefined && n.type === 'identifier') l.prefix = x.local.prefix
    return l
  }

  const shortVar = (left: Node, right: Node) => {
    const lefts = named(left).filter(c => c.type !== 'comment')
    const rights = named(right).filter(c => c.type !== 'comment')
    const xs = rights.map(expr)
    const multi = rights.length === 1 && lefts.length > 1 ? multiValues(rights[0], xs[0]) : undefined
    lefts.forEach((l, i) => {
      if (l.type !== 'identifier') return void expr(l)
      const x = multi ? { v: multi[i] } : xs[i]
      define(l.text, localFrom(multi ? undefined : rights[i], x))
      const group = rights[i] && groupPrefix(rights[i])
      if (group !== undefined) locals[locals.length - 1].get(l.text)!.prefix = group
    })
  }

  /** `a, b := f()`, `v, ok := m[k]`, `v, ok := x.(T)`, `v, ok := <-ch`. */
  const multiValues = (n: Node, x: X): (Value | undefined)[] => (n.type === 'call_expression' || n.type === 'type_conversion_expression' ? (x.results ?? []) : [x.v])

  const rangeClause = (n: Node) => {
    const left = n.childForFieldName('left')
    const right = n.childForFieldName('right')
    const x = right ? expr(right) : {}
    if (!left) return
    const names = named(left).filter(c => c.type === 'identifier')
    const declares = n.text.slice(left.endIndex - n.startIndex).trimStart().startsWith(':=')
    if (!declares) return void expr(left)
    const v = x.v
    const elem = v && index.elemOf(v)
    const key = v && index.keyOf(v)
    const isChan = v && 'chan' in v.t
    if (names[0]) define(names[0].text, { v: isChan ? elem : key })
    if (names[1]) define(names[1].text, { v: elem })
  }

  const visit = (n: Node): void => {
    if (STATEMENTS_SKIPPED.has(n.type)) return
    switch (n.type) {
      case 'package_clause':
      case 'import_declaration':
        return
      case 'function_declaration':
      case 'method_declaration':
        return funcDecl(n)
      case 'type_declaration':
        for (const spec of named(n)) {
          if (spec.type !== 'type_spec' && spec.type !== 'type_alias') continue
          // a type declared in a function is a local name (no node of its own)
          const nm = spec.childForFieldName('name')
          if (locals.length > 1 && nm) define(nm.text, {})
          typeDecl(spec)
        }
        return
      case 'const_declaration':
      case 'var_declaration':
        return varDecl(n, locals.length === 1)
      case 'block':
        return block(n)
      case 'statement_list':
        for (const c of named(n)) visit(c)
        return
      case 'expression_statement':
      case 'go_statement':
      case 'defer_statement':
      case 'return_statement':
      case 'inc_statement':
      case 'dec_statement':
      case 'send_statement':
        for (const c of named(n)) expr(c)
        return
      case 'short_var_declaration': {
        const left = n.childForFieldName('left')
        const right = n.childForFieldName('right')
        if (left && right) shortVar(left, right)
        return
      }
      case 'assignment_statement': {
        for (const c of named(n)) expr(c)
        return
      }
      case 'labeled_statement':
        for (const c of named(n)) if (c.type !== 'label_name') visit(c)
        return
      case 'if_statement':
      case 'for_statement':
      case 'expression_switch_statement':
      case 'select_statement':
        locals.push(new Map())
        for (const c of named(n)) {
          if (c.type === 'for_clause') for (const p of named(c)) visit(p)
          else if (c.type === 'range_clause') rangeClause(c)
          else if (c.type === 'expression_case' || c.type === 'default_case' || c.type === 'communication_case') caseClause(c)
          else if (c.type === 'block' || c.type === 'if_statement' || c.type.endsWith('_statement') || c.type === 'short_var_declaration') visit(c)
          else expr(c)
        }
        locals.pop()
        return
      case 'type_switch_statement': {
        locals.push(new Map())
        const alias = n.childForFieldName('alias')
        const value = n.childForFieldName('value')
        const init = n.childForFieldName('initializer')
        if (init) visit(init)
        const x = value ? expr(value) : {}
        for (const c of named(n)) {
          if (c.type !== 'type_case' && c.type !== 'default_case') continue
          locals.push(new Map())
          const types = c.childrenForFieldName('type')
          for (const t of types) typeRefs(t)
          const aliasName = alias && named(alias)[0]?.text
          if (aliasName) define(aliasName, { v: types.length === 1 && types[0].type !== 'nil' ? val(typeOf(types[0])) : x.v })
          for (const s of named(c)) if (!types.some(t => t.id === s.id)) visit(s)
          locals.pop()
        }
        locals.pop()
        return
      }
      case 'receive_statement': {
        const left = n.childForFieldName('left')
        const right = n.childForFieldName('right')
        if (left && right && n.text.slice(left.endIndex - n.startIndex).trimStart().startsWith(':=')) shortVar(left, right)
        else for (const c of named(n)) expr(c)
        return
      }
      default:
        expr(n)
    }
  }

  const caseClause = (c: Node) => {
    locals.push(new Map())
    const value = c.childForFieldName('value')
    const comm = c.childForFieldName('communication')
    if (value) for (const v of named(value)) expr(v)
    if (comm) visit(comm)
    for (const s of named(c)) if (s.id !== value?.id && s.id !== comm?.id) visit(s)
    locals.pop()
  }

  // ── what the framework recognizers need: strings, configuration paths, handlers ──

  /** The string(s) an expression is known to hold: literals, constants, string locals, `[]string{…}` elements. */
  const strings = (n: Node, depth = 0): string[] | undefined => {
    if (depth > 6) return undefined
    switch (n.type) {
      case 'interpreted_string_literal':
      case 'raw_string_literal':
        return [stringOf(n)]
      case 'identifier': {
        const l = local(n.text)
        if (l) return l.str !== undefined ? [l.str] : undefined
        const d = resolvedAt.get(n.id) ?? index.topLevel(n.text, file)
        const s = d?.init && index.evaluate(d.init, index.fileOf(d.id)!)
        return s === undefined || s === '' ? undefined : [s]
      }
      case 'selector_expression': {
        const d = resolvedAt.get(n.id)
        const s = d?.init && index.evaluate(d.init, index.fileOf(d.id)!)
        return s === undefined ? undefined : [s]
      }
      case 'parenthesized_expression':
      case 'unary_expression': {
        const inner = n.type === 'unary_expression' ? n.childForFieldName('operand') : named(n)[0]
        return inner ? strings(inner, depth + 1) : undefined
      }
      case 'binary_expression': {
        if (n.childForFieldName('operator')?.type !== '+') return undefined
        const l = n.childForFieldName('left')
        const r = n.childForFieldName('right')
        const ls = l && strings(l, depth + 1)
        const rs = r && strings(r, depth + 1)
        return ls?.length === 1 && rs?.length === 1 ? [ls[0] + rs[0]] : undefined
      }
      case 'composite_literal': {
        const body = n.childForFieldName('body')
        const out: string[] = []
        for (const el of body ? named(body) : []) {
          const inner = el.type === 'literal_element' ? named(el)[0] : undefined
          const s = inner && strings(inner, depth + 1)
          if (s) out.push(...s)
        }
        return out.length ? out : undefined
      }
      case 'call_expression': {
        // a conversion: Topic("orders"), string(x)
        const fn = n.childForFieldName('function')
        if (!fn || !(fn.text === 'string' || resolvedAt.get(fn.id)?.type)) return undefined
        const a = named(n.childForFieldName('arguments') ?? n)
        return a.length === 1 ? strings(a[0], depth + 1) : undefined
      }
      default:
        return undefined
    }
  }

  /** `root.a.b` as a chain, when it is one (the root a name). */
  const chainOf = (n: Node): Chain | undefined => {
    const fields: string[] = []
    let head = n
    while (head.type === 'selector_expression') {
      const f = head.childForFieldName('field')
      const op = head.childForFieldName('operand')
      if (!f || !op) return undefined
      fields.unshift(f.text)
      head = op
    }
    if (head.type !== 'identifier' || !fields.length) return undefined
    const l = local(head.text)
    if (l) return { root: l, fields }
    const d = scope.pkg.top.get(head.text)
    if (d && !d.type && !isFunc(d)) return { rootDecl: d, fields }
    return undefined
  }

  /**
   * The configuration property a selector chain reads:
   * `configuration.Kafka.Topic.Resized.Name` → kafka.topic.resized.name. The
   * root variable is dropped; when a struct along the chain sits in the
   * configuration tree (`properties.Topic…` with properties a
   * KafkaProperties, which is Configuration.Kafka), its place there is put
   * in front. Each segment is lower-camel, as the YAML keys are.
   */
  const configPath = (c: Chain, depth = 0): string[] | undefined => {
    if (depth > 6) return undefined
    if (c.root?.chain) return configPath({ ...c.root.chain, fields: [...c.root.chain.fields, ...c.fields] }, depth + 1)
    usedModule = true
    // configuration loaders only fill exported fields: the segments that are properties are capitalized
    const exported = (fields: string[]) => fields.every(f => /^\p{Lu}/u.test(f))
    let v = c.root?.v ?? (c.rootDecl && index.valueOf(c.rootDecl))
    for (let k = 0; k <= c.fields.length; k++) {
      const t = v && index.typeDecl(v.t, v.file)
      if (!t) break
      const up = t.type === 'struct' ? index.containerPath(t) : undefined
      if (up?.length && exported(c.fields.slice(k))) return [...up, ...c.fields.slice(k)].map(lowerCamel)
      if (k === c.fields.length) break
      const m = index.member(t, c.fields[k])
      v = m && index.valueOf(m)
    }
    return exported(c.fields) ? c.fields.map(lowerCamel) : undefined
  }

  /** A chain's fields, through the chains its root local was given. */
  const fieldsOf = (c: Chain, depth = 0): string[] => (c.root?.chain && depth < 6 ? [...fieldsOf(c.root.chain, depth + 1), ...c.fields] : c.fields)

  /** `r.Group("/v1")` (gin, echo): the group's path prefix, after the receiver's own. */
  const groupPrefix = (n: Node): string | undefined => {
    if (n.type !== 'call_expression') return undefined
    const fn = n.childForFieldName('function')
    if (fn?.type !== 'selector_expression' || fn.childForFieldName('field')?.text !== 'Group') return undefined
    const a = named(n.childForFieldName('arguments') ?? n)[0]
    const p = a && strings(a)?.[0]
    if (p === undefined) return undefined
    const recv = fn.childForFieldName('operand')
    const outer = recv?.type === 'identifier' ? (local(recv.text)?.prefix ?? '') : ''
    return outer + p
  }

  const pass: FrameworkPass = {
    module: module?.dir ?? '',
    owner: () => owner,
    emit: (channel, fact) => void (facts[channel] ??= []).push(fact),
    tag: (id, tag) => {
      const list = (tags[id] ??= [])
      if (!list.includes(tag)) list.push(tag)
    },
    strings,
    property: (n, topic) => {
      const unwrap = (x: Node): Node => (x.type === 'unary_expression' || x.type === 'parenthesized_expression' ? (x.childForFieldName('operand') ?? named(x)[0] ?? x) : x)
      const c = chainOf(unwrap(n))
      if (!c || (topic && !fieldsOf(c).some(f => /topic/i.test(f)))) return undefined
      return configPath(c)?.join('.')
    },
    scope,
  }

  const frameworks = (n: Node, name: string, callee: X & { recv?: X }, argNodes: Node[], argX: X[]) => {
    const recv = callee.recv
    const projectReceiver = !!(recv && (recv.type || (recv.v && index.typeDecl(recv.v.t, recv.v.file)) || (recv.pkg && recv.pkg.kind !== 'external')))
    const args: Arg[] = argNodes.map((node, i) => {
      const x = argX[i] ?? {}
      // http.HandlerFunc(list): the function converted
      const fn = node.type === 'call_expression' ? node.childForFieldName('function') : undefined
      const inner = fn && /(^|\.)HandlerFunc$/.test(fn.text) ? named(node.childForFieldName('arguments') ?? node)[0] : undefined
      const converted = inner && resolvedAt.get(inner.id)
      const d = x.decl && isFunc(x.decl) ? x.decl : converted && isFunc(converted) ? converted : undefined
      return { node, handler: d, isFunc: !!d || !!inner || node.type === 'func_literal' || !!(x.v && 'fn' in x.v.t) }
    })
    // gorilla/mux: r.HandleFunc("/p", h).Methods("GET")
    const parent = n.parent
    const chained = parent?.type === 'selector_expression' && parent.childForFieldName('field')?.text === 'Methods' && parent.parent?.type === 'call_expression' ? parent.parent : undefined
    const info: CallInfo = {
      name,
      site: siteOf(n.childForFieldName('function') ?? n),
      decl: callee.decl,
      ext: callee.ext,
      projectReceiver,
      prefix: recv?.local?.prefix,
      args,
      chainedMethods: chained ? named(chained.childForFieldName('arguments') ?? chained).flatMap(a => strings(a) ?? []) : undefined,
      params: callee.decl?.params,
    }
    httpCall(info, pass)
    kafkaCall(info, pass)
  }

  locals.push(new Map())
  for (const c of named(tree.rootNode)) visit(c)

  return { refs: [...refs.values()], facts, tags, unresolved, ...(usedModule ? { module: true as const } : {}) }
}
