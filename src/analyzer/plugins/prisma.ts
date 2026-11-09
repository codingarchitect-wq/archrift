// Prisma: the schema's models and enums become symbols of the
// schema file (fields as members, relations as edges), and calls such as
// `ctx.prisma.account.findMany()` become `queries` edges (read or write) from
// the calling code to the model. Calls are found by shape, through a receiver
// named `prisma` or `tx`, and only count when the schema has that model.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { memberId, symbolId } from '../../core/ids.ts'
import type { AssembleApi, Plugin } from './types.ts'
import { unwrap } from './syntax.ts'

const READ = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy'])
const WRITE = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany'])
const RECEIVER = /(^|\.)(prisma|tx|[a-zA-Z]*Prisma)$/

interface Call {
  owner: string
  client: string
  op: string
  site: [number, number]
}

export interface SchemaBlock {
  kind: 'model' | 'enum' | 'view'
  name: string
  start: number
  end: number
  /** type: the model or scalar; declared: as written, with `[]` or `?`; attributes: the rest of the line (`@id @default(cuid())`). */
  fields: { name: string; type: string; declared: string; attributes: string; line: number }[]
  /** The block's own attributes (`@@index([a, b])`, `@@map("x")`), as written. */
  attributes: string[]
}

/** Models, views and enums of a Prisma schema, with line numbers (1-based). */
export function parseSchema(text: string): SchemaBlock[] {
  const blocks: SchemaBlock[] = []
  let current: SchemaBlock | undefined
  text.split('\n').forEach((raw, i) => {
    const line = withoutComment(raw).trim()
    const open = /^(model|enum|view)\s+(\w+)\s*\{/.exec(line)
    if (open) {
      current = { kind: open[1] as SchemaBlock['kind'], name: open[2], start: i + 1, end: i + 1, fields: [], attributes: [] }
      blocks.push(current)
      return
    }
    if (!current) return
    if (line.startsWith('}')) {
      current.end = i + 1
      current = undefined
      return
    }
    const field = line.startsWith('@@') ? undefined : fieldOf(line, current.kind === 'enum', i + 1)
    if (line.startsWith('@@')) current.attributes.push(line)
    else if (field) current.fields.push(field)
  })
  return blocks
}

/** A field line: its name, type as declared, and attributes (an enum's values have neither). */
function fieldOf(line: string, isEnum: boolean, n: number): SchemaBlock['fields'][number] | undefined {
  const m = /^(\w+)\s+([\w.]+)(\[\]|\?)?(.*)$/.exec(line)
  if (!m) return undefined
  if (isEnum) return { name: m[1], type: '', declared: '', attributes: '', line: n }
  return { name: m[1], type: m[2], declared: m[2] + (m[3] ?? ''), attributes: m[4].trim(), line: n }
}

/** A line without its `//` comment; a `//` inside a string (`@default("http://…")`) stays. */
export function withoutComment(line: string): string {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') quoted = !quoted
    else if (!quoted && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

/** The datasource blocks: their names and providers (`db`, `postgresql`). */
export function parseDatasources(text: string): { name: string; provider: string; line: number }[] {
  const out: { name: string; provider: string; line: number }[] = []
  for (const m of text.matchAll(/^\s*datasource\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const provider = /\bprovider\s*=\s*"([^"]*)"/.exec(m[2])?.[1] ?? ''
    out.push({ name: m[1], provider, line: text.slice(0, m.index + m[0].indexOf('datasource')).split('\n').length })
  }
  return out
}

/** The project's Prisma schema, read and parsed once per assembly (the Prisma plugin and the schema assembly both use it). */
export function prismaSchema(api: AssembleApi): { path: string; text: string; blocks: SchemaBlock[] } | undefined {
  if (memo.has(api)) return memo.get(api)
  const p = findSchema(api.root)
  const text = p && api.readText(p)
  const found = p && text ? { path: p, text, blocks: parseSchema(text) } : undefined
  memo.set(api, found)
  return found
}
const memo = new WeakMap<AssembleApi, ReturnType<typeof prismaSchema>>()

function findSchema(root: string, configured?: string): string | undefined {
  for (const p of [configured, 'prisma/schema.prisma', 'schema.prisma']) if (p && fs.existsSync(path.join(root, p))) return p
  return undefined
}

export const prisma: Plugin = {
  name: 'prisma',
  version: 2,

  visit(node, api) {
    if (!ts.isCallExpression(node)) return
    const callee = unwrap(node.expression)
    if (!ts.isPropertyAccessExpression(callee)) return
    const op = callee.name.text
    if (!READ.has(op) && !WRITE.has(op)) return
    const delegate = unwrap(callee.expression)
    if (!ts.isPropertyAccessExpression(delegate)) return
    if (!RECEIVER.test(delegate.expression.getText(api.sf).replace(/\s+/g, ''))) return
    const fact: Call = { owner: api.ownerOf(node), client: delegate.name.text, op, site: api.site(delegate.name) }
    api.emit(fact)
  },

  assemble(api) {
    const schema = prismaSchema(api)
    if (!schema) return
    const { path: schemaPath, text, blocks } = schema
    const file = api.addFile(schemaPath, ['prisma-schema', 'prisma'], { loc: text.split('\n').filter(l => l.trim()).length })
    const models = new Set(blocks.filter(b => b.kind === 'model').map(b => b.name))
    for (const b of blocks) {
      const id = symbolId(schemaPath, b.name)
      // not TypeScript exports: never "dead"
      api.addNode({ id, kind: 'symbol', name: b.name, subkind: b.kind, parent: file, path: schemaPath, range: [b.start, 1, b.end, 2], metrics: { loc: b.end - b.start + 1 } })
      for (const f of b.fields) {
        const fid = memberId(schemaPath, b.name, f.name)
        const relation = models.has(f.type)
        api.addNode({ id: fid, kind: 'member', name: f.name, subkind: relation ? 'relation' : 'field', parent: id, path: schemaPath, range: [f.line, 1, f.line, 2], signature: `${f.name} ${f.declared}`.trim(), metrics: { loc: 1 } })
        if (relation) api.addEdge({ source: fid, target: symbolId(schemaPath, f.type), kind: 'type-ref', count: 1, targets: api.targets }, [f.line, 1])
        else if (blocks.some(e => e.kind === 'enum' && e.name === f.type))
          api.addEdge({ source: fid, target: symbolId(schemaPath, f.type), kind: 'type-ref', count: 1, targets: api.targets }, [f.line, 1])
      }
    }
    // the client's delegate for model FooBar is `fooBar`
    const byClient = new Map([...models].map(m => [m[0].toLowerCase() + m.slice(1), m]))
    for (const { fact } of api.facts<Call>('prisma')) {
      const model = byClient.get(fact.client)
      if (!model || !api.nodes.has(fact.owner)) continue
      api.addEdge(
        { source: fact.owner, target: symbolId(schemaPath, model), kind: 'queries', subkind: WRITE.has(fact.op) ? 'write' : 'read', count: 1, targets: api.targets, confidence: 'inferred' },
        fact.site,
      )
    }
  },
}
