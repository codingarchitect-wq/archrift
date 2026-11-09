// Kotlin, pass A (docs/POLYGLOT.md, P3): the declarations of one file, read
// from its tree-sitter tree alone. Types become symbols (a nested type is
// `Outer.Inner`), their functions, properties, constructor `val`s and enum
// entries members; a companion object's members belong to the type. What
// pass B needs to resolve names across files is kept as written: supertypes,
// declared types, annotations and constant initializers.
import { fileId, memberId, symbolId } from '../../core/ids.ts'
import type { Range } from '../../core/model.ts'
import { childOf, hasToken, named, rangeOf, siteOf } from '../tree-sitter.ts'
import type { Node, Tree } from '../tree-sitter.ts'
import type { Annotation, Expr, JvmDecl, JvmFile, JvmImport, TypeKind, TypeRef } from './model.ts'
import { springKinds } from './spring.ts'

const SIGNATURE_MAX = 160
const TYPE_NODES = new Set(['user_type', 'nullable_type', 'parenthesized_type', 'function_type', 'non_nullable_type'])
const ARRAY_BUILDERS = new Set(['arrayOf', 'listOf', 'setOf', 'mutableListOf', 'mutableSetOf'])

export interface KotlinRead {
  file: JvmFile
  /** A declaration node's start offset → its declaration, for pass B on the same tree. */
  declAt: Map<number, JvmDecl>
}

