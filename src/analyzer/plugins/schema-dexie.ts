// Dexie (IndexedDB) databases for meta.databases. While a file is extracted:
// each `class … extends Dexie` (its `super('name')` and table members), and
// each `version(n).stores({…})` call on one, with spreads and constants
// followed through the checker. When the graph is assembled: per class, the
// versions in order, each table's last declaration winning (`null` deletes
// it), parsed the way Dexie reads a stores string: the first entry is the
// primary key (`++` auto-increments, empty or bare `++` is an outbound key
// outside the row), the others indexes (`&` unique, `*` multi-entry,
// `[a+b]` compound). Dexie declares only what it indexes: no other columns,
// no foreign keys.
import ts from 'typescript'
import type { ColumnMeta, DatabaseMeta, IndexMeta, TableMeta } from '../../core/model.ts'
import { constantString, declarationOf } from './evaluate.ts'
import type { DexieClassFact, DexieStoresFact } from './schema-facts.ts'
import { propertyName, unwrap } from './syntax.ts'
import type { ExtractApi } from './types.ts'

const MAX_DEPTH = 8

export const extendsDexie = (c: ts.Node): c is ts.ClassDeclaration =>
  ts.isClassDeclaration(c) && !!c.heritageClauses?.some(h => h.token === ts.SyntaxKind.ExtendsKeyword && h.types.some(t => /(^|\.)Dexie$/.test(t.expression.getText())))

export const isTable = (m: ts.Node) => ts.isPropertyDeclaration(m) && !!m.type && /^(Dexie\.)?(Table|EntityTable)\b/.test(m.type.getText()) && extendsDexie(m.parent)

// ── extraction ──

/** Records a Dexie class and its tables. */
export function dexieClass(c: ts.ClassDeclaration, api: ExtractApi) {
  const id = api.idOf(c)
  if (!id) return
  const tables = c.members.filter(isTable).flatMap(m => {
    const node = api.idOf(m)
    const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined
    return node && name ? [{ name, ...rowType(m as ts.PropertyDeclaration), node, line: api.site(m)[0] }] : []
  })
  const fact: DexieClassFact = { type: 'dexie-class', id, name: databaseName(c, api) ?? c.name?.text ?? 'Dexie', tables }
  api.emit(fact, 'schema')
}

/** The name its constructor gives `super(…)`, when it is a constant. */
function databaseName(c: ts.ClassDeclaration, api: ExtractApi): string | undefined {
  const ctor = c.members.find(ts.isConstructorDeclaration)
  for (const s of ctor?.body?.statements ?? []) {
    const e = ts.isExpressionStatement(s) ? unwrap(s.expression) : undefined
    if (e && ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.SuperKeyword) return constantString(e.arguments[0], { checker: api.checker, follow: d => void api.idOf(d) }) || undefined
  }
  return undefined
}

/** `Table<LocalAccount>` → LocalAccount (the row type's name, when it has one). */
function rowType(m: ts.PropertyDeclaration): { entity?: string } {
  const arg = m.type && ts.isTypeReferenceNode(m.type) ? m.type.typeArguments?.[0] : undefined
  return arg && ts.isTypeReferenceNode(arg) ? { entity: arg.typeName.getText() } : {}
}

/** Records `x.version(n).stores({…})` when x is a Dexie subclass. */
export function dexieStores(call: ts.CallExpression, api: ExtractApi) {
  const parts = storesCall(call)
  const db = parts && dexieOf(parts.receiver, api)
  const version = db ? Number(constantString(parts.version, { checker: api.checker })) : NaN
  const entries = Number.isNaN(version) ? undefined : storesOf(parts!.spec, api, 0)
  if (!db || !entries) return
  const fact: DexieStoresFact = { type: 'dexie-stores', db, version, stores: {}, lines: {} }
  for (const [table, e] of entries) {
    fact.stores[table] = e.spec
    if (e.line) fact.lines[table] = e.line
  }
  api.emit(fact, 'schema')
}

/** `receiver.version(n).stores(spec)`, taken apart. */
function storesCall(call: ts.CallExpression): { receiver: ts.Expression; version: ts.Expression; spec: ts.Expression } | undefined {
  const callee = unwrap(call.expression)
  const version = ts.isPropertyAccessExpression(callee) && callee.name.text === 'stores' ? unwrap(callee.expression) : undefined
  if (!version || !ts.isCallExpression(version) || !ts.isPropertyAccessExpression(version.expression)) return undefined
  const [n] = version.arguments
  const [spec] = call.arguments
  return version.expression.name.text === 'version' && n && spec ? { receiver: version.expression.expression, version: n, spec } : undefined
}

/** The Dexie subclass an expression is an instance of (`this` in its constructor, a `db` of its type). */
function dexieOf(e: ts.Expression, api: ExtractApi): string | undefined {
  const symbol = api.checker.getTypeAtLocation(e).getSymbol()
  const decl = symbol?.declarations?.find(extendsDexie)
  return decl && api.idOf(decl)
}

type Entries = Map<string, { spec: string | null; line?: number }>

