// A class diagram (core/classes.ts) as archify's diagram_type "class": types
// with their attributes and methods read from the members' signatures,
// inheritance and realization from extends/implements, associations from
// properties typed as another type. Supertypes stand in rows above their
// subtypes, each row ordered under the supertypes it extends.
import type { ClassDiagram, TypeBox, TypeMember, TypeRelation } from '../classes.ts'
import { GRID_MAX, Ids, outputName } from './common.ts'

type Visibility = 'public' | 'protected' | 'private'

export interface ClassAttribute {
  name: string
  type?: string
  visibility?: Visibility
  static?: boolean
}

export interface ClassMethod {
  name: string
  parameters?: string
  returns?: string
  visibility?: Visibility
  static?: boolean
  abstract?: boolean
}

export interface ClassType {
  id: string
  label: string
  kind: 'class' | 'abstract' | 'interface' | 'enum' | 'record'
  sublabel?: string
  row: number
  col: number
  attributes?: ClassAttribute[]
  methods?: ClassMethod[]
}

export interface ClassRelationship {
  id: string
  from: string
  to: string
  kind: 'dependency' | 'association' | 'inheritance' | 'realization'
  label?: string
}

export interface ArchifyClass {
  schema_version: 1
  diagram_type: 'class'
  meta: { title: string; subtitle?: string; output: string; quality_profile: 'standard' | 'showcase' }
  layout: { mode: 'grid' }
  types: ClassType[]
  relationships: ClassRelationship[]
}

export function archifyClass(diagram: ClassDiagram, options: { project: string }): ArchifyClass {
  if (!diagram.types.length) throw new Error(`${diagram.title} has no types`)
  const ids = new Ids()
  const kinds = new Map(diagram.types.map(t => [t.id, kindOf(t)]))
  const relations = diagram.relations.filter(r => r.from !== r.to && kinds.has(r.from) && kinds.has(r.to))
  const cells = layered(diagram.types, relations)
  const members = diagram.types.reduce((s, t) => s + t.members.length, 0)
  return {
    schema_version: 1,
    diagram_type: 'class',
    meta: {
      title: diagram.title,
      subtitle: `${diagram.types.length} types, read by archrift from the code`,
      output: outputName(options.project, diagram.title, 'class'),
      // archify never truncates members: a big interface makes a tall box, which its dense profile allows
      quality_profile: diagram.types.length > 12 || members > 60 ? 'standard' : 'showcase',
    },
    layout: { mode: 'grid' },
    types: diagram.types.map(t => typeOf(t, ids, kinds.get(t.id)!, cells.get(t.id)!)),
    relationships: relations.map(r => relationshipOf(r, ids, kinds)),
  }
}

function kindOf(t: TypeBox): ClassType['kind'] {
  if (t.kind === 'type') return 'interface' // a type alias is a shape, as an interface is
  return t.kind
}

function typeOf(t: TypeBox, ids: Ids, kind: ClassType['kind'], [row, col]: [number, number]): ClassType {
  const attributes = t.members.filter(m => m.kind === 'property' || m.kind === 'accessor').map(attributeOf)
  const methods = t.members.filter(m => m.kind === 'method' || m.kind === 'constructor').map(m => methodOf(m, kind))
  const sublabel = t.external ? 'outside the project' : t.kind === 'type' ? 'type alias' : t.path
  return {
    id: ids.of(t.id),
    label: t.name,
    kind,
    ...(sublabel ? { sublabel } : {}),
    row,
    col,
    ...(attributes.length ? { attributes } : {}),
    ...(methods.length ? { methods } : {}),
  }
}

