// JPA entities and Mongo documents as schema facts (plugins/schema-facts.ts),
// read in the JVM reader's second pass, when constants and types resolve.
//
// A JPA entity's columns are its stored properties and those of its
// `@MappedSuperclass` supertypes (the root's first): `@Column` names them,
// `@Id` and `@GeneratedValue` mark the key, a Kotlin `?` type may be null
// unless `@Column(nullable = false)` says otherwise. `@ManyToOne` and an
// owning `@OneToOne` store a join column (`@JoinColumn(name)`, by default
// `<property>_<the target's key>`) that references the target entity;
// `@OneToMany`, `@ManyToMany`, `@ElementCollection` and an inverse
// `@OneToOne` (mappedBy) are virtual columns. An `@Embedded` property (or one
// whose type is `@Embeddable`) is flattened into the embeddable's columns,
// renamed by `@AttributeOverride`; when the embeddable can't be resolved (a
// type parameter) its overrides, else the property, give the columns.
// Names are kept as the code writes them: plugins/schemas.ts applies the
// module's naming strategy (Spring's snake_case by default).
//
// A Mongo document's fields are its stored properties and its supertypes'
// (classes, not interfaces): `@Field` renames one, `@Id` (or a property named
// `id`) is stored as `_id`, `@DBRef` and `@DocumentReference` are virtual
// columns, `@Indexed` and `@CompoundIndex` are indexes.
import type { IndexMeta } from '../../core/model.ts'
import type { EntityFact, FactColumn, FactForeignKey } from '../plugins/schema-facts.ts'
import type { JvmIndex, Scope } from './index.ts'
import type { Annotation, Expr, JvmDecl, TypeRef } from './model.ts'

const simple = (name: string) => name.slice(name.lastIndexOf('.') + 1)
const RELATIONS = ['ManyToOne', 'OneToOne', 'OneToMany', 'ManyToMany', 'ElementCollection']

interface Ctx {
  index: JvmIndex
  entity: JvmDecl
  mongo: boolean
  /** Class-level `@AttributeOverride`s, by attribute: the entity's own over its superclasses'. */
  overrides: Map<string, Annotation>
  /** A Mongo document declares its key with `@Id` (else a property named `id` is the key). */
  explicitId: boolean
  columns: FactColumn[]
  references: FactForeignKey[]
  indexes: IndexMeta[]
}

/** The schema fact of an entity class (tagged `entity` by spring.ts). */
export function entityFact(decl: JvmDecl, index: JvmIndex): EntityFact {
  const mongo = decl.tags.includes('db:mongodb')
  const inheritance = mongo ? undefined : inheritanceOf(decl, index)
  const joined = inheritance?.strategy === 'JOINED'
  const chain = [...storedSupertypes(decl, index, mongo, joined), decl]
  const ctx: Ctx = { index, entity: decl, mongo, overrides: new Map(), explicitId: false, columns: [], references: [], indexes: [] }
  if (joined) joinedKey(inheritance!.root, ctx)
  for (const t of [...chain].reverse()) for (const o of overridesOf(t)) if (!ctx.overrides.has(o.attribute)) ctx.overrides.set(o.attribute, o.column)
  const properties = storedProperties(chain, index)
  ctx.explicitId = properties.some(p => has(p, 'Id', 'MongoId', 'EmbeddedId'))
  for (const p of properties) (mongo ? mongoProperty : jpaProperty)(p, ctx)
  classIndexes(decl, ctx)
  // single-table inheritance: the subclass's rows are the root entity's table
  const named = inheritance?.strategy === 'SINGLE_TABLE' ? inheritance.root : decl
  const scope = index.scopeOf(named)
  const name = mongo ? collectionName(decl, scope, index) : tableName(named, scope, index)
  const shared = named !== decl ? { sharesTableOf: named.id } : {}
  return { type: 'entity', source: mongo ? 'mongo' : 'jpa', owner: decl.id, name, entity: simple(decl.name), ...shared, columns: ctx.columns, references: ctx.references, indexes: ctx.indexes }
}

// ── names ──

function tableName(decl: JvmDecl, scope: Scope, index: JvmIndex): string {
  return text(arg(find(decl, 'Table'), 'name'), scope, index) ?? text(arg(find(decl, 'Entity'), 'name'), scope, index) ?? simple(decl.name)
}

function collectionName(decl: JvmDecl, scope: Scope, index: JvmIndex): string {
  const written = text(arg(find(decl, 'Document'), 'collection', 'value', ''), scope, index)
  if (written) return written
  const name = simple(decl.name)
  return name[0].toLowerCase() + name.slice(1)
}