export function readKotlin(tree: Tree, path: string, hash: string, text: string): KotlinRead {
  const root = tree.rootNode
  const fid = fileId(path)
  const lines = text.split('\n')
  const codeBefore = new Int32Array(lines.length + 1)
  lines.forEach((l, i) => {
    const t = l.trim()
    codeBefore[i + 1] = codeBefore[i] + (t !== '' && !/^(\/\/|\/\*|\*)/.test(t) ? 1 : 0)
  })
  const locOf = (r: Range) => codeBefore[Math.min(r[2], lines.length)] - codeBefore[r[0] - 1]

  let pkg = ''
  const imports: JvmImport[] = []
  const decls: JvmDecl[] = []
  const declAt = new Map<number, JvmDecl>()
  const add = (n: Node, d: Omit<JvmDecl, 'range' | 'loc' | 'complexity'>) => {
    const range = rangeOf(n)
    const decl: JvmDecl = { ...d, range, loc: locOf(range), complexity: 1 + decisionPoints(n) }
    decls.push(decl)
    declAt.set(n.startIndex, decl)
    return decl
  }

  const member = (n: Node, owner: JvmDecl, companion: boolean, outer: string) => {
    switch (n.type) {
      case 'function_declaration': {
        const name = n.childForFieldName('name')?.text
        if (!name) return
        const mods = modifiersOf(n)
        add(n, {
          id: memberId(path, owner.name, name),
          kind: 'member',
          name,
          subkind: 'method',
          parent: owner.id,
          exported: mods.visibility !== 'private',
          signature: signatureOf(n, text),
          tags: companion ? ['static'] : [],
          valueType: returnTypeOf(n),
          annotations: mods.annotations,
          ...(companion ? { companion } : {}),
          ...(mods.member.includes('override') ? { override: true } : {}),
        })
        return
      }
      case 'property_declaration': {
        const v = childOf(n, 'variable_declaration')
        const name = v && childOf(v, 'identifier')?.text
        if (!v || !name) return
        const mods = modifiersOf(n)
        const init = initializerOf(n)
        add(n, {
          id: memberId(path, owner.name, name),
          kind: 'member',
          name,
          subkind: 'property',
          parent: owner.id,
          exported: mods.visibility !== 'private',
          signature: signatureOf(n, text),
          tags: [...(companion ? ['static'] : []), ...(mods.property.includes('const') ? ['const'] : [])],
          valueType: typeOf(v) ?? constructedType(init),
          ...storage(n, v, init),
          annotations: mods.annotations,
          ...constantOf(init),
          ...(companion ? { companion } : {}),
          ...(mods.member.includes('override') ? { override: true } : {}),
        })
        return
      }
      case 'secondary_constructor':
        add(n, { id: memberId(path, owner.name, 'constructor'), kind: 'member', name: 'constructor', subkind: 'constructor', parent: owner.id, exported: modifiersOf(n).visibility !== 'private', signature: signatureOf(n, text), tags: [] })
        return
      case 'enum_entry': {
        const name = childOf(n, 'identifier')?.text
        if (name) add(n, { id: memberId(path, owner.name, name), kind: 'member', name, subkind: 'enum-entry', parent: owner.id, exported: true, tags: [] })
        return
      }
      case 'companion_object':
        for (const c of named(childOf(n, 'class_body') ?? n)) member(c, owner, true, outer)
        return
      case 'class_declaration':
      case 'object_declaration':
        type(n, outer)
        return
    }
  }

  const type = (n: Node, outer?: string) => {
    const simple = n.childForFieldName('name')?.text
    if (!simple) return
    const name = outer ? `${outer}.${simple}` : simple
    const mods = modifiersOf(n)
    const kind: TypeKind =
      n.type === 'object_declaration'
        ? 'object'
        : hasToken(n, 'interface')
          ? 'interface'
          : mods.class.includes('enum')
            ? 'enum'
            : mods.class.includes('annotation')
              ? 'annotation'
              : 'class'
    const supers = named(childOf(n, 'delegation_specifiers') ?? n)
      .filter(s => s.type === 'delegation_specifier')
      .flatMap(s => {
        const inv = childOf(s, 'constructor_invocation')
        const t = typeRefOf(inv ? childOf(inv, 'user_type') : (childOf(s, 'user_type') ?? childOf(s, 'explicit_delegation')))
        return t ? [{ type: t, call: !!inv }] : []
      })
    const tags = [...mods.class.filter(m => m === 'data' || m === 'sealed' || m === 'value'), ...mods.inheritance.filter(m => m === 'abstract')]
    const decl = add(n, {
      id: symbolId(path, name),
      kind: 'symbol',
      name,
      subkind: kind,
      parent: fid,
      exported: mods.visibility !== 'private',
      signature: signatureOf(n, text),
      tags,
      fqn: pkg ? `${pkg}.${name}` : name,
      type: kind,
      ...(supers.length ? { supers } : {}),
      ...(mods.annotations.length ? { annotations: mods.annotations } : {}),
    })
    springKinds(decl)
    // constructor parameters declared `val`/`var` are properties
    for (const p of named(childOf(childOf(n, 'primary_constructor') ?? n, 'class_parameters') ?? n)) {
      if (p.type !== 'class_parameter' || !(hasToken(p, 'val') || hasToken(p, 'var'))) continue
      const pname = childOf(p, 'identifier')?.text
      if (!pname) continue
      const pm = modifiersOf(p)
      add(p, {
        id: memberId(path, name, pname),
        kind: 'member',
        name: pname,
        subkind: 'property',
        parent: decl.id,
        exported: pm.visibility !== 'private',
        signature: squash(p.text),
        tags: [],
        valueType: typeOf(p),
        ...nullableOf(p),
        ...(pm.annotations.length ? { annotations: pm.annotations } : {}),
        ...(pm.member.includes('override') ? { override: true } : {}),
      })
    }
    const body = childOf(n, 'class_body') ?? childOf(n, 'enum_class_body')
    if (body) for (const c of named(body)) member(c, decl, false, name)
  }

  // The grammar reads a body-less `annotation class X` under other annotations
  // as annotations on an infix expression `annotation class X`: take it back.
  const annotationClass = (n: Node) => {
    const annotations: Annotation[] = []
    let inner: Node | undefined = n
    while (inner?.type === 'annotated_expression') {
      const parts: Node[] = named(inner)
      const a = parts.find(c => c.type === 'annotation')
      const ann = a && annotationOf(a)
      if (ann) annotations.push(ann)
      inner = parts.find(c => c.type !== 'annotation')
    }
    const m = inner?.type === 'infix_expression' ? /^annotation\s+class\s+(\w+)/.exec(inner.text) : null
    if (!m) return
    const decl = add(n, {
      id: symbolId(path, m[1]),
      kind: 'symbol',
      name: m[1],
      subkind: 'annotation',
      parent: fid,
      exported: true,
      signature: `annotation class ${m[1]}`,
      tags: [],
      fqn: pkg ? `${pkg}.${m[1]}` : m[1],
      type: 'annotation',
      ...(annotations.length ? { annotations } : {}),
    })
    springKinds(decl)
  }

  for (const n of named(root)) {
    switch (n.type) {
      case 'package_header':
        pkg = qualifiedName(childOf(n, 'qualified_identifier') ?? childOf(n, 'identifier'))
        break
      case 'import': {
        const q = childOf(n, 'qualified_identifier') ?? childOf(n, 'identifier')
        if (!q) break
        const parts = named(n)
        const alias = parts.length > 1 && parts[parts.length - 1].type === 'identifier' && hasToken(n, 'as') ? parts[parts.length - 1].text : undefined
        const [line, col] = siteOf(n)
        imports.push({ fqn: qualifiedName(q), ...(alias ? { alias } : {}), star: hasToken(n, '*') || hasToken(n, '.*'), line, col })
        break
      }
      case 'import_list':
        for (const i of named(n)) if (i.type === 'import') {
          const q = childOf(i, 'qualified_identifier')
          if (q) imports.push({ fqn: qualifiedName(q), star: hasToken(i, '*'), line: siteOf(i)[0], col: siteOf(i)[1] })
        }
        break
      case 'class_declaration':
      case 'object_declaration':
        type(n)
        break
      case 'annotated_expression':
        annotationClass(n)
        break
      case 'function_declaration': {
        const name = n.childForFieldName('name')?.text
        if (!name) break
        const mods = modifiersOf(n)
        add(n, {
          id: symbolId(path, name),
          kind: 'symbol',
          name,
          subkind: 'function',
          parent: fid,
          exported: mods.visibility !== 'private',
          signature: signatureOf(n, text),
          tags: receiverOf(n) ? ['extension'] : [],
          fqn: pkg ? `${pkg}.${name}` : name,
          valueType: returnTypeOf(n),
          ...(mods.annotations.length ? { annotations: mods.annotations } : {}),
        })
        break
      }
      case 'property_declaration': {
        const v = childOf(n, 'variable_declaration')
        const name = v && childOf(v, 'identifier')?.text
        if (!v || !name) break
        const mods = modifiersOf(n)
        const init = initializerOf(n)
        add(n, {
          id: symbolId(path, name),
          kind: 'symbol',
          name,
          subkind: 'variable',
          parent: fid,
          exported: mods.visibility !== 'private',
          signature: signatureOf(n, text),
          tags: mods.property.includes('const') ? ['const'] : [],
          fqn: pkg ? `${pkg}.${name}` : name,
          valueType: typeOf(v) ?? constructedType(init),
          ...constantOf(init),
        })
        break
      }
      case 'type_alias': {
        const name = n.childForFieldName('type')?.text
        if (!name) break
        add(n, {
          id: symbolId(path, name),
          kind: 'symbol',
          name,
          subkind: 'type',
          parent: fid,
          exported: modifiersOf(n).visibility !== 'private',
          signature: signatureOf(n, text),
          tags: [],
          fqn: pkg ? `${pkg}.${name}` : name,
          type: 'alias',
          valueType: typeRefOf(named(n).find(c => TYPE_NODES.has(c.type))),
        })
        break
      }
    }
  }

  return {
    file: {
      path,
      hash,
      language: 'kotlin',
      pkg,
      imports,
      decls,
      loc: codeBefore[lines.length],
      complexity: 1 + decisionPoints(root),
      errors: root.hasError ? countErrors(root) : 0,
    },
    declAt,
  }
}

