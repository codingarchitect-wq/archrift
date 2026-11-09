// Go, pass A (docs/POLYGLOT.md, P5): the declarations of one file, read from
// its tree-sitter tree alone. Functions, types, constants and variables are
// symbols; struct fields (embedded ones too) and interface methods are
// members of their type. What pass B needs to resolve names across files is
// kept as written: declared types, result types, embedded types, receivers
// and string constants.
//
// A method is a member of its receiver type when the type is declared in the
// same file. Go lets a package spread a type's methods over any of its files,
// and a member must live in its type's file (graph ids are path#Type.member),
// so a method declared in another file is a symbol of its own file named
// `Type.method` (subkind method). The index attaches both kinds to the type,
// so calls, promotion and interface satisfaction see one method set.
import { fileId, memberId, symbolId } from '../../core/ids.ts'
import type { Range } from '../../core/model.ts'
import { named, rangeOf, siteOf } from '../tree-sitter.ts'
import type { Node, Tree } from '../tree-sitter.ts'
import type { GoDecl, GoExpr, GoFile, GoImport, GoType } from './model.ts'

const SIGNATURE_MAX = 160

export interface GoRead {
  file: GoFile
  /** A declaration's name node (an embedded field's type node) start offset → its declaration, for pass B on the same tree. */
  declAt: Map<number, GoDecl>
}

export const isExported = (name: string) => /^\p{Lu}/u.test(name)

