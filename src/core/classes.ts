// Class diagrams from the graph: the families of types joined by `extends` and
// `implements`, or the types of one folder with the associations between them
// (a property typed as another of them). Plain data, computed from the whole
// graph (its symbols and members): the server hands it to the Classes view
// (/api/classes), and `archrift export archify class` writes it for archify.
import { ROOT_ID, parentDir } from './ids.ts'
import type { Graph, GraphEdge, GraphNode } from './model.ts'
import { declKindOf, heritageOf, isCollection, isStatic, visibilityOf } from './type-signatures.ts'

/** A family of types joined by extends/implements, for the view's picker. */
export interface TypeFamily {
  /** The id of its root type (the one the others extend or implement, most members first). */
  id: string
  name: string
  /** Node ids of its types. */
  types: string[]
  classes: number
}

export interface ClassDiagram {
  title: string
  types: TypeBox[]
  relations: TypeRelation[]
}

export interface TypeBox {
  /** The symbol's node id; an `x:` id or the bare name for a type outside the project (`Error`, `Dexie`). */
  id: string
  name: string
  kind: 'class' | 'abstract' | 'interface' | 'type' | 'enum'
  path?: string
  /** Outside the project: drawn as a name only. */
  external?: boolean
  /** As in the graph: the declaration's header (a type alias's is what it stands for). */
  signature?: string
  members: TypeMember[]
}

export interface TypeMember {
  id: string
  name: string
  kind: 'method' | 'property' | 'constructor' | 'accessor'
  /** As in the graph: the declaration's text without its body. */
  signature?: string
  static?: boolean
  visibility?: 'public' | 'protected' | 'private'
}

export interface TypeRelation {
  from: string
  to: string
  kind: 'extends' | 'implements' | 'association'
  /** An association's property name. */
  label?: string
  /** An association to many (an array or collection type). */
  many?: boolean
}

// ── what the graph holds about types ────────────────────────────────────────

/** The type symbols of a graph, their members, and the edges between them (built once per graph). */
interface TypeIndex {
  node: Map<string, GraphNode>
  kind: Map<string, TypeBox['kind']>
  /** A type's members in source order. */
  members: Map<string, GraphNode[]>
  /** extends/implements edges from a type to another. */
  heritage: { from: string; to: string; kind: 'extends' | 'implements' }[]
  /** A member → the types its `type-ref` edges point at. */
  refs: Map<string, string[]>
  families?: TypeFamily[]
}

const indexes = new WeakMap<Graph, TypeIndex>()

/** What a subkind says when the signature doesn't (or there is none). */
const SUBKIND_KIND: Record<string, TypeBox['kind']> = { class: 'class', interface: 'interface', type: 'type', enum: 'enum' }

/** The kind of type a node declares, or undefined when it isn't a type (a function, a variable, a Prisma model). */
export function typeKindOf(n: GraphNode): TypeBox['kind'] | undefined {
  if (n.kind !== 'symbol') return undefined
  const kind = declKindOf(n.signature) ?? SUBKIND_KIND[n.subkind ?? '']
  return kind === 'class' && n.tags?.includes('abstract') ? 'abstract' : kind
}

function indexOf(graph: Graph): TypeIndex {
  const hit = indexes.get(graph)
  if (hit) return hit
  const ix: TypeIndex = { node: new Map(), kind: new Map(), members: new Map(), heritage: [], refs: new Map() }
  for (const n of graph.nodes) indexNode(ix, n)
  for (const n of graph.nodes) if (n.kind === 'member' && n.parent && ix.kind.has(n.parent)) push(ix.members, n.parent, n)
  for (const list of ix.members.values()) list.sort(bySource)
  for (const e of graph.edges) indexEdge(ix, e)
  indexes.set(graph, ix)
  return ix
}

function indexNode(ix: TypeIndex, n: GraphNode) {
  ix.node.set(n.id, n)
  const kind = typeKindOf(n)
  if (kind) ix.kind.set(n.id, kind)
}

function indexEdge(ix: TypeIndex, e: GraphEdge) {
  if ((e.kind === 'extends' || e.kind === 'implements') && ix.kind.has(e.source) && ix.kind.has(e.target) && e.source !== e.target)
    ix.heritage.push({ from: e.source, to: e.target, kind: e.kind })
  else if (e.kind === 'type-ref' && ix.kind.has(e.target) && ix.node.get(e.source)?.kind === 'member') push(ix.refs, e.source, e.target)
}

// ── families ────────────────────────────────────────────────────────────────