// ── helpers, shared with pass B ──

export interface Modifiers {
  visibility?: string
  annotations: Annotation[]
  class: string[]
  member: string[]
  property: string[]
  inheritance: string[]
}

export function modifiersOf(n: Node): Modifiers {
  const out: Modifiers = { annotations: [], class: [], member: [], property: [], inheritance: [] }
  const mods = childOf(n, 'modifiers')
  if (!mods) return out
  for (const m of named(mods)) {
    switch (m.type) {
      case 'annotation': {
        const a = annotationOf(m)
        if (a) out.annotations.push(a)
        break
      }
      case 'visibility_modifier':
        out.visibility = m.text
        break
      case 'class_modifier':
        out.class.push(m.text)
        break
      case 'member_modifier':
        out.member.push(m.text)
        break
      case 'property_modifier':
        out.property.push(m.text)
        break
      case 'inheritance_modifier':
        out.inheritance.push(m.text)
        break
    }
  }
  return out
}

export function annotationOf(n: Node): Annotation | undefined {
  const inv = childOf(n, 'constructor_invocation')
  const t = inv ? childOf(inv, 'user_type') : childOf(n, 'user_type')
  if (!t) return undefined
  const args: Annotation['args'] = []
  for (const a of named(childOf(inv ?? n, 'value_arguments') ?? n)) {
    if (a.type !== 'value_argument') continue
    const parts = named(a)
    const isNamed = parts.length > 1 && parts[0].type === 'identifier' && hasToken(a, '=')
    const value = parts[parts.length - 1]
    if (value) args.push({ ...(isNamed ? { name: parts[0].text } : {}), value: exprOf(value) })
  }
  return { name: named(t).filter(c => c.type === 'identifier').map(c => c.text).join('.'), args, site: siteOf(n) }
}

