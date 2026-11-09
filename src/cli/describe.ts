// `archrift describe`: the names and descriptions people (or their coding
// agents) write for the code, kept beside the config (core/descriptions.ts).
//
//   status                      how much is described, what went stale, what lost its code
//   todo [folder] [--max n]     the next things to describe, each with a digest to write from
//   set <path|id> [--name …] [--summary …]   one entry; without either, marks a stale one checked
//   apply <file.json | ->       many at once: { "<path or id>": { "name": "…", "summary": "…" } | "summary" }
//   sync                        entries follow renamed and moved code; the rest of the orphans go
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { absPathOf } from '../analyzer/mounts.ts'
import {
  PROJECT_KEY,
  coverageOf,
  describables,
  keyFor,
  parseDescriptions,
  resolveDescriptions,
  serializeDescriptions,
  stamp,
  syncDescriptions,
  todo,
} from '../core/descriptions.ts'
import type { Coverage, DescriptionsFile, TodoItem } from '../core/descriptions.ts'
import { GraphIndex } from '../core/graph-index.ts'
import type { Graph } from '../core/model.ts'

export const DESCRIBE_COMMANDS = ['status', 'todo', 'set', 'apply', 'sync'] as const
export type DescribeCommand = (typeof DESCRIBE_COMMANDS)[number]

/** Exit codes: done, a usage mistake, something named that the code doesn't have. */
export const DESCRIBE_EXIT = { ok: 0, usage: 2, missing: 4 } as const

export interface DescribeInput {
  command: DescribeCommand
  args: string[]
  graph: Graph
  /** The analyzed root, for reading files' content (fingerprints). */
  root: string
  /** The descriptions file (descriptionsPath). */
  file: string
  name?: string
  summary?: string
  max?: number
  format: 'text' | 'json'
  /** `apply -`: the JSON on standard input. */
  stdin?: () => string
}

/** What `content` stores for a file: enough of its text's hash to find it again after a move. */
export function contentFingerprint(text: string): string {
  return `sha1:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}`
}

export function readDescriptionsFile(file: string): { data: DescriptionsFile; problems: string[] } {
  if (!fs.existsSync(file)) return { data: { entries: {} }, problems: [] }
  const { file: data, problems } = parseDescriptions(JSON.parse(fs.readFileSync(file, 'utf8')))
  return { data, problems }
}

function writeDescriptionsFile(file: string, data: DescriptionsFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, serializeDescriptions(data))
}

