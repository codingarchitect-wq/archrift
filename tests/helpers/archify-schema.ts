// archify's JSON schemas (copied into tests/fixtures/archify-schemas) as zod
// validators, plus the rules zod can't read from them: zod takes neither
// `if/then` nor `not`, so those are dropped here and checked by hand in
// `archifyProblems` (an fk names its target; ids are unique; nothing shares a
// grid cell; relationships join declared things).
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const DIR = path.join(import.meta.dirname, '..', 'fixtures', 'archify-schemas')
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as Record<string, unknown>

/** $refs inlined (across files), and the keywords zod refuses removed. */
function prepare(node: unknown, base: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map(n => prepare(n, base))
  if (!node || typeof node !== 'object') return node
  const obj = node as Record<string, unknown>
  if (typeof obj.$ref === 'string') {
    const [file, pointer] = obj.$ref.split('#')
    const doc = file ? read(file) : base
    const target = pointer.split('/').slice(1).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], doc)
    return prepare(target, doc)
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (['$defs', '$id', '$schema', 'if', 'then', 'else', 'not', 'description'].includes(k)) continue
    if (k === 'allOf') {
      const kept = (v as unknown[]).map(x => prepare(x, base)).filter(x => x && typeof x === 'object' && Object.keys(x).length)
      if (kept.length) out.allOf = kept
      continue
    }
    out[k] = prepare(v, base)
  }
  return out
}

export function archifySchema(kind: 'architecture' | 'erd' | 'class'): z.ZodType {
  const raw = read(`${kind}.schema.json`)
  return z.fromJSONSchema(prepare(raw, raw) as Parameters<typeof z.fromJSONSchema>[0])
}

interface Doc {
  diagram_type: string
  components?: { id: string; row: number; col: number }[]
  connections?: { from: string; to: string }[]
  entities?: { id: string; row: number; col: number; attributes: { name: string; key?: string | string[]; references?: string }[] }[]
  types?: { id: string; kind: string; row: number; col: number }[]
  relationships?: { from: string; to: string; kind?: string }[]
}

/** What archify would refuse that the schema can't say, as sentences (none: fine). */
export function archifyProblems(doc: Doc): string[] {
  const problems: string[] = []
  const things = doc.components ?? doc.entities ?? doc.types ?? []
  const ids = new Set(things.map(t => t.id))
  if (ids.size !== things.length) problems.push('ids repeat')
  const cells = things.map(t => `${t.row}/${t.col}`)
  if (new Set(cells).size !== cells.length) problems.push('two things share a grid cell')
  for (const r of [...(doc.connections ?? []), ...(doc.relationships ?? [])]) {
    if (!ids.has(r.from) || !ids.has(r.to)) problems.push(`${r.from} → ${r.to} joins something undeclared`)
    if (r.from === r.to) problems.push(`${r.from} relates to itself`)
  }
  for (const e of doc.entities ?? [])
    for (const a of e.attributes) {
      const keys = [a.key ?? []].flat()
      if (keys.includes('fk') && !a.references) problems.push(`${e.id}.${a.name} is an fk without references`)
      if (!a.references) continue
      const [entity, attribute] = a.references.split('.')
      const target = doc.entities!.find(x => x.id === entity)
      if (!target?.attributes.some(x => x.name === attribute)) problems.push(`${e.id}.${a.name} references ${a.references}, which isn't declared`)
    }
  for (const r of doc.relationships ?? []) {
    const kind = (id: string) => doc.types?.find(t => t.id === id)?.kind
    if (r.kind === 'realization' && kind(r.to) !== 'interface') problems.push(`${r.from} realizes ${r.to}, which isn't an interface`)
    if (r.kind === 'inheritance' && (kind(r.from) === 'interface') !== (kind(r.to) === 'interface')) problems.push(`${r.from} inherits across the interface boundary`)
  }
  return problems
}