export function readGo(tree: Tree, path: string, hash: string, text: string): GoRead {
  const root = tree.rootNode
  const fid = fileId(path)
  const lines = text.split('\n')
  const codeBefore = new Int32Array(lines.length + 1)
  let inBlock = false
  lines.forEach((l, i) => {
    let t = l.trim()
    if (inBlock) {
      const end = t.indexOf('*/')
      if (end < 0) t = ''
      else {
        inBlock = false
        t = t.slice(end + 2).trim()
      }
    }
    if (t.startsWith('/*') && !t.includes('*/')) {
      inBlock = true
      t = ''
    }
    codeBefore[i + 1] = codeBefore[i] + (t !== '' && !t.startsWith('//') && !(t.startsWith('/*') && t.endsWith('*/')) ? 1 : 0)
  })
  const locOf = (r: Range) => codeBefore[Math.min(r[2], lines.length)] - codeBefore[r[0] - 1]

  let pkg = ''
  const imports: GoImport[] = []
  const decls: GoDecl[] = []
  const declAt = new Map<number, GoDecl>()
  const ids = new Set<string>()
  /** `init` may be declared many times: later ones get `~2`, `~3` … */
  const unique = (id: string) => {
    let out = id
    for (let i = 2; ids.has(out); i++) out = `${id}~${i}`
    ids.add(out)
    return out
  }
  const add = (span: Node, at: Node, d: Omit<GoDecl, 'range' | 'loc' | 'complexity'>) => {
    const range = rangeOf(span)
    const decl: GoDecl = { ...d, id: unique(d.id), range, loc: locOf(range), complexity: 1 + decisionPoints(span) }
    decls.push(decl)
    declAt.set(at.startIndex, decl)
    return decl
  }

  // types first: a method joins its type when the type is in this file
  const types = new Map<string, GoDecl>()
  for (const n of named(root)) {
    if (n.type !== 'type_declaration') continue
    const specs = named(n).filter(s => s.type === 'type_spec' || s.type === 'type_alias')
    for (const spec of specs) {
      const nameNode = spec.childForFieldName('name')
      const typeNode = spec.childForFieldName('type')
      if (!nameNode || !typeNode) continue
      const name = nameNode.text
      const tps = typeParamsOf(spec.childForFieldName('type_parameters'))
      const kind = typeNode.type === 'struct_type' ? 'struct' : typeNode.type === 'interface_type' ? 'interface' : 'type'
      const head = `type ${name}${spec.childForFieldName('type_parameters') ? squash(spec.childForFieldName('type_parameters')!.text) : ''}`
      const signature = kind === 'type' ? cap(`type ${squash(spec.text)}`) : `${head} ${kind}`
      const decl = add(specs.length === 1 ? n : spec, nameNode, {
        id: symbolId(path, name),
        kind: 'symbol',
        name,
        subkind: kind,
        parent: fid,
        exported: isExported(name),
        signature,
        tags: [],
        type: kind,
        ...(kind === 'type' ? { underlying: typeOf(typeNode) } : {}),
        ...(spec.type === 'type_alias' ? { alias: true as const } : {}),
        ...(tps.length ? { typeParams: tps } : {}),
      })
      types.set(name, decl)
      if (kind === 'struct') struct(typeNode, decl)
      else if (kind === 'interface') iface(typeNode, decl)
    }
  }

  function struct(t: Node, owner: GoDecl) {
    const list = named(t).find(c => c.type === 'field_declaration_list')
    if (!list) return
    const embeds: GoType[] = []
    for (const f of named(list)) {
      if (f.type !== 'field_declaration') continue
      const tn = f.childForFieldName('type')
      if (!tn) continue
      const names = f.childrenForFieldName('name')
      const valueType = typeOf(tn)
      if (!names.length) {
        // an embedded field is named after its type: *Base → Base, pkg.Base → Base
        const base = baseName(valueType)
        if (!base) continue
        embeds.push(valueType)
        add(f, tn, {
          id: memberId(path, owner.name, base),
          kind: 'member',
          name: base,
          subkind: 'property',
          parent: owner.id,
          exported: isExported(base),
          signature: squash(tn.text),
          tags: ['embedded'],
          valueType,
        })
        continue
      }
      for (const nm of names)
        add(f, nm, {
          id: memberId(path, owner.name, nm.text),
          kind: 'member',
          name: nm.text,
          subkind: 'property',
          parent: owner.id,
          exported: isExported(nm.text),
          signature: cap(`${nm.text} ${squash(tn.text)}`),
          tags: [],
          valueType,
        })
    }
    if (embeds.length) owner.embeds = embeds
  }

  function iface(t: Node, owner: GoDecl) {
    const embeds: GoType[] = []
    for (const m of named(t)) {
      if (m.type === 'method_elem') {
        const nm = m.childForFieldName('name')
        if (!nm) continue
        add(m, nm, {
          id: memberId(path, owner.name, nm.text),
          kind: 'member',
          name: nm.text,
          subkind: 'method',
          parent: owner.id,
          exported: isExported(nm.text),
          signature: cap(squash(m.text)),
          tags: [],
          results: resultsOf(m.childForFieldName('result')),
          params: paramNames(m.childForFieldName('parameters')),
        })
      } else if (m.type === 'type_elem') {
        // an embedded interface (a single type; unions are constraints, not method sets)
        const parts = named(m)
        if (parts.length === 1) embeds.push(typeOf(parts[0]))
      }
    }
    if (embeds.length) owner.embeds = embeds
  }

  for (const n of named(root)) {
    switch (n.type) {
      case 'package_clause':
        pkg = named(n)[0]?.text ?? ''
        break
      case 'import_declaration':
        for (const spec of n.descendantsOfType('import_spec')) {
          if (!spec) continue
          const p = spec.childForFieldName('path')
          if (!p) continue
          const nm = spec.childForFieldName('name')
          const [line, col] = siteOf(spec)
          imports.push({ path: stringOf(p), ...(nm ? { name: nm.text } : {}), line, col })
        }
        break
      case 'function_declaration': {
        const nm = n.childForFieldName('name')
        if (!nm) break
        const tps = typeParamsOf(n.childForFieldName('type_parameters'))
        add(n, nm, {
          id: symbolId(path, nm.text),
          kind: 'symbol',
          name: nm.text,
          subkind: 'function',
          parent: fid,
          exported: isExported(nm.text),
          signature: signatureOf(n, text),
          tags: [],
          results: resultsOf(n.childForFieldName('result')),
          params: paramNames(n.childForFieldName('parameters')),
          ...(tps.length ? { typeParams: tps } : {}),
        })
        break
      }
      case 'method_declaration': {
        const nm = n.childForFieldName('name')
        const recvParam = named(n.childForFieldName('receiver') ?? n).find(c => c.type === 'parameter_declaration')
        const recvType = recvParam?.childForFieldName('type')
        if (!nm || !recvType) break
        const rt = typeOf(recvType)
        const recv = baseName(rt)
        if (!recv) break
        const owner = types.get(recv)
        const tps = receiverTypeParams(recvType)
        add(n, nm, {
          id: owner ? memberId(path, recv, nm.text) : symbolId(path, `${recv}.${nm.text}`),
          kind: owner ? 'member' : 'symbol',
          name: owner ? nm.text : `${recv}.${nm.text}`,
          subkind: 'method',
          parent: owner ? owner.id : fid,
          exported: isExported(nm.text),
          signature: signatureOf(n, text),
          tags: [],
          recv,
          results: resultsOf(n.childForFieldName('result')),
          params: paramNames(n.childForFieldName('parameters')),
          ...(tps.length ? { typeParams: tps } : {}),
        })
        break
      }
      case 'const_declaration':
      case 'var_declaration': {
        const isConst = n.type === 'const_declaration'
        const specs = n.descendantsOfType(isConst ? 'const_spec' : 'var_spec').filter(s => s?.parent?.id === n.id || s?.parent?.parent?.id === n.id) as Node[]
        let lastValues: Node[] = []
        let lastType: Node | null = null
        for (const spec of specs) {
          const names = spec.childrenForFieldName('name')
          const tn = spec.childForFieldName('type')
          const valueList = spec.childForFieldName('value')
          // in a const group, a spec without values repeats the previous one's type and expression (iota)
          const repeats = isConst && !valueList
          const values = valueList ? named(valueList) : repeats ? lastValues : []
          const typeNode = tn ?? (repeats ? lastType : null)
          if (valueList) {
            lastValues = values
            lastType = tn
          }
          names.forEach((nm, i) => {
            if (nm.text === '_') return
            const value = values.length === names.length ? values[i] : undefined
            const evident = value ? evidentType(value) : undefined
            const init = value ? exprOf(value) : undefined
            const call = !typeNode && !evident && value ? calleeOf(value) : undefined
            add(specs.length === 1 && names.length === 1 ? n : spec, nm, {
              id: symbolId(path, nm.text),
              kind: 'symbol',
              name: nm.text,
              subkind: 'variable',
              parent: fid,
              exported: isExported(nm.text),
              signature: cap(`${isConst ? 'const' : 'var'} ${nm.text}${typeNode ? ` ${squash(typeNode.text)}` : ''}`),
              tags: isConst ? ['const'] : [],
              ...(typeNode ? { valueType: typeOf(typeNode) } : evident ? { valueType: evident } : {}),
              ...(call ? { initCall: call } : {}),
              ...(init ? { init } : {}),
            })
          })
        }
        break
      }
    }
  }

  return {
    file: {
      path,
      hash,
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

/** A type node as a GoType. */
export function typeOf(n: Node): GoType {
  switch (n.type) {
    case 'type_identifier':
    case 'identifier':
    case 'package_identifier':
      return { n: n.text }
    case 'qualified_type': {
      const q = n.childForFieldName('package')
      const nm = n.childForFieldName('name')
      return nm ? { n: nm.text, ...(q ? { q: q.text } : {}) } : { other: n.type }
    }
    case 'selector_expression': {
      // a qualified type in expression position: pkg.T
      const q = n.childForFieldName('operand')
      const nm = n.childForFieldName('field')
      return nm && q?.type === 'identifier' ? { n: nm.text, q: q.text } : { other: n.type }
    }
    case 'generic_type': {
      const base = n.childForFieldName('type')
      const t = base ? typeOf(base) : { other: n.type }
      const args = named(n.childForFieldName('type_arguments') ?? n)
        .filter(c => c.type === 'type_elem')
        .map(c => named(c)[0])
        .filter(c => c !== undefined)
        .map(typeOf)
      return 'n' in t ? { ...t, ...(args.length ? { args } : {}) } : t
    }
    case 'pointer_type': {
      const inner = named(n)[0]
      return inner ? { ptr: typeOf(inner) } : { other: n.type }
    }
    case 'slice_type':
    case 'array_type':
    case 'implicit_length_array_type': {
      const el = n.childForFieldName('element')
      return el ? { slice: typeOf(el) } : { other: n.type }
    }
    case 'map_type': {
      const k = n.childForFieldName('key')
      const v = n.childForFieldName('value')
      return k && v ? { map: typeOf(v), key: typeOf(k) } : { other: n.type }
    }
    case 'channel_type': {
      const v = n.childForFieldName('value')
      return v ? { chan: typeOf(v) } : { other: n.type }
    }
    case 'function_type':
      return { fn: resultsOf(n.childForFieldName('result')) }
    case 'parenthesized_type':
    case 'type_elem':
    case 'type_constraint': {
      const inner = named(n)[0]
      return inner ? typeOf(inner) : { other: n.type }
    }
    default:
      return { other: n.type }
  }
}

/** The named type at the bottom of pointers: *pkg.T → T. */
export function baseName(t: GoType): string | undefined {
  if ('ptr' in t) return baseName(t.ptr)
  return 'n' in t ? t.n : undefined
}

/** A function's results: one type per result (a parameter_list result is several). */
export function resultsOf(r: Node | null): GoType[] {
  if (!r) return []
  if (r.type !== 'parameter_list') return [typeOf(r)]
  const out: GoType[] = []
  for (const p of named(r)) {
    if (p.type !== 'parameter_declaration' && p.type !== 'variadic_parameter_declaration') continue
    const t = p.childForFieldName('type')
    if (!t) continue
    const count = Math.max(1, p.childrenForFieldName('name').length)
    for (let i = 0; i < count; i++) out.push(typeOf(t))
  }
  return out
}

/** One name per parameter, '' for an unnamed one. */
export function paramNames(list: Node | null): string[] {
  if (!list) return []
  const out: string[] = []
  for (const p of named(list)) {
    if (p.type !== 'parameter_declaration' && p.type !== 'variadic_parameter_declaration') continue
    const names = p.childrenForFieldName('name')
    if (names.length) for (const nm of names) out.push(nm.text)
    else out.push('')
  }
  return out
}

export function typeParamsOf(list: Node | null): string[] {
  if (!list) return []
  return named(list)
    .filter(c => c.type === 'type_parameter_declaration')
    .flatMap(c => c.childrenForFieldName('name').map(nm => nm.text))
}

/** `func (g *G[K, V]) m()`: K and V. */
export function receiverTypeParams(t: Node): string[] {
  const g = t.type === 'pointer_type' ? named(t)[0] : t
  if (g?.type !== 'generic_type') return []
  return named(g.childForFieldName('type_arguments') ?? g)
    .filter(c => c.type === 'type_elem')
    .map(c => named(c)[0]?.text ?? '')
    .filter(Boolean)
}

/** The type an initializer evidently has: T{…}, &T{…}, T(x) is left to pass B (T may be a function). */
function evidentType(v: Node): GoType | undefined {
  if (v.type === 'composite_literal') {
    const t = v.childForFieldName('type')
    return t ? typeOf(t) : undefined
  }
  if (v.type === 'unary_expression') {
    const op = v.childForFieldName('operand')
    if (op?.type === 'composite_literal') {
      const t = evidentType(op)
      return t ? { ptr: t } : undefined
    }
  }
  return undefined
}

/** `NewX(…)` or `pkg.NewX(…)`: the function called. */
function calleeOf(v: Node): { n: string; q?: string } | undefined {
  if (v.type !== 'call_expression') return undefined
  const f = v.childForFieldName('function')
  if (f?.type === 'identifier') return { n: f.text }
  if (f?.type === 'selector_expression') {
    const op = f.childForFieldName('operand')
    const fld = f.childForFieldName('field')
    if (op?.type === 'identifier' && fld) return { n: fld.text, q: op.text }
  }
  return undefined
}

/** A string-valued expression as written; undefined when it isn't one. */
export function exprOf(n: Node): GoExpr | undefined {
  switch (n.type) {
    case 'interpreted_string_literal':
    case 'raw_string_literal':
      return { s: stringOf(n) }
    case 'identifier':
      return { ref: n.text }
    case 'selector_expression': {
      const op = n.childForFieldName('operand')
      const f = n.childForFieldName('field')
      return op?.type === 'identifier' && f ? { ref: f.text, q: op.text } : undefined
    }
    case 'parenthesized_expression': {
      const inner = named(n)[0]
      return inner ? exprOf(inner) : undefined
    }
    case 'binary_expression': {
      if (n.childForFieldName('operator')?.type !== '+') return undefined
      const l = n.childForFieldName('left')
      const r = n.childForFieldName('right')
      const le = l && exprOf(l)
      const re = r && exprOf(r)
      return le && re ? { cat: [le, re] } : undefined
    }
    case 'call_expression': {
      // a conversion to a string type: Topic("x")
      const args = named(n.childForFieldName('arguments') ?? n)
      return args.length === 1 && /^(interpreted|raw)_string_literal$/.test(args[0].type) ? exprOf(args[0]) : undefined
    }
    default:
      return undefined
  }
}

/** A string literal's value, escapes applied. */
export function stringOf(n: Node): string {
  if (n.type === 'raw_string_literal') return named(n).map(c => c.text).join('')
  let out = ''
  for (const c of named(n)) {
    if (c.type === 'escape_sequence') out += unescape(c.text)
    else out += c.text
  }
  return out
}

function unescape(s: string): string {
  switch (s) {
    case '\\n':
      return '\n'
    case '\\t':
      return '\t'
    case '\\"':
      return '"'
    case '\\\\':
      return '\\'
    default:
      return /^\\u[0-9a-fA-F]{4}$/.test(s) ? String.fromCharCode(parseInt(s.slice(2), 16)) : s.slice(1)
  }
}

/** A function or method as written up to its body, on one line. */
function signatureOf(n: Node, text: string): string | undefined {
  const body = n.childForFieldName('body')
  const s = squash(text.slice(n.startIndex, body ? body.startIndex : n.endIndex))
  return s ? cap(s) : undefined
}

const squash = (s: string) => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')').trim()
const cap = (s: string) => (s.length > SIGNATURE_MAX ? `${s.slice(0, SIGNATURE_MAX - 1)}…` : s)

/** Branches and short-circuits: if, for, case clauses (not default), select cases, &&, ||. */
export function decisionPoints(n: Node): number {
  let count = 0
  const visit = (x: Node) => {
    switch (x.type) {
      case 'if_statement':
      case 'for_statement':
      case 'expression_case':
      case 'type_case':
      case 'communication_case':
        count++
        break
      case 'binary_expression': {
        const op = x.childForFieldName('operator')?.type
        if (op === '&&' || op === '||') count++
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
