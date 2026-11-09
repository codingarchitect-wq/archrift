// A Prisma schema as a database (meta.databases): one per datasource, its
// engine from the provider. Models (and views) are tables named by `@@map`,
// fields are columns named by `@map`, with the type as declared, `?` for
// null, `@id`/`@@id` for the key, `@unique`/`@@unique`, and a database- or
// client-generated `@default` (autoincrement, uuid, cuid, dbgenerated …).
// A relation field is a virtual column leading to its model's table; the
// side with `@relation(fields, references)` holds the foreign key. Enums are
// types, not tables.
import { symbolId } from '../../core/ids.ts'
import type { ColumnMeta, DatabaseMeta, ForeignKeyMeta, IndexMeta, TableMeta } from '../../core/model.ts'
import { parseDatasources } from './prisma.ts'
import type { SchemaBlock } from './prisma.ts'

const ENGINES: Record<string, string> = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', sqlite: 'sqlite', sqlserver: 'sqlserver', cockroachdb: 'cockroachdb', mongodb: 'mongodb' }
const GENERATED = /^(autoincrement|uuid|cuid|dbgenerated|nanoid|ulid|sequence)\b/

interface Attribute {
  name: string
  /** Inside the parentheses, as written ('' without any). */
  args: string
}

type Model = SchemaBlock & { table: string; columnOf: Map<string, string> }

/** The schema's databases: one per datasource (a schema without one is a `db` of unknown engine). */
export function prismaDatabases(path: string, text: string, blocks: SchemaBlock[], module: string): DatabaseMeta[] {
  const sources = parseDatasources(text)
  const datasources = sources.length ? sources : [{ name: 'db', provider: '' }]
  return datasources.map(ds => {
    const engine = ENGINES[ds.provider] ?? 'sql'
    return { id: `db:prisma:${ds.name}`, name: ds.name, engine, sources: ['prisma'], module, tables: prismaTables(path, blocks, engine === 'mongodb') }
  })
}

function prismaTables(path: string, blocks: SchemaBlock[], mongo: boolean): TableMeta[] {
  const models = new Map<string, Model>()
  for (const b of blocks) if (b.kind !== 'enum') models.set(b.name, { ...b, table: blockName(b), columnOf: new Map(b.fields.map(f => [f.name, mapped(f.attributes) ?? f.name])) })
  return [...models.values()].map(m => modelTable(path, m, models, mongo))
}

function modelTable(path: string, m: Model, models: Map<string, Model>, mongo: boolean): TableMeta {
  const columns = m.fields.map(f => fieldColumn(f, m, models))
  const block = m.attributes.map(a => attributes(a)[0]).filter(a => a !== undefined)
  const physical = (fields: string[]) => fields.map(f => m.columnOf.get(f) ?? f)
  for (const id of block.filter(a => a.name === 'id')) for (const c of physical(fieldList(id))) setPk(columns, c)
  return {
    name: m.table,
    kind: m.kind === 'view' ? 'view' : mongo ? 'collection' : 'table',
    ...(m.table !== m.name ? { entity: m.name } : {}),
    nodes: [symbolId(path, m.name)],
    columns,
    references: m.fields.flatMap(f => relationKey(f, m, models)),
    indexes: block.flatMap(a => blockIndex(a, physical)),
  }
}

function fieldColumn(f: SchemaBlock['fields'][number], m: Model, models: Map<string, Model>): ColumnMeta {
  const attrs = attributes(f.attributes)
  const has = (name: string) => attrs.some(a => a.name === name)
  const fallback = attrs.find(a => a.name === 'default')?.args.trim()
  const target = models.get(f.type)
  return {
    name: m.columnOf.get(f.name) ?? f.name,
    type: f.declared,
    ...(has('id') ? { pk: true } : {}),
    ...(f.declared.endsWith('?') ? { nullable: true } : {}),
    ...(has('unique') ? { unique: true } : {}),
    ...(fallback && GENERATED.test(fallback) ? { generated: true } : {}),
    ...(target ? { virtual: true, target: target.table } : {}),
    line: f.line,
  }
}