/**
 * The families of types joined by extends/implements: the connected
 * components of those edges, two types or more. Classes sharing a base from
 * outside the project (`extends Error`) and joined by nothing else form a
 * family of their own, named after that base. Families with classes first,
 * then the biggest; those of an outside base after the project's own class
 * families.
 */
export function typeFamilies(graph: Graph): TypeFamily[] {
  const ix = indexOf(graph)
  if (ix.families) return ix.families
  const own = projectFamilies(ix)
  const joined = new Set(own.flatMap(f => f.types))
  ix.families = [...own, ...outsideFamilies(ix, joined)].sort(familyOrder)
  return ix.families
}

function projectFamilies(ix: TypeIndex): TypeFamily[] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let r = id
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    parent.set(id, r)
    return r
  }
  for (const h of ix.heritage) {
    const [a, b] = [find(h.from), find(h.to)]
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b)
  }
  const groups = new Map<string, string[]>()
  for (const id of new Set(ix.heritage.flatMap(h => [h.from, h.to]))) push(groups, find(id), id)
  return [...groups.values()].filter(g => g.length > 1).map(types => familyOf(ix, types))
}

function familyOf(ix: TypeIndex, types: string[]): TypeFamily {
  const root = rootOf(ix, types)
  return { id: root, name: ix.node.get(root)?.name ?? root, types: [root, ...types.filter(t => t !== root).sort()], classes: types.filter(t => isClass(ix.kind.get(t))).length }
}

/** The family's root: a type extending nothing in it that others extend or implement, the one with most members. */
function rootOf(ix: TypeIndex, types: string[]): string {
  const inside = new Set(types)
  const extending = new Set(ix.heritage.filter(h => inside.has(h.from) && inside.has(h.to)).map(h => h.from))
  const tops = types.filter(t => !extending.has(t))
  const members = (t: string) => ix.members.get(t)?.length ?? 0
  return [...(tops.length ? tops : types)].sort((a, b) => members(b) - members(a) || cmp(a, b))[0]
}

/** Classes in no family of the project's, grouped by the outside class they extend (two or more). */
function outsideFamilies(ix: TypeIndex, joined: Set<string>): TypeFamily[] {
  const byBase = new Map<string, string[]>()
  for (const [id, kind] of ix.kind) {
    if (!isClass(kind) || joined.has(id)) continue
    const base = heritageOf(ix.node.get(id)?.signature).find(h => h.relation === 'extends')
    if (base) push(byBase, base.name, id)
  }
  return [...byBase]
    .filter(([, types]) => types.length > 1)
    .map(([name, types]) => ({ id: name, name, types: types.sort(), classes: types.length }))
}

/** A family of an outside base has its bare name as id (project ids carry a prefix). */
const isOutside = (f: TypeFamily) => !f.id.includes(':')

function familyOrder(a: TypeFamily, b: TypeFamily): number {
  const rank = (f: TypeFamily) => (isOutside(f) ? 1 : f.classes > 0 ? 0 : 2)
  return rank(a) - rank(b) || b.types.length - a.types.length || cmp(a.name, b.name) || cmp(a.id, b.id)
}

/** A folder whose own files declare types: what the Classes view's folder picker lists. */
export interface TypeFolder {
  /** Its path ('' for the root). */
  path: string
  types: number
}