/** A type as written; undefined for function types and what isn't a type. */
export function typeRefOf(n: Node | undefined): TypeRef | undefined {
  if (!n) return undefined
  if (n.type === 'nullable_type' || n.type === 'parenthesized_type' || n.type === 'non_nullable_type') return typeRefOf(named(n).find(c => TYPE_NODES.has(c.type)))
  if (n.type !== 'user_type') return undefined
  const name: string[] = []
  let args: TypeRef[] | undefined
  for (const c of named(n)) {
    if (c.type === 'identifier') name.push(c.text)
    else if (c.type === 'type_arguments') args = named(c).flatMap(p => (p.type === 'type_projection' ? [typeRefOf(named(p).find(x => TYPE_NODES.has(x.type)))] : [])).filter(x => x !== undefined)
    else if (c.type === 'user_type') {
      // older grammar shape: nested user_type segments
      const inner = typeRefOf(c)
      if (inner) name.push(...inner.name)
    }
  }
  return name.length ? { name, ...(args?.length ? { args } : {}) } : undefined
}

/** The declared type of a variable declaration, parameter or class parameter. */
export function typeOf(n: Node): TypeRef | undefined {
  return typeRefOf(named(n).find(c => TYPE_NODES.has(c.type)))
}

/** Whether the type declared on a variable declaration or class parameter is nullable (`String?`). */
function isNullable(n: Node): boolean {
  return named(n).find(c => TYPE_NODES.has(c.type))?.type === 'nullable_type'
}

const nullableOf = (n: Node): { nullable?: boolean } => (isNullable(n) ? { nullable: true } : {})

/** What a member property stores, for the schema readers: a nullable type, or nothing at all (a getter without an initializer, a delegate). */
function storage(p: Node, v: Node, init: Node | undefined): { nullable?: boolean; computed?: boolean } {
  const parts = named(p)
  const computed = parts.some(c => c.type === 'property_delegate') || (!init && parts.some(c => c.type === 'getter'))
  return { ...nullableOf(v), ...(computed ? { computed: true } : {}) }
}

/** An extension function's receiver type: a type written before the name. */
export function receiverOf(fn: Node): TypeRef | undefined {
  const name = fn.childForFieldName('name')
  for (const c of named(fn)) {
    if (name && c.startIndex >= name.startIndex) break
    if (TYPE_NODES.has(c.type)) return typeRefOf(c)
  }
  return undefined
}

/** A function's return type: the type written after its parameters. */
export function returnTypeOf(fn: Node): TypeRef | undefined {
  let afterParams = false
  for (const c of named(fn)) {
    if (c.type === 'function_value_parameters') afterParams = true
    else if (afterParams && TYPE_NODES.has(c.type)) return typeRefOf(c)
    else if (c.type === 'function_body') break
  }
  return undefined
}