export function runDescribe(input: DescribeInput): { text: string; code: number } {
  const index = new GraphIndex(input.graph)
  const { data, problems } = readDescriptionsFile(input.file)
  const shown = shortPath(input.file)
  const contentOf = (rel: string) => {
    try {
      return contentFingerprint(fs.readFileSync(absPathOf(input.root, input.graph.meta.mounts, rel), 'utf8'))
    } catch {
      return undefined
    }
  }
  const warn = problems.length ? `${problems.length} malformed entr${problems.length === 1 ? 'y' : 'ies'} left out: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ' …' : ''}\n` : ''
  switch (input.command) {
    case 'status': {
      const resolved = resolveDescriptions(input.graph, data, index)
      const coverage = coverageOf(describables(input.graph, index), resolved)
      const stale = Object.entries(resolved.entries).filter(([, d]) => d.stale).map(([k]) => k).sort()
      const symbols = Object.keys(resolved.entries).filter(k => k.startsWith('s:')).length
      if (input.format === 'json') return ok(json({ file: input.file, coverage, symbols, stale, orphans: resolved.orphans, problems }))
      return ok(warn + statusText(input.graph.meta.name, shown, coverage, symbols, stale, resolved.orphans))
    }
    case 'todo': {
      const resolved = resolveDescriptions(input.graph, data, index)
      const t = todo(input.graph, resolved, { scope: input.args[0], max: input.max ?? 40 }, index)
      if (input.format === 'json') return ok(json(t))
      return ok(warn + todoText(t.items, t.total, input.args[0]))
    }
    case 'set': {
      const [arg] = input.args
      if (!arg) return usage('archrift describe set <path|id> --name "…" --summary "…"')
      const key = keyFor(input.graph, index, arg)
      if (!key) return { text: `nothing named ${arg} in ${input.graph.meta.name} (a file, a folder, a node id, feature:<name> or project)\n`, code: DESCRIBE_EXIT.missing }
      if (key === PROJECT_KEY) {
        if (!input.summary) return usage('the project takes --summary')
        writeDescriptionsFile(input.file, { ...data, project: input.summary.trim() })
        return ok(`${shown}: the project's description written\n`)
      }
      const had = data.entries[key]
      const summary = input.summary?.trim() || had?.summary
      if (!summary) return usage(`${arg} has no description yet: give it --summary (and --name if its own name doesn't say it)`)
      const name = input.name === undefined ? had?.name : input.name.trim() || undefined
      const file = index.node(key)?.kind === 'file' ? contentOf(index.node(key)!.path!) : undefined
      writeDescriptionsFile(input.file, { ...data, entries: { ...data.entries, [key]: stamp(index, key, { name, summary }, file) } })
      const what = !had ? 'written' : input.summary === undefined && input.name === undefined ? 'checked: it fits the code as it is now' : 'rewritten'
      return ok(`${shown}: ${key} ${what}\n`)
    }
    case 'apply': {
      const [source] = input.args
      if (!source) return usage('archrift describe apply <file.json | ->')
      let raw: unknown
      try {
        raw = JSON.parse(source === '-' ? (input.stdin?.() ?? '') : fs.readFileSync(path.resolve(source), 'utf8'))
      } catch (err) {
        return usage(`can't read ${source} as JSON: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return usage('apply takes an object: { "<path or id>": { "name": "…", "summary": "…" } }')
      const entries = { ...data.entries }
      let project = data.project
      const unknown: string[] = []
      const empty: string[] = []
      let added = 0
      let changed = 0
      for (const [arg, value] of Object.entries(raw as Record<string, unknown>)) {
        const v = typeof value === 'string' ? { summary: value } : (value as { name?: unknown; summary?: unknown } | null)
        const summary = typeof v?.summary === 'string' ? v.summary.trim() : ''
        const name = typeof v?.name === 'string' && v.name.trim() ? v.name.trim() : undefined
        const key = keyFor(input.graph, index, arg)
        if (!key) {
          unknown.push(arg)
          continue
        }
        if (!summary) {
          empty.push(arg)
          continue
        }
        if (key === PROJECT_KEY) {
          project = summary
          continue
        }
        if (entries[key]) changed++
        else added++
        const file = index.node(key)?.kind === 'file' ? contentOf(index.node(key)!.path!) : undefined
        entries[key] = stamp(index, key, { name, summary }, file)
      }
      writeDescriptionsFile(input.file, { ...data, ...(project ? { project } : {}), entries })
      const lines = [`${shown}: ${added} written, ${changed} rewritten`]
      if (empty.length) lines.push(`no summary, left out: ${empty.join(', ')}`)
      if (unknown.length) lines.push(`nothing by these names in ${input.graph.meta.name}, left out: ${unknown.join(', ')}`)
      return { text: `${lines.join('\n')}\n`, code: unknown.length ? DESCRIBE_EXIT.missing : DESCRIBE_EXIT.ok }
    }
    case 'sync': {
      const r = syncDescriptions(input.graph, data, contentOf, index)
      if (r.moved.length || r.dropped.length || r.stamped.length) writeDescriptionsFile(input.file, r.file)
      if (input.format === 'json') return ok(json({ moved: r.moved, dropped: r.dropped, stamped: r.stamped }))
      const lines = [`${shown}: ${r.moved.length} carried over, ${r.dropped.length} dropped, ${r.stamped.length} stamped`]
      for (const [a, b] of r.moved) lines.push(`  → ${a.slice(2)}  is now  ${b.slice(2)}`)
      for (const k of r.dropped) lines.push(`  ✕ ${k}  (its code is gone; git keeps the entry)`)
      if (r.stamped.length) lines.push(`  stamped ${r.stamped.length} entr${r.stamped.length === 1 ? 'y' : 'ies'} written by hand: they describe the code as it is now`)
      return ok(`${lines.join('\n')}\n`)
    }
  }
}

const LEVEL_NAMES: Record<Coverage['level'], string> = { project: 'project', block: 'blocks', feature: 'features', folder: 'folders', file: 'files' }

function statusText(project: string, file: string, coverage: Coverage[], symbols: number, stale: string[], orphans: string[]): string {
  const lines = [`archrift describe ${project}: ${file}`]
  for (const c of coverage) {
    const what = c.level === 'project' ? (c.described ? 'described' : 'not described') : `${c.described.toLocaleString('en-US')} of ${c.total.toLocaleString('en-US')} described`
    lines.push(`  ${LEVEL_NAMES[c.level].padEnd(9)} ${what}${c.stale ? ` (${c.stale} stale)` : ''}`)
  }
  if (symbols) lines.push(`  ${'functions'.padEnd(9)} ${symbols} described`)
  if (stale.length) {
    lines.push('', `Stale: their code's exports or signature changed since (${stale.length}). Check each; \`archrift describe set <path>\` marks one that still fits:`)
    for (const k of stale.slice(0, 20)) lines.push(`  ${k.replace(/^[fd]:/, '')}`)
    if (stale.length > 20) lines.push(`  … ${stale.length - 20} more (archrift describe todo lists them first)`)
  }
  if (orphans.length) {
    lines.push('', `Orphans: their code moved or is gone (${orphans.length}). \`archrift describe sync\` carries them over or drops them:`)
    for (const k of orphans.slice(0, 10)) lines.push(`  ${k}`)
    if (orphans.length > 10) lines.push(`  … ${orphans.length - 10} more`)
  }
  const open = coverage.reduce((n, c) => n + c.total - c.described + c.stale, 0)
  lines.push('', open ? `Next: archrift describe todo  (the next ${Math.min(open, 40)} of ${open.toLocaleString('en-US')} to describe, each with a digest)` : 'Everything archrift lists is described.')
  return `${lines.join('\n')}\n`
}

function todoText(items: TodoItem[], total: number, scope: string | undefined): string {
  if (!items.length) return `Nothing to describe${scope ? ` under ${scope}` : ''}: every block, feature, folder and file there has words that fit.\n`
  const lines = [`${items.length} of ${total.toLocaleString('en-US')} to describe${scope ? ` under ${scope}` : ''}, most worth it first:`]
  const said = (x: { described?: string }) => (x.described ? ` — ${clip(x.described, 90)}` : '')
  for (const i of items) {
    const d = i.digest
    const size = [d.files !== undefined && `${d.files.toLocaleString('en-US')} files`, d.lines !== undefined && `${d.lines.toLocaleString('en-US')} lines`, d.usedByCount && `used by ${d.usedByCount} files`].filter(Boolean).join(' · ')
    lines.push('', `## ${i.level} ${i.key === PROJECT_KEY ? i.label : i.key}  (${i.why})${size ? `  ${size}` : ''}`)
    if (i.current) lines.push(`   now: ${i.current.name ? `${i.current.name}: ` : ''}${i.current.summary}`)
    if (d.routes?.length) lines.push(`   routes: ${d.routes.join(', ')}`)
    if (d.exports?.length) lines.push(`   exports: ${d.exports.slice(0, 10).map(e => `${e.name} (${e.kind})${e.signature ? `: ${clip(e.signature, 80)}` : ''}`).join('; ')}${d.exports.length > 10 ? ` … +${d.exports.length - 10}` : ''}`)
    if (d.contents?.length) lines.push(`   holds: ${d.contents.map(c => `${c.path} (${c.lines})${said(c)}`).join('; ')}`)
    if (d.uses?.length) lines.push(`   uses: ${d.uses.map(u => `${u.path}${said(u)}`).join('; ')}${d.usesCount! > d.uses.length ? ` … +${d.usesCount! - d.uses.length}` : ''}`)
    if (d.usedBy?.length) lines.push(`   used by: ${d.usedBy.map(u => `${u.path}${said(u)}`).join('; ')}${d.usedByCount! > d.usedBy.length ? ` … +${d.usedByCount! - d.usedBy.length}` : ''}`)
  }
  lines.push(
    '',
    'Write them (a name only when the code\'s own doesn\'t say it; one or two sentences on what it is for, in the project\'s words):',
    '  archrift describe apply <file.json>   { "src/lib/db.ts": { "name": "…", "summary": "…" }, "feature:accounts": "…", "project": "…" }',
    '  archrift describe set <path|id> --name "…" --summary "…"',
  )
  return `${lines.join('\n')}\n`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
const ok = (text: string) => ({ text, code: DESCRIBE_EXIT.ok })
const usage = (message: string) => ({ text: `${message}\n`, code: DESCRIBE_EXIT.usage })
const shortPath = (file: string) => (path.relative(process.cwd(), file).startsWith('..') ? file : path.relative(process.cwd(), file) || file)