/** Modifiers a signature starts with, and what they say. */
const MODIFIERS = /^(?:(public|protected|private|static|readonly|abstract|declare|override|async|get|set|#)\s*)+/

function modifiers(signature: string): { rest: string; words: Set<string> } {
  const m = MODIFIERS.exec(signature.trim())
  const words = new Set((m?.[0] ?? '').split(/\s+/).filter(Boolean))
  return { rest: signature.trim().slice(m?.[0].length ?? 0).trim(), words }
}

const visibilityOf = (m: TypeMember, words: Set<string>): Visibility | undefined =>
  m.visibility ?? (words.has('private') || m.name.startsWith('#') ? 'private' : words.has('protected') ? 'protected' : undefined)

/** `name?: Type` (or `readonly name: Type = …`) → name and type. */
export function attributeOf(m: TypeMember): ClassAttribute {
  const { rest, words } = modifiers(m.signature ?? m.name)
  const colon = topLevelIndex(rest, ':')
  const type = colon < 0 ? undefined : rest.slice(colon + 1).split(/\s=\s/)[0].trim().replace(/;$/, '')
  const visibility = visibilityOf(m, words)
  return {
    name: m.name,
    ...(type ? { type } : {}),
    ...(visibility ? { visibility } : {}),
    ...(m.static || words.has('static') ? { static: true } : {}),
  }
}

/** `name(a: A, b?: B): R` → its parameters and return type. */
export function methodOf(m: TypeMember, owner: ClassType['kind']): ClassMethod {
  const { rest, words } = modifiers(m.signature ?? m.name)
  const open = rest.indexOf('(')
  const close = open < 0 ? -1 : matching(rest, open)
  const parameters = close < 0 ? undefined : rest.slice(open + 1, close).replace(/\s+/g, ' ').trim()
  const after = close < 0 ? '' : rest.slice(close + 1).trim()
  const returns = after.startsWith(':') ? after.slice(1).replace(/\s*\{[\s\S]*$/, '').trim() : undefined
  const visibility = visibilityOf(m, words)
  return {
    name: m.kind === 'constructor' ? 'constructor' : m.name,
    ...(parameters ? { parameters } : {}),
    ...(returns ? { returns } : {}),
    ...(visibility ? { visibility } : {}),
    ...(m.static || words.has('static') ? { static: true } : {}),
    // an interface's methods are contracts, as UML draws them
    ...(words.has('abstract') || owner === 'interface' ? { abstract: true } : {}),
  }
}

/** The index of `ch` outside brackets and quotes, or -1. */
function topLevelIndex(text: string, ch: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if ('([{<'.includes(c)) depth++
    else if (')]}>'.includes(c)) depth--
    else if (c === ch && depth === 0) return i
  }
  return -1
}

/** The index of the bracket closing the one at `open`, or -1. */
function matching(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return -1
}

/**
 * archify's notation: inheritance stays within classes or within interfaces,
 * realization runs from a class to an interface. What TypeScript allows beyond
 * that (an interface extending a class) is shown as a dependency labelled so.
 */
function relationshipOf(r: TypeRelation, ids: Ids, kinds: Map<string, ClassType['kind']>): ClassRelationship {
  const from = ids.of(r.from)
  const to = ids.of(r.to)
  const id = ids.of([r.from, r.kind, r.to, r.label].filter(Boolean).join('__'))
  if (r.kind === 'association') return { id, from, to, kind: 'association', ...(r.label ? { label: r.many ? `${r.label} [*]` : r.label } : {}) }
  const iface = (k: ClassType['kind']) => k === 'interface'
  const a = kinds.get(r.from)!
  const b = kinds.get(r.to)!
  if (r.kind === 'implements' && !iface(a) && iface(b)) return { id, from, to, kind: 'realization' }
  if (iface(a) === iface(b)) return { id, from, to, kind: 'inheritance' }
  return { id, from, to, kind: 'dependency', label: r.kind }
}

/**
 * Rows by depth along extends/implements (a type one row below the deepest of
 * its supertypes), each row ordered under its supertypes and centered on the
 * widest, a row wider than the grid continuing on the next.
 */
function layered(types: readonly TypeBox[], relations: readonly TypeRelation[]): Map<string, [number, number]> {
  const supers = new Map<string, string[]>(types.map(t => [t.id, []]))
  for (const r of relations) if (r.kind !== 'association') supers.get(r.from)!.push(r.to)
  const depth = new Map<string, number>()
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!
    if (seen.has(id)) return 0 // a cycle archify would refuse anyway
    seen.add(id)
    const d = Math.min(GRID_MAX, Math.max(-1, ...supers.get(id)!.map(s => depthOf(s, seen))) + 1)
    depth.set(id, d)
    return d
  }
  const rows: string[][] = []
  for (const t of types) (rows[depthOf(t.id)] ??= []).push(t.id)
  const dense = rows.filter(Boolean)
  const col = new Map<string, number>()
  for (const row of dense) {
    const under = (id: string) => {
      const at = supers.get(id)!.map(s => col.get(s)).filter((x): x is number => x !== undefined)
      return at.length ? at.reduce((s, x) => s + x, 0) / at.length : Number.POSITIVE_INFINITY
    }
    row.sort((a, b) => under(a) - under(b))
    row.forEach((id, i) => col.set(id, i - (row.length - 1) / 2))
  }
  // a row wider than the grid continues on the next
  const width = GRID_MAX + 1
  const wrapped = dense.flatMap(row => Array.from({ length: Math.ceil(row.length / width) }, (_, k) => row.slice(k * width, (k + 1) * width)))
  if (wrapped.length > GRID_MAX + 1) throw new Error(`${types.length} types need ${wrapped.length} rows; an archify class diagram holds ${GRID_MAX + 1}`)
  const widest = Math.max(...wrapped.map(r => r.length))
  const cells = new Map<string, [number, number]>()
  wrapped.forEach((row, r) => {
    // whole cells only: a half step takes both neighboring cells, which a full row would collide with
    const start = Math.floor((widest - row.length) / 2)
    row.forEach((id, i) => cells.set(id, [r, start + i]))
  })
  return cells
}