/** A stores() argument: an object literal, spreads and names of constants followed. */
function storesOf(e: ts.Expression, api: ExtractApi, depth: number): Entries | undefined {
  if (depth > MAX_DEPTH) return undefined
  const x = unwrap(e)
  if (ts.isObjectLiteralExpression(x)) return objectStores(x, api, depth)
  if (!ts.isIdentifier(x) && !ts.isPropertyAccessExpression(x)) return undefined
  const decl = declarationOf(x, api.checker)
  if (decl) api.idOf(decl)
  const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined
  return init ? storesOf(init, api, depth + 1) : undefined
}

function objectStores(o: ts.ObjectLiteralExpression, api: ExtractApi, depth: number): Entries {
  const out: Entries = new Map()
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) for (const [k, v] of storesOf(p.expression, api, depth + 1) ?? []) out.set(k, v)
    else {
      const entry = storeEntry(p, api)
      if (entry) out.set(entry.name, entry.value)
    }
  }
  return out
}

/** `accounts: 'id, iban'` (or `null`, or a constant): the table and its stores string. */
function storeEntry(p: ts.ObjectLiteralElementLike, api: ExtractApi): { name: string; value: { spec: string | null; line?: number } } | undefined {
  const name = propertyName(p)
  const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined
  if (!name || !value) return undefined
  const spec = unwrap(value).kind === ts.SyntaxKind.NullKeyword ? null : constantString(value, { checker: api.checker, follow: d => void api.idOf(d) })
  if (spec === undefined) return undefined
  // the line is only meaningful in the file being extracted
  return { name, value: { spec, ...(p.getSourceFile() === api.sf ? { line: api.site(p)[0] } : {}) } }
}

// ── assembly ──

/** Each Dexie class's database: its versions' stores merged in order. */
export function dexieDatabases(classes: { file: string; fact: DexieClassFact }[], stores: DexieStoresFact[], moduleOf: (path: string) => string): DatabaseMeta[] {
  const seen = new Set<string>()
  return classes.map(({ file, fact }) => {
    const latest = mergeVersions(stores.filter(s => s.db === fact.id))
    const id = seen.has(`db:dexie:${fact.name}`) ? `db:dexie:${fact.id}` : `db:dexie:${fact.name}`
    seen.add(id)
    return { id, name: fact.name, engine: 'indexeddb', sources: ['dexie'], module: moduleOf(file), tables: dexieTables(fact, latest) }
  })
}

/** Each table's last declaration across the versions, by version number; null: deleted. */
function mergeVersions(stores: DexieStoresFact[]): Map<string, { spec: string | null; line?: number }> {
  const out = new Map<string, { spec: string | null; line?: number }>()
  for (const s of [...stores].sort((a, b) => a.version - b.version))
    for (const [table, spec] of Object.entries(s.stores)) out.set(table, { spec, ...(s.lines[table] ? { line: s.lines[table] } : {}) })
  return out
}

function dexieTables(fact: DexieClassFact, latest: Map<string, { spec: string | null; line?: number }>): TableMeta[] {
  const members = new Map(fact.tables.map(t => [t.name, t]))
  const names = [...new Set([...members.keys(), ...latest.keys()])].filter(n => latest.get(n)?.spec !== null).sort()
  return names.map(name => {
    const member = members.get(name)
    const declared = latest.get(name)
    const { columns, indexes } = parseStores(declared?.spec ?? '', declared?.line)
    return { name, kind: 'table', ...(member?.entity ? { entity: member.entity } : {}), nodes: [member?.node ?? fact.id], columns, references: [], indexes }
  })
}

interface Entry {
  columns: string[]
  auto: boolean
  unique: boolean
  multi: boolean
}

/** A Dexie stores string: `++id, name, &email, *tags, [a+b]` → the key, the indexes, and a column for each property they name. */
export function parseStores(spec: string, line?: number): { columns: ColumnMeta[]; indexes: IndexMeta[] } {
  const [key, ...rest] = spec.split(',').map(s => s.trim())
  const at = line ? { line } : {}
  const pk = entryOf(key ?? '')
  const columns: ColumnMeta[] = pk.columns.map(name => ({ name, pk: true, ...(pk.auto ? { generated: true } : {}), ...at }))
  const indexes: IndexMeta[] = []
  for (const e of rest.filter(Boolean).map(entryOf)) {
    indexes.push({ columns: e.columns, ...(e.unique ? { unique: true } : {}), ...(e.multi ? { multiEntry: true } : {}) })
    for (const name of e.columns) if (!columns.some(c => c.name === name)) columns.push({ name, ...at })
  }
  return { columns, indexes }
}

function entryOf(text: string): Entry {
  const unique = text.startsWith('&')
  const multi = text.startsWith('*')
  const auto = text.startsWith('++')
  const path = text.replace(/^(\+\+|&|\*)/, '')
  const compound = /^\[(.*)\]$/.exec(path)
  const columns = compound ? compound[1].split('+').map(s => s.trim()).filter(Boolean) : path ? [path] : []
  return { columns, auto, unique, multi }
}