/** `@relation(fields: [a], references: [id], onDelete: Cascade, map: "fk")`: the foreign key this side holds. */
function relationKey(f: SchemaBlock['fields'][number], m: Model, models: Map<string, Model>): ForeignKeyMeta[] {
  const target = models.get(f.type)
  const relation = attributes(f.attributes).find(a => a.name === 'relation')
  if (!target || !relation) return []
  const args = argumentsOf(relation.args)
  const fields = list(args.named.fields)
  if (!fields.length) return []
  const onDelete = args.named.onDelete?.trim()
  const name = unquote(args.named.map)
  return [
    {
      columns: fields.map(x => m.columnOf.get(x) ?? x),
      table: target.table,
      to: list(args.named.references).map(x => target.columnOf.get(x) ?? x),
      ...(name ? { name } : {}),
      ...(onDelete ? { onDelete } : {}),
    },
  ]
}

/** `@@index([a, b])`, `@@unique([a, b], name: "x", map: "y")`. */
function blockIndex(a: Attribute, physical: (fields: string[]) => string[]): IndexMeta[] {
  if (a.name !== 'index' && a.name !== 'unique') return []
  const args = argumentsOf(a.args)
  const name = unquote(args.named.map) ?? unquote(args.named.name)
  return [{ columns: physical(fieldList(a)), ...(a.name === 'unique' ? { unique: true } : {}), ...(name ? { name } : {}) }]
}

function setPk(columns: ColumnMeta[], name: string) {
  const c = columns.find(x => x.name === name)
  if (!c) return
  c.pk = true
  delete c.nullable
}

const blockName = (b: SchemaBlock) => mapped(b.attributes.join(' ')) ?? b.name

/** The name `@map("x")` gives. */
function mapped(text: string): string | undefined {
  const map = attributes(text).find(a => a.name === 'map')
  return map && unquote(argumentsOf(map.args).positional[0])
}

/** The fields an `@@id`, `@@index` or `@@unique` lists: first positional, or `fields:`. */
const fieldList = (a: Attribute) => {
  const args = argumentsOf(a.args)
  return list(args.positional[0] ?? args.named.fields)
}

// ── attribute syntax ──

/** The attributes on a line: `@id @default(cuid()) @db.VarChar(255)` → id, default (cuid()), db.VarChar (255). */
export function attributes(text: string): Attribute[] {
  const out: Attribute[] = []
  let i = 0
  while ((i = text.indexOf('@', i)) >= 0) {
    const m = /^@+([\w.]+)/.exec(text.slice(i))
    if (!m) {
      i++
      continue
    }
    i += m[0].length
    const args = text[i] === '(' ? balanced(text, i) : ''
    if (args) i += args.length + 2
    out.push({ name: m[1], args })
  }
  return out
}

/** The text inside the parentheses that open at `start`, strings and nesting respected. */
function balanced(text: string, start: number): string {
  let depth = 0
  let quoted = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '"' && text[i - 1] !== '\\') quoted = !quoted
    if (quoted) continue
    depth += nesting(c)
    if (depth === 0) return text.slice(start + 1, i)
  }
  return text.slice(start + 1)
}

const nesting = (c: string) => ('([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0)

/** `[a, b], name: "x"` → positional [`[a, b]`], named { name: `"x"` }. */
export function argumentsOf(args: string): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = []
  const named: Record<string, string> = {}
  for (const part of splitTop(args)) {
    const m = /^(\w+)\s*:\s*([\s\S]*)$/.exec(part)
    if (m) named[m[1]] = m[2].trim()
    else positional.push(part)
  }
  return { positional, named }
}

/** `[a, b(sort: Desc)]` → a, b */
function list(text: string | undefined): string[] {
  if (!text) return []
  const inner = text.trim().replace(/^\[|\]$/g, '')
  return splitTop(inner).map(x => /^\w+/.exec(x)?.[0] ?? x)
}

function splitTop(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' && text[i - 1] !== '\\') quoted = !quoted
    if (quoted) continue
    depth += nesting(c)
    if (c !== ',' || depth !== 0) continue
    out.push(text.slice(from, i).trim())
    from = i + 1
  }
  out.push(text.slice(from).trim())
  return out.filter(Boolean)
}

const unquote = (s: string | undefined) => (s ? /^"([^"]*)"$/.exec(s.trim())?.[1] : undefined)