// ── which properties are stored ──

/**
 * Supertypes whose properties the entity stores, the root first: a document's classes; JPA's mapped
 * superclasses and entity supertypes (single-table or table-per-class inheritance), but not those
 * of a JOINED parent, whose columns are in its own table.
 */
function storedSupertypes(decl: JvmDecl, index: JvmIndex, mongo: boolean, joined = false, seen = new Set<string>([decl.id])): JvmDecl[] {
  const out: JvmDecl[] = []
  for (const s of index.supertypes(decl)) {
    if (seen.has(s.decl.id)) continue
    seen.add(s.decl.id)
    if (isStoredSupertype(s.decl, mongo, joined)) out.unshift(...storedSupertypes(s.decl, index, mongo, joined, seen), s.decl)
  }
  return out
}

function isStoredSupertype(t: JvmDecl, mongo: boolean, joined: boolean): boolean {
  if (mongo) return t.type === 'class'
  return has(t, 'MappedSuperclass') || (!joined && t.tags.includes('entity'))
}

/** JPA entity inheritance: the topmost entity supertype, and its strategy (SINGLE_TABLE unless its @Inheritance says otherwise). */
function inheritanceOf(decl: JvmDecl, index: JvmIndex, seen = new Set<string>()): { root: JvmDecl; strategy: string } | undefined {
  seen.add(decl.id)
  const parent = index.supertypes(decl).find(s => s.decl.tags.includes('entity') && !seen.has(s.decl.id))?.decl
  if (!parent) return undefined
  const root = inheritanceOf(parent, index, seen)?.root ?? parent
  return { root, strategy: refOf(arg(find(root, 'Inheritance'), 'strategy', '')) ?? 'SINGLE_TABLE' }
}

/** A JOINED subclass's table starts with the root's key, which references the root's table. */
function joinedKey(root: JvmDecl, ctx: Ctx) {
  const key = idColumn(root, ctx.index)
  if (!key) return
  ctx.columns.push({ name: key.name, ...present({ type: key.type }), pk: true })
  ctx.references.push({ columns: [key.name], entity: root.id, to: [key.name] })
}

/** The stored properties of a chain of types, the root's first; a property a subtype declares again is the subtype's. */
function storedProperties(chain: JvmDecl[], index: JvmIndex): JvmDecl[] {
  const seen = new Set<string>()
  const perType = [...chain].reverse().map(t =>
    index.ownMembers(t).filter(m => {
      if (!isStored(m) || seen.has(m.name)) return false
      seen.add(m.name)
      return true
    }),
  )
  return perType.reverse().flat()
}

const isStored = (m: JvmDecl) => m.subkind === 'property' && !m.companion && !m.computed && !m.tags.includes('const') && !has(m, 'Transient')

// ── JPA ──

function jpaProperty(p: JvmDecl, ctx: Ctx) {
  if (relation(p, ctx)) return
  if (embedded(p, ctx)) return
  ctx.columns.push(basicColumn(p, ctx))
}

function basicColumn(p: JvmDecl, ctx: Ctx): FactColumn {
  const scope = ctx.index.scopeOf(p)
  const column = ctx.overrides.get(p.name) ?? find(p, 'Column')
  const pk = has(p, 'Id')
  const definition = text(arg(column, 'columnDefinition'), scope, ctx.index) ?? ''
  const declared = flag(arg(column, 'nullable')) ?? (/\bnot\s+null\b/i.test(definition) ? false : undefined)
  return {
    name: text(arg(column, 'name'), scope, ctx.index) ?? p.name,
    ...typeOf(p, ctx.index),
    ...present({ pk, nullable: !pk && (declared ?? p.nullable === true), unique: flag(arg(column, 'unique')), generated: has(p, 'GeneratedValue') }),
    ...lineOf(p, ctx),
  }
}

/** A relation: a join column and its foreign key (`@ManyToOne`, an owning `@OneToOne`), else a virtual column. */
function relation(p: JvmDecl, ctx: Ctx): boolean {
  const kind = find(p, ...RELATIONS)
  if (!kind) return false
  const target = relatedEntity(p, ctx.index)
  const owning = (simple(kind.name) === 'ManyToOne' || simple(kind.name) === 'OneToOne') && !arg(kind, 'mappedBy')
  if (owning) joinColumns(p, kind, target, ctx)
  else ctx.columns.push({ name: p.name, ...typeOf(p, ctx.index), virtual: true, ...present({ entity: target?.id, target: collectionTable(p, kind, ctx) }), ...lineOf(p, ctx) })
  return true
}

