// Avro schemas (.avsc) for the JVM reader (docs/POLYGLOT.md, P3): each named
// type (record, enum, fixed) becomes a symbol under its full name, so the
// Kotlin code that imports the class generated from it resolves to the
// schema; fields become members, and a field's record or enum type a
// `type-ref`. JSON keeps no positions, so they are found in the text: the
// `"name"` of each type and field, in order.
import { fileId, memberId, symbolId } from '../../core/ids.ts'
import type { Range } from '../../core/model.ts'
import type { JvmDecl, JvmFile } from './model.ts'

const PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string'])

export function readAvro(text: string, path: string, hash: string): JvmFile {
  const decls: JvmDecl[] = []
  const lines = text.split('\n')
  const loc = lines.filter(l => l.trim() !== '').length
  let schema: unknown
  try {
    schema = JSON.parse(text)
  } catch {
    return { path, hash, language: 'avro', pkg: '', imports: [], decls, loc, complexity: 1, errors: 1 }
  }
  const pairs = bracePairs(text)
  const lineCol = (i: number): [number, number] => {
    const before = text.lastIndexOf('\n', i - 1)
    return [text.slice(0, i).split('\n').length, i - before]
  }
  let cursor = 0
  /** The next `"name": "x"` after the cursor: where a type or field is declared. */
  const find = (name: string): number => {
    const re = new RegExp(`"name"\\s*:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')
    re.lastIndex = cursor
    const m = re.exec(text)
    if (!m) return -1
    cursor = m.index + m[0].length
    return m.index
  }
  /** The JSON object around a position: its first and last line. */
  const objectAround = (i: number): Range => {
    let best: [number, number] | undefined
    for (const p of pairs) if (p[0] < i && p[1] > i && (!best || p[0] > best[0])) best = p
    const [sl, sc] = lineCol(best ? best[0] : i)
    const [el, ec] = lineCol(best ? best[1] : i)
    return [sl, sc, el, ec + 1]
  }
  let pkg = ''
  const fullName = (name: string, ns: string) => (name.includes('.') ? name : ns ? `${ns}.${name}` : name)
  /** Named types a field's type refers to (through unions, arrays and maps), as full names. */
  const uses = (t: unknown, ns: string, out: string[]) => {
    if (typeof t === 'string') {
      if (!PRIMITIVES.has(t)) out.push(fullName(t, ns))
    } else if (Array.isArray(t)) for (const x of t) uses(x, ns, out)
    else if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>
      if (o.type === 'array') uses(o.items, ns, out)
      else if (o.type === 'map') uses(o.values, ns, out)
      else if ((o.type === 'record' || o.type === 'error' || o.type === 'enum' || o.type === 'fixed') && typeof o.name === 'string') {
        named(o, ns)
        out.push(fullName(o.name, typeof o.namespace === 'string' ? o.namespace : ns))
      } else if (typeof o.type !== 'undefined') uses(o.type, ns, out)
    }
  }
  const named = (o: Record<string, unknown>, outerNs: string) => {
    if (typeof o.name !== 'string') return
    const ns = typeof o.namespace === 'string' ? o.namespace : o.name.includes('.') ? o.name.slice(0, o.name.lastIndexOf('.')) : outerNs
    const simple = o.name.slice(o.name.lastIndexOf('.') + 1)
    if (!pkg) pkg = ns
    const at = find(simple)
    const range = at >= 0 ? objectAround(at) : ([1, 1, lines.length, 1] as Range)
    const kind = o.type === 'enum' ? 'enum' : o.type === 'fixed' ? 'type' : 'record'
    const id = symbolId(path, simple)
    decls.push({
      id,
      kind: 'symbol',
      name: simple,
      subkind: kind,
      parent: fileId(path),
      range,
      // a schema, not code: never a "dead export" (the code uses the class generated from it)
      exported: false,
      signature: `${o.type} ${simple}`,
      tags: ['avro'],
      loc: range[2] - range[0] + 1,
      complexity: 1,
      fqn: `${ns}.${simple}`,
      type: kind === 'record' ? 'record' : kind === 'enum' ? 'enum' : 'class',
    })
    if (o.type === 'enum' && Array.isArray(o.symbols))
      for (const s of o.symbols)
        if (typeof s === 'string') decls.push({ id: memberId(path, simple, s), kind: 'member', name: s, subkind: 'enum-entry', parent: id, range: [range[0], 1, range[0], 1], exported: true, tags: [], loc: 1, complexity: 1 })
    if (!Array.isArray(o.fields)) return
    for (const f of o.fields as Record<string, unknown>[]) {
      if (typeof f?.name !== 'string') continue
      const fat = find(f.name)
      const [line, col] = fat >= 0 ? lineCol(fat) : [range[0], 1]
      const used: string[] = []
      uses(f.type, ns, used)
      decls.push({
        id: memberId(path, simple, f.name),
        kind: 'member',
        name: f.name,
        subkind: 'field',
        parent: id,
        range: [line, col, line, col],
        exported: true,
        signature: `${f.name}: ${typeText(f.type)}`.slice(0, 160),
        tags: [],
        loc: 1,
        complexity: 1,
        ...(used.length ? { uses: [...new Set(used)] } : {}),
      })
    }
  }
  for (const s of Array.isArray(schema) ? schema : [schema]) if (s && typeof s === 'object') named(s as Record<string, unknown>, '')
  return { path, hash, language: 'avro', pkg, imports: [], decls, loc, complexity: 1, errors: 0 }
}

/** A field's type, short: `string`, `ProjectEventAvro`, `[null, string]`, `array<Foo>`. */
function typeText(t: unknown): string {
  if (typeof t === 'string') return t.slice(t.lastIndexOf('.') + 1)
  if (Array.isArray(t)) return `[${t.map(typeText).join(', ')}]`
  if (t && typeof t === 'object') {
    const o = t as Record<string, unknown>
    if (o.type === 'array') return `array<${typeText(o.items)}>`
    if (o.type === 'map') return `map<${typeText(o.values)}>`
    if (typeof o.name === 'string') return o.name.slice(o.name.lastIndexOf('.') + 1)
    return typeText(o.type)
  }
  return '?'
}

/** Matching { } pairs outside strings, by start offset. */
function bracePairs(text: string): [number, number][] {
  const out: [number, number][] = []
  const stack: number[] = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') stack.push(i)
    else if (c === '}' && stack.length) out.push([stack.pop()!, i])
  }
  return out.sort((a, b) => a[0] - b[0])
}