/** The folders declaring types, most types first. */
export function typeFolders(graph: Graph): TypeFolder[] {
  const ix = indexOf(graph)
  const counts = new Map<string, number>()
  for (const id of ix.kind.keys()) {
    const dir = dirOf(ix.node.get(id)?.path)
    if (dir !== undefined) counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  return [...counts].map(([path, types]) => ({ path, types })).sort((a, b) => b.types - a.types || cmp(a.path, b.path))
}

// ── diagrams ────────────────────────────────────────────────────────────────

/** A family's diagram: its types, the extends/implements between them, the outside bases they name, and the associations among them. */
export function familyDiagram(graph: Graph, familyId: string): ClassDiagram {
  const family = typeFamilies(graph).find(f => f.id === familyId)
  if (!family) return { title: familyId, types: [], relations: [] }
  return diagramOf(indexOf(graph), family.types, family.name)
}

/**
 * The types declared in a folder's own files (not its subfolders'), with
 * the relations between them; a base type declared elsewhere is shown as a
 * name, as is one outside the project.
 */
export function folderDiagram(graph: Graph, folder: string): ClassDiagram {
  const ix = indexOf(graph)
  const path = folder === ROOT_ID ? '' : folder.replace(/^d:/, '').replace(/\/$/, '')
  const ids = [...ix.kind.keys()].filter(id => dirOf(ix.node.get(id)?.path) === path)
  ids.sort((a, b) => bySource(ix.node.get(a)!, ix.node.get(b)!))
  return diagramOf(ix, ids, path || '.')
}

function diagramOf(ix: TypeIndex, ids: string[], title: string): ClassDiagram {
  const inside = new Set(ids)
  const types = ids.filter(id => ix.node.has(id)).map(id => boxOf(ix, id))
  const relations: TypeRelation[] = ix.heritage.filter(h => inside.has(h.from) && inside.has(h.to)).map(h => ({ from: h.from, to: h.to, kind: h.kind }))
  const outside = new Map<string, TypeBox>()
  for (const id of ids) relations.push(...basesOutside(ix, id, inside, outside))
  for (const id of ids) relations.push(...associationsOf(ix, id, inside))
  return { title, types: [...types, ...outside.values()], relations }
}

/** A type's bases that aren't in the diagram: the project's (from its edges) and those outside it (from its signature). */
function basesOutside(ix: TypeIndex, id: string, inside: Set<string>, outside: Map<string, TypeBox>): TypeRelation[] {
  const out: TypeRelation[] = []
  const edges = ix.heritage.filter(h => h.from === id)
  for (const h of edges.filter(h => !inside.has(h.to))) {
    if (!outside.has(h.to)) outside.set(h.to, { ...boxOf(ix, h.to), external: true, members: [] })
    out.push({ from: id, to: h.to, kind: h.kind })
  }
  const named = new Set(edges.map(h => ix.node.get(h.to)?.name))
  for (const h of heritageOf(ix.node.get(id)?.signature)) {
    if (named.has(h.name.split('.').pop())) continue
    if (!outside.has(h.name)) outside.set(h.name, { id: h.name, name: h.name, kind: h.relation === 'implements' ? 'interface' : 'class', external: true, members: [] })
    out.push({ from: id, to: h.name, kind: h.relation })
  }
  return out
}

/** A type's properties typed as another type of the diagram (to many when the property is a collection). */
function associationsOf(ix: TypeIndex, id: string, inside: Set<string>): TypeRelation[] {
  const out: TypeRelation[] = []
  const seen = new Set<string>()
  for (const m of ix.members.get(id) ?? []) {
    if (memberKind(m) !== 'property') continue
    for (const to of ix.refs.get(m.id) ?? []) {
      const key = `${to}\u0000${m.name}`
      if (!inside.has(to) || seen.has(key)) continue
      seen.add(key)
      out.push({ from: id, to, kind: 'association', label: m.name, ...(isCollection(m.signature, m.name) ? { many: true } : {}) })
    }
  }
  return out
}

function boxOf(ix: TypeIndex, id: string): TypeBox {
  const n = ix.node.get(id)!
  return { id, name: n.name, kind: ix.kind.get(id) ?? 'class', ...(n.path ? { path: n.path } : {}), ...(n.signature ? { signature: n.signature } : {}), members: membersOf(ix, id) }
}

/** Properties (and accessors) first, then the constructor, then methods, each in source order. */
function membersOf(ix: TypeIndex, id: string): TypeMember[] {
  const rank = (m: TypeMember) => (m.kind === 'property' || m.kind === 'accessor' ? 0 : m.kind === 'constructor' ? 1 : 2)
  const members = (ix.members.get(id) ?? []).map(memberOf)
  return members.map((m, i) => [m, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([m]) => m)
}

function memberOf(n: GraphNode): TypeMember {
  const visibility = visibilityOf(n.signature, n.name)
  return {
    id: n.id,
    name: n.name,
    kind: memberKind(n),
    ...(n.signature ? { signature: n.signature } : {}),
    ...(isStatic(n.signature, n.name, n.tags) ? { static: true } : {}),
    ...(visibility ? { visibility } : {}),
  }
}

/** Methods, constructors and accessors as they are; anything else a member holds (a field, an enum entry, a Dexie table) is a property. */
function memberKind(n: GraphNode): TypeMember['kind'] {
  return n.subkind === 'method' || n.subkind === 'constructor' || n.subkind === 'accessor' ? n.subkind : 'property'
}

const isClass = (kind: TypeBox['kind'] | undefined) => kind === 'class' || kind === 'abstract'

const dirOf = (path: string | undefined) => (path === undefined ? undefined : parentDir(path))

/** By file, then where in it: line and column. */
function bySource(a: GraphNode, b: GraphNode): number {
  const [ra, rb] = [a.range ?? NOWHERE, b.range ?? NOWHERE]
  return cmp(a.path ?? '', b.path ?? '') || ra[0] - rb[0] || ra[1] - rb[1] || cmp(a.id, b.id)
}

const NOWHERE = [0, 0, 0, 0] as const

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}