/** An `@ElementCollection`'s table: `@CollectionTable(name)`, else JPA's `<entity>_<attribute>`. */
function collectionTable(p: JvmDecl, kind: Annotation, ctx: Ctx): string | undefined {
  if (simple(kind.name) !== 'ElementCollection') return undefined
  const scope = ctx.index.scopeOf(p)
  const entityName = text(arg(find(ctx.entity, 'Entity'), 'name'), ctx.index.scopeOf(ctx.entity), ctx.index) ?? simple(ctx.entity.name)
  return text(arg(find(p, 'CollectionTable'), 'name'), scope, ctx.index) ?? `${entityName}_${p.name}`
}

function joinColumns(p: JvmDecl, kind: Annotation, target: JvmDecl | undefined, ctx: Ctx) {
  const scope = ctx.index.scopeOf(p)
  const joins = joinAnnotations(p)
  const key = target ? idColumn(target, ctx.index) : undefined
  const optional = flag(arg(kind, 'optional')) !== false
  const columns = (joins.length ? joins : [undefined]).map(j => joinColumn(p, j, key, optional, ctx))
  for (const c of columns) ctx.columns.push(c.column)
  if (!target) return
  const refs = columns.flatMap(c => (c.ref ? [c.ref] : []))
  ctx.references.push({
    columns: columns.map(c => c.column.name),
    entity: target.id,
    ...(refs.length === columns.length ? { to: refs } : {}),
    ...present({ name: text(arg(nested(arg(joins[0], 'foreignKey'))[0], 'name', ''), scope, ctx.index), onDelete: refOf(arg(find(p, 'OnDelete'), 'action', '')) }),
  })
}

/** One join column: named by `@JoinColumn(name)`, else `<property>_<the referenced column>`. */
function joinColumn(p: JvmDecl, j: Annotation | undefined, key: { name: string; type?: string } | undefined, optional: boolean, ctx: Ctx): { column: FactColumn; ref?: string } {
  const scope = ctx.index.scopeOf(p)
  const ref = text(arg(j, 'referencedColumnName'), scope, ctx.index)
  const name = text(arg(j, 'name'), scope, ctx.index) ?? `${p.name}_${ref ?? key?.name ?? 'id'}`
  const nullable = p.nullable === true && optional && flag(arg(j, 'nullable')) !== false
  return { column: { name, ...present({ type: key?.type, nullable, unique: flag(arg(j, 'unique')) }), ...lineOf(p, ctx) }, ...present({ ref }) }
}

/** `@JoinColumn`, or each of `@JoinColumns(…)`. */
function joinAnnotations(p: JvmDecl): Annotation[] {
  const one = find(p, 'JoinColumn')
  if (one) return [one]
  const many = find(p, 'JoinColumns')
  return many ? many.args.flatMap(a => nested(a.value)) : []
}

/** An `@Embedded` (or `@Embeddable`-typed) property: the embeddable's columns, renamed by the property's `@AttributeOverride`s. */
function embedded(p: JvmDecl, ctx: Ctx): boolean {
  const type = typeDecl(p, ctx.index)
  const embeddable = type && has(type, 'Embeddable') ? type : undefined
  if (!embeddable && !has(p, 'Embedded', 'EmbeddedId')) return false
  const overrides = new Map(overridesOf(p).map(o => [o.attribute, o.column]))
  // an embeddable's mapped superclasses hold some of its columns, as an entity's do
  const parts = embeddable ? storedProperties([...storedSupertypes(embeddable, ctx.index, false, true), embeddable], ctx.index) : []
  const columns = parts.length
    ? parts.map(part => embeddedColumn(part, overrides.get(part.name) ?? find(part, 'Column'), p, ctx))
    : unresolvedEmbedded(p, overrides, ctx)
  for (const c of columns) ctx.columns.push({ ...c, ...present({ pk: has(p, 'EmbeddedId') }), ...lineOf(p, ctx) })
  return true
}

function embeddedColumn(part: JvmDecl, column: Annotation | undefined, owner: JvmDecl, ctx: Ctx): FactColumn {
  const name = text(arg(column, 'name'), ctx.index.scopeOf(part), ctx.index) ?? part.name
  return { name, ...typeOf(part, ctx.index), ...present({ nullable: owner.nullable === true || (flag(arg(column, 'nullable')) ?? part.nullable === true) }) }
}