/** A property's initializer expression (not its getter, setter or delegate). */
export function initializerOf(p: Node): Node | undefined {
  let afterName = false
  for (const c of named(p)) {
    if (c.type === 'variable_declaration' || c.type === 'multi_variable_declaration') afterName = true
    else if (afterName && c.type !== 'getter' && c.type !== 'setter' && c.type !== 'property_delegate' && c.type !== 'modifiers' && !TYPE_NODES.has(c.type)) return c
  }
  return undefined
}

/** `val x = Foo(…)` without a declared type: Foo, when it is written like a class (capitalized). */
function constructedType(init: Node | undefined): TypeRef | undefined {
  if (init?.type !== 'call_expression') return undefined
  const callee = init.namedChild(0)
  if (callee?.type === 'identifier' && /^[A-Z]/.test(callee.text)) return { name: [callee.text] }
  return undefined
}

/** A constant-like initializer (strings, names, concatenations, arrays), kept for pass B. */
function constantOf(init: Node | undefined): { init?: Expr } {
  if (!init) return {}
  const e = exprOf(init)
  return 'other' in e || 'call' in e ? {} : { init: e }
}

export function exprOf(n: Node): Expr {
  switch (n.type) {
    case 'string_literal':
    case 'multiline_string_literal': {
      const parts: Expr[] = []
      const kids: Node[] = []
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i)
        if (c?.isNamed) kids.push(c)
      }
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i]
        if (c.type === 'string_content') {
          // `$name` comes as a content "$" followed by the name's content
          const next = kids[i + 1]
          const m = c.text === '$' && next?.type === 'string_content' ? /^[A-Za-z_]\w*/.exec(next.text) : null
          if (m) {
            parts.push({ ref: [m[0]] })
            if (next.text.length > m[0].length) parts.push({ s: next.text.slice(m[0].length) })
            i++
          } else parts.push({ s: c.text })
        } else if (c.type === 'escape_sequence') parts.push({ s: unescape(c.text) })
        else if (c.type === 'interpolation') {
          const inner = c.namedChild(0)
          parts.push(inner ? exprOf(inner) : { other: c.text })
        }
      }
      const merged: Expr[] = []
      for (const p of parts) {
        const last = merged[merged.length - 1]
        if (last && 's' in last && 's' in p) merged[merged.length - 1] = { s: last.s + p.s }
        else merged.push(p)
      }
      return merged.length === 1 ? merged[0] : merged.length ? { cat: merged } : { s: '' }
    }
    case 'identifier':
      return { ref: [n.text] }
    case 'navigation_expression': {
      const chain = chainOf(n)
      return chain ? { ref: chain } : { other: n.text }
    }
    case 'binary_expression': {
      const op = n.child(1)
      const l = n.childForFieldName('left') ?? n.namedChild(0)
      const r = n.childForFieldName('right') ?? n.namedChild(1)
      if (op?.type === '+' && l && r) return { cat: [exprOf(l), exprOf(r)] }
      return { other: n.text }
    }
    case 'collection_literal':
      return { arr: named(n).map(exprOf) }
    case 'parenthesized_expression':
    case 'spread_expression': {
      // `*[A, B]` passes an array's items as varargs: the array
      const inner = n.namedChild(0)
      return inner ? exprOf(inner) : { other: n.text }
    }
    case 'call_expression':
      return callOf(n)
    default:
      return { other: n.text }
  }
}

/** `f(a)`, `arrayOf(a, b)` (an array), `Index(name = "x", unique = true)` (a nested annotation, read by its argument names). */
function callOf(n: Node): Expr {
  const callee = n.namedChild(0)
  const chain = callee && (callee.type === 'identifier' ? [callee.text] : callee.type === 'navigation_expression' ? chainOf(callee) : undefined)
  const { args, names } = callArguments(n)
  if (chain && ARRAY_BUILDERS.has(chain[chain.length - 1])) return { arr: args }
  return chain ? { call: chain, args, ...(names.some(Boolean) ? { names } : {}) } : { other: n.text }
}