/** An embeddable the reader can't see (a type parameter): a column per override, else one named after the property. */
function unresolvedEmbedded(p: JvmDecl, overrides: Map<string, Annotation>, ctx: Ctx): FactColumn[] {
  const scope = ctx.index.scopeOf(p)
  if (!overrides.size) return [{ name: p.name, ...typeOf(p, ctx.index), ...(p.nullable ? { nullable: true } : {}) }]
  return [...overrides].map(([attribute, column]) => {
    const nullable = flag(arg(column, 'nullable')) ?? p.nullable === true
    return { name: text(arg(column, 'name'), scope, ctx.index) ?? attribute, ...(nullable ? { nullable: true } : {}) }
  })
}

/** The key column of an entity (`@Id`, possibly a mapped superclass's): its name as written and its type. */
function idColumn(entity: JvmDecl, index: JvmIndex): { name: string; type?: string } | undefined {
  const chain = [...storedSupertypes(entity, index, false, true), entity]
  const id = storedProperties(chain, index).find(p => has(p, 'Id'))
  if (!id) return undefined
  const name = text(arg(find(id, 'Column'), 'name'), index.scopeOf(id), index) ?? id.name
  const type = typeOf({ ...id, nullable: false }, index).type
  return { name, ...(type ? { type } : {}) }
}

// ── Mongo ──

function mongoProperty(p: JvmDecl, ctx: Ctx) {
  const scope = ctx.index.scopeOf(p)
  const isId = has(p, 'Id', 'MongoId') || (!ctx.explicitId && p.name === 'id')
  const name = isId ? '_id' : (text(arg(find(p, 'Field'), 'name', 'value', ''), scope, ctx.index) ?? p.name)
  if (has(p, 'DBRef', 'DocumentReference')) {
    const target = relatedEntity(p, ctx.index)
    ctx.columns.push({ name, ...typeOf(p, ctx.index), virtual: true, ...present({ entity: target?.id }), ...lineOf(p, ctx) })
    return
  }
  ctx.columns.push({ name, ...typeOf(p, ctx.index), ...present({ pk: isId, nullable: !isId && p.nullable === true }), ...lineOf(p, ctx) })
  const indexed = find(p, 'Indexed', 'TextIndexed')
  if (indexed) ctx.indexes.push({ columns: [name], ...present({ unique: flag(arg(indexed, 'unique')), name: text(arg(indexed, 'name'), scope, ctx.index) }) })
}

// ── indexes declared on the class ──

function classIndexes(decl: JvmDecl, ctx: Ctx) {
  const scope = ctx.index.scopeOf(decl)
  const read = (e: Expr | undefined) => text(e, scope, ctx.index)
  const table = find(decl, 'Table')
  for (const i of nested(arg(table, 'indexes')))
    pushIndex(ctx, splitColumns(read(arg(i, 'columnList'))), flag(arg(i, 'unique')) === true, read(arg(i, 'name')))
  for (const u of nested(arg(table, 'uniqueConstraints')))
    pushIndex(ctx, ctx.index.evaluate(arg(u, 'columnNames', '') ?? { arr: [] }, scope) ?? [], true, read(arg(u, 'name')))
  const compound = [find(decl, 'CompoundIndex'), ...nested(arg(find(decl, 'CompoundIndexes'), 'value', ''))].filter(a => a !== undefined)
  for (const c of compound) pushIndex(ctx, documentKeys(read(arg(c, 'def', 'value', ''))), flag(arg(c, 'unique')) === true, read(arg(c, 'name')))
}

function pushIndex(ctx: Ctx, columns: string[], unique: boolean, name: string | undefined) {
  if (columns.length) ctx.indexes.push({ columns, ...(unique ? { unique: true } : {}), ...(name ? { name } : {}) })
}

/** `"a, b DESC"` → a, b */
const splitColumns = (list: string | undefined) => (list ?? '').split(',').map(c => c.trim().split(/\s+/)[0]).filter(Boolean)