/** A call's arguments, and the name each is passed by ('' for a positional one). */
function callArguments(call: Node): { args: Expr[]; names: string[] } {
  const args: Expr[] = []
  const names: string[] = []
  for (const a of named(childOf(call, 'value_arguments') ?? call)) {
    if (a.type !== 'value_argument') continue
    const parts = named(a)
    const value = parts.at(-1)
    if (!value) continue
    args.push(exprOf(value))
    names.push(parts.length > 1 && parts[0].type === 'identifier' && hasToken(a, '=') ? parts[0].text : '')
  }
  return { args, names }
}

/** `a.b.c` as names; undefined when a part isn't a plain name. */
export function chainOf(n: Node): string[] | undefined {
  if (n.type === 'identifier') return [n.text]
  if (n.type !== 'navigation_expression') return undefined
  const parts = named(n)
  const head = parts[0] && chainOf(parts[0])
  const last = parts[parts.length - 1]
  if (!head || parts.length !== 2 || last.type !== 'identifier') return undefined
  return [...head, last.text]
}

export function qualifiedName(n: Node | undefined): string {
  if (!n) return ''
  if (n.type === 'identifier') return n.text
  return named(n)
    .filter(c => c.type === 'identifier')
    .map(c => c.text)
    .join('.')
}

function unescape(s: string): string {
  switch (s) {
    case '\\$':
      return '$'
    case '\\n':
      return '\n'
    case '\\t':
      return '\t'
    case '\\"':
      return '"'
    case "\\'":
      return "'"
    case '\\\\':
      return '\\'
    default:
      return /^\\u[0-9a-fA-F]{4}$/.test(s) ? String.fromCharCode(parseInt(s.slice(2), 16)) : s.slice(1)
  }
}

/** The declaration as written up to its body or initializer, without annotations, on one line. */
function signatureOf(n: Node, text: string): string | undefined {
  let end = n.endIndex
  let start = n.startIndex
  for (const c of named(n)) {
    if (c.type === 'modifiers') {
      // keep the keywords, drop the annotations
      const kept = named(c).filter(m => m.type !== 'annotation')
      start = kept.length ? kept[0].startIndex : c.endIndex
      continue
    }
    if (c.type === 'class_body' || c.type === 'enum_class_body' || c.type === 'function_body' || c.type === 'getter' || c.type === 'setter' || c.type === 'property_delegate') {
      end = c.startIndex
      break
    }
  }
  if (n.type === 'property_declaration') {
    const init = initializerOf(n)
    if (init) end = Math.min(end, init.startIndex)
  }
  // parameter annotations (@PathVariable(…), @Valid) say little in a one-line signature
  const s = squash(text.slice(start, end).replace(/@[\w.]+(\((?:[^()]|\([^()]*\))*\))?\s*/g, '').replace(/\s*=\s*$/, ''))
  if (!s) return undefined
  return s.length > SIGNATURE_MAX ? `${s.slice(0, SIGNATURE_MAX - 1)}…` : s
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Branches and short-circuits: if, when entries (not else), loops, catch, &&, ||, ?:. */
export function decisionPoints(n: Node): number {
  let count = 0
  const visit = (x: Node) => {
    switch (x.type) {
      case 'if_expression':
      case 'for_statement':
      case 'while_statement':
      case 'do_while_statement':
      case 'catch_block':
        count++
        break
      case 'when_entry':
        if (!hasToken(x, 'else')) count++
        break
      case 'binary_expression': {
        const op = x.child(1)?.type
        if (op === '&&' || op === '||' || op === '?:') count++
        break
      }
    }
    for (let i = 0; i < x.namedChildCount; i++) visit(x.namedChild(i)!)
  }
  visit(n)
  return count
}

function countErrors(n: Node): number {
  let count = 0
  const visit = (x: Node) => {
    if (x.type === 'ERROR' || x.isMissing) {
      count++
      return
    }
    if (!x.hasError) return
    for (let i = 0; i < x.childCount; i++) visit(x.child(i)!)
  }
  visit(n)
  return count
}