/** A compound index's definition, `{'a': 1, 'b': -1}` → a, b */
const documentKeys = (def: string | undefined) => [...(def ?? '').matchAll(/['"]?([\w.$]+)['"]?\s*:/g)].map(m => m[1])

// ── overrides ──

/** `@AttributeOverride(name, column = Column(…))`, also inside `@AttributeOverrides(…)`. */
function overridesOf(d: JvmDecl): { attribute: string; column: Annotation }[] {
  const all = [find(d, 'AttributeOverride'), ...(find(d, 'AttributeOverrides')?.args.flatMap(a => nested(a.value)) ?? [])]
  const out: { attribute: string; column: Annotation }[] = []
  for (const o of all) {
    const attribute = o && literal(arg(o, 'name'))
    const column = nested(arg(o, 'column'))[0]
    if (attribute && column) out.push({ attribute, column })
  }
  return out
}

// ── types ──

/** The type a property declares, as written (`List<Topic>?`); its class's type parameter (`PK` in `Base<PK>`) says nothing. */
function typeOf(p: JvmDecl, index: JvmIndex): { type?: string } {
  if (!p.valueType || isTypeParameter(p.valueType, index.decls.get(p.parent))) return {}
  return { type: format(p.valueType) + (p.nullable ? '?' : '') }
}

const format = (t: TypeRef): string => t.name.join('.') + (t.args?.length ? `<${t.args.map(format).join(', ')}>` : '')

/** A name the owning class declares as a type parameter, read from its signature (`class Base<in PK : Serializable, EID>`). */
function isTypeParameter(t: TypeRef, owner: JvmDecl | undefined): boolean {
  const params = /^[^<(]*<([^>]*)>/.exec(owner?.signature ?? '')?.[1] ?? ''
  const names = params.split(',').map(x => x.trim().replace(/^(in|out|reified)\s+/, '').split(/[\s:]/)[0])
  return t.name.length === 1 && !t.args && names.includes(t.name[0])
}

/** The project type a property is declared with. */
function typeDecl(p: JvmDecl, index: JvmIndex): JvmDecl | undefined {
  return p.valueType ? index.resolveType(p.valueType.name, index.scopeOf(p))[0] : undefined
}

/** The entity a relation leads to: the property's type, or a collection's first type argument. */
function relatedEntity(p: JvmDecl, index: JvmIndex): JvmDecl | undefined {
  const scope = index.scopeOf(p)
  for (const t of [p.valueType, ...(p.valueType?.args ?? [])]) {
    const decl = t && index.resolveType(t.name, scope)[0]
    if (decl?.tags.includes('entity')) return decl
  }
  return undefined
}

// ── annotations ──

function has(d: { annotations?: Annotation[] }, ...names: string[]): boolean {
  return !!find(d, ...names)
}

function find(d: { annotations?: Annotation[] } | undefined, ...names: string[]): Annotation | undefined {
  return d?.annotations?.find(a => names.includes(simple(a.name)))
}

/** An argument by name; '' is the first positional one. */
function arg(a: Annotation | undefined, ...names: string[]): Expr | undefined {
  if (!a) return undefined
  for (const n of names) {
    const found = n === '' ? a.args.find(x => x.name === undefined) : a.args.find(x => x.name === n)
    if (found) return found.value
  }
  return undefined
}

/** Annotations nested in an argument: `Column(…)`, or an array of `Index(…)`. */
function nested(e: Expr | undefined): Annotation[] {
  if (!e) return []
  if ('arr' in e) return e.arr.flatMap(nested)
  if (!('call' in e)) return []
  return [{ name: e.call.join('.'), args: e.args.map((value, i) => ({ ...(e.names?.[i] ? { name: e.names[i] } : {}), value })), site: [0, 0] }]
}

const text = (e: Expr | undefined, scope: Scope, index: JvmIndex) => (e ? index.evaluate(e, scope)?.[0] : undefined)
const literal = (e: Expr | undefined) => (e && 's' in e ? e.s : undefined)
const refOf = (e: Expr | undefined) => (e && 'ref' in e ? e.ref[e.ref.length - 1] : undefined)

/** `true` / `false` as written; undefined for anything else. */
function flag(e: Expr | undefined): boolean | undefined {
  const v = e && ('other' in e ? e.other : 'ref' in e && e.ref.length === 1 ? e.ref[0] : undefined)
  return v === undefined ? undefined : v === 'true' ? true : v === 'false' ? false : undefined
}

/** The fields that hold something: flags that are true, strings and ids that are set. */
function present<T extends Record<string, string | boolean | undefined>>(fields: T): Partial<{ [K in keyof T]: Exclude<T[K], false | undefined> }> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== false && v !== '')) as never
}

const lineOf = (p: JvmDecl, ctx: Ctx) => (ctx.index.fileOf(p.id) === ctx.index.fileOf(ctx.entity.id) ? { line: p.range[0] } : {})
