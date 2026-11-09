// `archrift query` (docs/QUERY.md): questions about the code before changing
// it, answered from a fresh analysis (cached, so a few seconds), as text an
// agent or a person reads, or JSON.
//
//   ways <path> [--job <words>]   how the place does each job, and the way to follow
//   rules <path> [--to <path>]    what it may depend on, who may depend on it; with --to, would that break a rule
//   path <from> <to>              how one place depends on another, hop by hop
//   file <path>                   one file at a glance
//   crap <path> [--max n]         its riskiest functions: CRAP with the last coverage run
//   impact <path> [--depth n] [--max n]  what depends on it, directly or not, and the tests to run after changing it
//   overview                      the project: what was written about it, its blocks, features, layers and rules
//   find <words…> [--max n]       files, folders, functions and routes by name, path or description
//   docs <path | id | document>   the documents naming code and the decision ids it cites; an id's definitions; a document's code
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../analyzer/config.ts'
import { pathTags } from '../analyzer/config.ts'
import type { CoverageSource, FileCoverage, FunctionRisk } from '../core/crap.ts'
import type { Graph } from '../core/model.ts'
import { Query } from '../core/query.ts'
import type { DependAnswer, DocsAnswer, FileAnswer, JobAnswer, PathsAnswer, Place, RisksAnswer, RulesAnswer, WaysAnswer } from '../core/query.ts'
import type { ImpactAnswer, ImpactHit, ImpactStart } from '../core/query.ts'
import { nodeLabel } from '../core/docs.ts'
import type { CitedId, DocRef, IdDefinition } from '../core/docs.ts'
import type { Violation } from '../core/rules.ts'
import type { ResolvedDescriptions } from '../core/descriptions.ts'
import { blockFinder, coherenceOf } from './coherence.ts'
import { shapeOf } from '../core/first-look.ts'
import { search } from '../server/views.ts'
import { projectDir } from '../analyzer/config.ts'
import { DEFAULT_PROJECTS, ProjectList } from './projects.ts'

export const QUESTIONS = ['ways', 'rules', 'path', 'file', 'crap', 'impact', 'overview', 'find', 'docs'] as const
export type Question = (typeof QUESTIONS)[number]

/** Exit codes: an answer, a usage mistake, a name several files have, nothing by that name. */
export const EXIT = { ok: 0, usage: 2, ambiguous: 3, missing: 4 } as const

/**
 * Which project a command is about: the root given (with --config, --out), a
 * project of the list by name, or the listed project whose root holds the
 * current folder (the innermost), else the current folder.
 */
export function locate(options: { root?: string; project?: string; config?: string; out?: string; cwd?: string; projects?: string }): {
  root: string
  config?: string
  out?: string
  /** A listed project's saved views. */
  views?: string
} {
  const cwd = options.cwd ?? process.cwd()
  if (options.root) return { root: path.resolve(cwd, options.root), config: options.config, out: options.out }
  const list = new ProjectList(options.projects ? path.resolve(options.projects) : DEFAULT_PROJECTS)
  const found = options.project ? list.get(options.project) : list.all().filter(p => cwd === p.root || cwd.startsWith(`${p.root}${path.sep}`)).sort((a, b) => b.root.length - a.root.length)[0]
  if (options.project && !found) throw new Error(`no project named ${options.project} in ${list.file}`)
  return found
    ? { root: found.root, config: options.config ?? found.config, out: options.out ?? found.out, views: found.views }
    : { root: ownConfigRoot(cwd) ?? cwd, config: options.config, out: options.out }
}

/** The nearest folder from `dir` up that holds its own `.archrift/config.json` (a worktree of a project set up by init, say). */
function ownConfigRoot(dir: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(projectDir(d), 'config.json'))) return d
    if (path.dirname(d) === d) return undefined
  }
}

/** A path given on the command line, relative to the root: as typed from the current folder when that's inside the root and names something there. */
export function rootRelative(arg: string, root: string, cwd: string, exists: (rel: string) => boolean): string {
  if (/^[fsx]:/.test(arg)) return arg
  const fromCwd = path.relative(root, path.resolve(cwd, arg)).split(path.sep).join('/')
  if (!fromCwd.startsWith('..') && cwd !== root && exists(fromCwd)) return fromCwd
  return arg.replace(/^\.\//, '')
}

export function queryFor(graph: Graph, config: Config, coverage?: CoverageSource, descriptions?: ResolvedDescriptions): Query {
  const tagsFor = pathTags(config)
  const blockOf = blockFinder(graph, p => tagsFor(p).find(t => t.startsWith('group:'))?.slice(6))
  return new Query({ graph, coherence: coherenceOf(graph, blockOf), blockOf, tagsFor, rules: config.rules, ...(coverage ? { coverage } : {}), ...(descriptions ? { descriptions } : {}) })
}

/**
 * The last coverage run (the config's `coverage`, an Istanbul coverage-final.json), when there is
 * one: a file changed after it is `stale` (its lines may have moved, so its numbers would land on
 * the wrong functions).
 */
export function readCoverage(root: string, file: string): CoverageSource | undefined {
  const abs = path.resolve(root, file)
  let raw: Record<string, FileCoverage>
  let written: number
  try {
    written = fs.statSync(abs).mtimeMs
    raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, FileCoverage>
  } catch {
    return undefined
  }
  const byPath = new Map(Object.entries(raw).map(([p, c]) => [path.relative(root, path.resolve(root, p)).split(path.sep).join('/'), c]))
  const changed = new Map<string, boolean>()
  return {
    file,
    at: new Date(written).toISOString(),
    of: rel => {
      if (!changed.has(rel)) {
        let mtime = 0
        try {
          mtime = fs.statSync(path.join(root, rel)).mtimeMs
        } catch {
          // gone: nothing to measure
        }
        changed.set(rel, mtime > written)
      }
      return changed.get(rel) ? 'stale' : byPath.get(rel)
    },
  }
}

export interface QueryArgs {
  question: Question
  /** Root-relative paths (or ids). */
  paths: string[]
  job?: string
  to?: string
  max?: number
  /** query impact: the most steps to walk. */
  depth?: number
  format: 'text' | 'json'
}

/** Answers one question: the text (or JSON) to print and the exit code. */
export function answer(q: Query, args: QueryArgs): { text: string; code: number } {
  const json = (x: unknown) => ({ text: `${JSON.stringify(x, null, 2)}\n`, code: EXIT.ok })
  if (args.question === 'overview') {
    const a = overviewOf(q)
    return args.format === 'json' ? json(a) : { text: overviewText(a), code: EXIT.ok }
  }
  if (args.question === 'find') {
    if (!args.paths.join('').trim()) return { text: 'archrift query find: some words needed\n', code: EXIT.usage }
    const a = findIn(q, args.paths.join(' '), args.max ?? 20)
    return args.format === 'json' ? json(a) : { text: findText(a), code: a.hits.length ? EXIT.ok : EXIT.missing }
  }
  if (args.question === 'docs') {
    if (!args.paths.length) return { text: 'archrift query docs: a path, a decision id or a document needed\n', code: EXIT.usage }
    const a = q.docsQuestion(args.paths[0])
    const code = a.kind === 'none' ? (a.place.kind === 'ambiguous' ? EXIT.ambiguous : EXIT.missing) : EXIT.ok
    return args.format === 'json' ? { ...json(a.kind === 'id' ? { ...a, current: [...a.current] } : a), code } : { text: docsText(a, args.max ?? 12), code }
  }
  if (args.question === 'impact') return impactReply(q, args)
  const want = args.question === 'path' ? 2 : 1
  if (args.paths.length < want) return { text: `archrift query ${args.question}: ${want === 2 ? 'two paths' : 'a path'} needed\n`, code: EXIT.usage }
  const places = args.paths.slice(0, want).map(p => q.place(p))
  if (args.to !== undefined) places.push(q.place(args.to))
  for (const p of places) {
    if (p.kind === 'ambiguous') return { text: `${p.path}: several files have that name, which one?\n${p.candidates.map(c => `  ${c}`).join('\n')}\n`, code: EXIT.ambiguous }
    if (p.kind === 'missing' && !(args.to !== undefined && p === places.at(-1))) return { text: `${p.path}: no file, folder or id by that name\n`, code: EXIT.missing }
  }
  const [place] = places
  switch (args.question) {
    case 'ways': {
      const a = q.ways(place, args.job)
      return args.format === 'json' ? json(a) : { text: waysText(a, args.job), code: EXIT.ok }
    }
    case 'rules': {
      if (args.to !== undefined) {
        if (place.kind === 'external') return { text: 'archrift query rules --to: the dependent must be a file or a folder\n', code: EXIT.usage }
        const a = q.mayDepend(place, places[1])
        return args.format === 'json' ? json(a) : { text: dependText(a), code: EXIT.ok }
      }
      const a = q.rules(place)
      return args.format === 'json' ? json(a) : { text: rulesText(a), code: EXIT.ok }
    }
    case 'path': {
      const a = q.paths(place, places[1], args.max ?? 5)
      return args.format === 'json' ? json(a) : { text: pathsText(a), code: EXIT.ok }
    }
    case 'file': {
      if (place.kind !== 'file') return { text: `${place.path}: ${place.kind === 'folder' ? 'a folder, not a file (try: ways, rules or crap)' : 'no such file yet (try: ways or rules, which answer for new files)'}\n`, code: place.kind === 'folder' ? EXIT.usage : EXIT.missing }
      const a = q.file(place)
      return args.format === 'json' ? json(a) : { text: fileText(a), code: EXIT.ok }
    }
    case 'crap': {
      if (place.kind !== 'file' && place.kind !== 'folder') return { text: `${place.path}: crap answers for a file or a folder\n`, code: place.kind === 'new' ? EXIT.missing : EXIT.usage }
      const a = q.risks(place)
      return args.format === 'json' ? json({ ...a, functions: a.functions.slice(0, args.max ?? 20) }) : { text: risksText(a, args.max ?? 20), code: EXIT.ok }
    }
  }
}

// ── overview and find: where an agent starts ──────────────────────────────

export interface OverviewAnswer {
  project: string
  described?: string
  files: number
  production: number
  lines: number
  layers: string[]
  blocks: { path: string; files: number; lines: number; ui: boolean; described?: string }[]
  features: { name: string; routes: string[]; files: number; described?: string }[]
  entrypoints: { pages: number; apiRoutes: number }
  rules: { total: number; broken: number; errors: number }
  /** The documents read (config `docs`): how many, kept current, naming code; decision ids the code cites. */
  docs?: { documents: number; current: number; naming: number; ids: number }
}

const saidOf = (q: Query, key: string) => {
  const d = q.input.descriptions?.entries[key]
  return d ? (d.name ? `${d.name}: ${d.summary}` : d.summary) : undefined
}

/** The project at a glance: what was written about it, its blocks (as `init` finds them), features, layers and rules. */
export function overviewOf(q: Query): OverviewAnswer {
  const g = q.input.graph
  const files = g.nodes.filter(n => n.kind === 'file')
  const production = files.filter(f => !f.tags?.includes('test'))
  const violations = g.meta.violations ?? []
  const has = (prefix: string) => files.filter(f => f.tags?.some(t => t.startsWith(prefix))).length
  return {
    project: g.meta.name,
    ...(q.input.descriptions?.project ? { described: q.input.descriptions.project } : {}),
    files: files.length,
    production: production.length,
    lines: production.reduce((n, f) => n + (f.metrics?.loc ?? 0), 0),
    layers: g.meta.layers ?? [],
    blocks: shapeOf(g).blocks.map(b => ({ path: b.path, files: b.files, lines: b.loc, ui: b.ui, ...(saidOf(q, `d:${b.path}`) ? { described: saidOf(q, `d:${b.path}`) } : {}) })),
    features: (g.meta.features ?? []).map(f => ({ name: f.name, routes: f.routes, files: f.files, ...(saidOf(q, `feature:${f.name}`) ? { described: saidOf(q, `feature:${f.name}`) } : {}) })),
    entrypoints: { pages: has('route:'), apiRoutes: has('api:') + has('http:') },
    rules: { total: g.meta.rules?.length ?? 0, broken: new Set(violations.map(v => v.rule)).size, errors: violations.filter(v => v.severity === 'error').length },
    ...(g.meta.docs ? { docs: docsCounts(g.meta.docs) } : {}),
  }
}

function docsCounts(d: NonNullable<Graph['meta']['docs']>) {
  return { documents: d.docs.length, current: d.docs.filter(x => x.current).length, naming: d.docs.filter(x => x.mentions.length).length, ids: d.ids.length }
}

function overviewText(a: OverviewAnswer): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const lines = [`${a.project}: ${a.described ?? 'not described yet (archrift describe)'}`, `  ${n(a.files)} files, ${n(a.production)} of them production code (${n(a.lines)} lines)${a.layers.length ? `; layers, top to bottom: ${a.layers.join(' > ')}` : ''}`]
  lines.push(`  entry points: ${a.entrypoints.pages} pages, ${a.entrypoints.apiRoutes} API routes; rules: ${a.rules.total}${a.rules.broken ? ` (${a.rules.broken} broken, ${a.rules.errors} errors)` : ', all kept'}`)
  if (a.docs) lines.push(`  documents: ${n(a.docs.documents)} (${n(a.docs.current)} kept current), ${n(a.docs.naming)} of them naming code; the code cites ${count(a.docs.ids, 'decision id')} (query docs <path | id>)`)
  if (a.blocks.length) lines.push('', 'Blocks (the folders its production code splits into):', ...a.blocks.map(b => `  ${b.path}  ${n(b.files)} files, ${n(b.lines)} lines${b.ui ? ', UI' : ''}${b.described ? `  “${b.described}”` : ''}`))
  if (a.features.length) lines.push('', 'Features (found from its pages and API routes):', ...a.features.map(f => `  ${f.name}  ${f.files} files · ${f.routes.slice(0, 4).join(', ')}${f.routes.length > 4 ? ' …' : ''}${f.described ? `  “${f.described}”` : ''}`))
  lines.push('', 'Next: query find "<words>", query file <path>, query path <a> <b>, query docs <path | id>')
  return `${lines.join('\n')}\n`
}

export interface FindAnswer {
  words: string
  hits: { id: string; kind: string; subkind?: string; path?: string; name: string; described?: string }[]
}

/**
 * Files, folders, functions and routes by name, path, route or what was written about them, best
 * first: the whole phrase, and each word on its own, things matching more of the words first.
 */
export function findIn(q: Query, words: string, max: number): FindAnswer {
  const parts = [...new Set([words.trim(), ...words.trim().split(/\s+/).filter(w => w.length > 1)])]
  const tally = new Map<string, { hit: ReturnType<typeof search>[number]; score: number; matched: number }>()
  for (const part of parts)
    for (const h of search(q.index, part, max * 3, q.input.descriptions)) {
      const t = tally.get(h.id) ?? { hit: h, score: 0, matched: 0 }
      t.score += h.score
      t.matched += part === words.trim() && parts.length > 1 ? 2 : 1
      tally.set(h.id, t)
    }
  const ranked = [...tally.values()].sort((a, b) => b.matched - a.matched || b.score - a.score || (a.hit.id < b.hit.id ? -1 : 1)).slice(0, max)
  const hits = ranked.map(({ hit: h }) => {
    const said = saidOf(q, h.id)
    return { id: h.id, kind: h.kind, ...(h.subkind ? { subkind: h.subkind } : {}), ...(h.path ? { path: h.path } : {}), name: h.name, ...(said ? { described: said } : {}) }
  })
  return { words, hits }
}

function findText(a: FindAnswer): string {
  if (!a.hits.length) return `nothing matches "${a.words}" by name, path, route or description\n`
  const at = (h: FindAnswer['hits'][number]) => (h.kind === 'file' || h.kind === 'directory' ? h.path ?? h.name : h.id.startsWith('s:') ? `${h.path} › ${h.id.slice(h.id.indexOf('#') + 1)}` : h.id)
  return `${a.hits.map(h => `${at(h)}  (${h.subkind ?? h.kind})${h.described ? `  “${h.described.length > 100 ? `${h.described.slice(0, 99)}…` : h.described}”` : ''}`).join('\n')}\n`
}

// ── text ──────────────────────────────────────────────────────────────────

function placeLine(p: Place, blocks: string[]): string {
  const where = blocks.length === 1 ? `block ${blocks[0]}` : blocks.length ? `blocks ${blocks.join(', ')}` : 'no block'
  switch (p.kind) {
    case 'file':
      return `${p.path} (${where})`
    case 'folder':
      return `${p.path || '(root)'}/ (a folder: ${p.files.length} files, ${where})`
    case 'new':
      return `${p.path} (no file yet; it would be in ${where})`
    default:
      return p.path
  }
}

export function waysText(a: WaysAnswer, job?: string): string {
  const lines = [placeLine(a.place, a.blocks)]
  if (!a.jobs.length) lines.push('', job ? `No job of the catalog matches "${job}". The jobs: ${a.elsewhere.map(e => e.label).join(', ') || '(none found in this project)'}` : 'It does none of the jobs of the catalog.')
  for (const j of a.jobs) lines.push('', ...jobLines(j))
  if (a.elsewhere.length) lines.push('', `Done elsewhere in the project (its way): ${a.elsewhere.map(e => `${e.stack} · ${e.label}: ${e.use}`).join(' · ')}`)
  return `${lines.join('\n')}\n`
}

function jobLines(j: JobAnswer): string[] {
  const head = `${j.stack} · ${j.label} (${j.about})${j.kind === 'mixed' ? ': done several ways' : j.kind === 'per-block' ? ': one way per block' : ''}`
  const out = [head]
  if (j.accepted) out.push(`  several ways on purpose: ${j.accepted}`)
  for (const b of j.blocks) {
    const counts = b.ways.map(w => `${w.label}${w.legacy ? ' (legacy)' : ''} ${w.files}`).join(' · ')
    const as = b.examples.length ? `, as ${b.examples.join(', ')} do${b.examples.length === 1 ? 'es' : ''}` : ''
    const why = b.main && b.main.id !== b.use.id ? ` (${b.main.label} is legacy${j.migration ? `; the project moves to ${j.migration.to}, ${Math.round(j.migration.done * 100)} % done` : ''})` : !b.files ? ` (${b.block} doesn't do it yet: the project's way)` : ''
    out.push(`  ${b.block}: ${counts || 'not done here'} → use ${b.use.label}${why}${as}`)
  }
  for (const h of j.here) if (h.differs) out.push(`  differs from its block: ${h.path} uses ${h.ways.join(' and ')}`)
  const own = j.here.filter(h => !h.differs)
  if (own.length && own.length <= 5) out.push(`  here: ${own.map(h => `${h.path} (${h.ways.join(', ')})`).join(' · ')}`)
  else if (own.length) out.push(`  here: ${own.length} files do it their block's way`)
  if (j.project.length > 1) out.push(`  whole project: ${j.project.map(w => `${w.label}${w.legacy ? ' (legacy)' : ''} ${w.files}`).join(' · ')}`)
  return out
}

export function rulesText(a: RulesAnswer): string {
  const lines = [`${placeName(a.place)}${a.layer ? ` (layer ${a.layer})` : ''}`]
  if (!a.own.length && !a.guarded.length) lines.push('', 'No rule is about it.')
  if (a.own.length) lines.push('', 'It:', ...a.own.map(c => `  ${c.says}  [${c.rule}, ${c.severity}]${c.description ? `  ${c.description}` : ''}`))
  if (a.guarded.length) lines.push('', 'Who may depend on it:', ...a.guarded.map(c => `  ${c.says}  [${c.rule}, ${c.severity}]`))
  lines.push('', a.violations.length ? `Broken now (${a.violations.length}):` : 'Broken now: nothing.')
  lines.push(...a.violations.slice(0, 20).map(v => `  ${violationLine(v)}`))
  if (a.violations.length > 20) lines.push(`  … ${a.violations.length - 20} more (archrift check lists them all)`)
  return `${lines.join('\n')}\n`
}

export function dependText(a: DependAnswer): string {
  const verdict = a.allowed ? (a.breaks.length ? 'allowed, with warnings' : 'allowed: no rule breaks') : 'not allowed'
  const lines = [`${path_(a.from)} → ${path_(a.to)}: ${verdict}${a.exists ? ' (it depends on it already)' : ''}`]
  lines.push(...a.breaks.slice(0, 6).map(v => `  ${v.severity === 'error' ? '✗' : '!'} ${v.rule} (${v.severity}): ${v.message}`))
  if (a.breaks.length > 6) lines.push(`  … ${a.breaks.length - 6} more`)
  return `${lines.join('\n')}\n`
}

export function pathsText(a: PathsAnswer): string {
  const [x, y] = [placeName(a.from), placeName(a.to)]
  if (!a.paths.length) return `No dependency path between ${x} and ${y}, either way.\n`
  const steps = a.paths[0].length
  const lines = [a.reversed ? `${x} doesn't depend on ${y}, but ${y} depends on ${x}:` : `${x} depends on ${y}:`]
  lines.push(`${a.paths.length} shortest path${a.paths.length === 1 ? '' : 's'}, ${steps} step${steps === 1 ? '' : 's'}`)
  for (const p of a.paths) lines.push('', `  ${p[0].from}`, ...p.map(h => `    → ${h.to}  (${h.kinds.join(', ')})`))
  return `${lines.join('\n')}\n`
}

export function fileText(a: FileAnswer): string {
  const m = a.metrics
  const facts = [
    m.loc !== undefined && `${m.loc} lines`,
    m.complexity !== undefined && `complexity ${m.complexity}`,
    m.commits !== undefined && `${m.commits} commits`,
    a.hotspot && `hotspot #${a.hotspot.rank} of ${a.hotspot.of}`,
    m.testReach !== undefined && (m.testReach ? `reached by ${m.testReach} test file${m.testReach === 1 ? '' : 's'}` : 'no test reaches it'),
  ].filter(Boolean)
  const tags = a.tags.filter(t => !t.startsWith('layer:') && !t.startsWith('group:'))
  const lines = [`${a.place.path} (${[a.block && `block ${a.block}`, a.rules.layer && `layer ${a.rules.layer}`].filter(Boolean).join(', ') || 'no block'})`, `  ${facts.join(' · ')}`]
  if (a.described) lines.push(`  described: ${a.described.name ? `${a.described.name}: ` : ''}${a.described.summary}${a.described.stale ? '  (stale: written before its exports changed)' : ''}`)
  if (a.blockDescribed) lines.push(`  its block: ${a.blockDescribed.name ? `${a.blockDescribed.name}: ` : ''}${a.blockDescribed.summary}`)
  if (tags.length) lines.push(`  tags: ${tags.join(', ')}`)
  // production code by name, tests counted
  const deps = (title: string, list: FileAnswer['usedBy']) => {
    const code = list.filter(d => !d.test)
    const tests = list.length - code.length
    return [
      '',
      `${title} (${code.length}${tests ? ` + ${tests} test file${tests === 1 ? '' : 's'}` : ''}):`,
      ...code.slice(0, 15).map(d => `  ${d.path}  (${d.kinds.join(', ')})${d.described ? `  “${d.described}”` : ''}`),
      ...(code.length > 15 ? [`  … ${code.length - 15} more`] : []),
    ]
  }
  lines.push(...deps('Uses', a.dependsOn), ...deps('Used by', a.usedBy))
  if (a.jobs.length) lines.push('', 'Jobs:', ...a.jobs.map(j => `  ${j.stack} · ${j.label}: ${j.ways.join(', ')}${j.differs ? `  (differs: its block uses ${j.use})` : ''}`))
  if (a.rules.own.length) lines.push('', 'Rules:', ...a.rules.own.map(c => `  ${c.says}  [${c.rule}]`))
  if (a.rules.violations.length) lines.push('', 'Broken now:', ...a.rules.violations.map(v => `  ${violationLine(v)}`))
  if (a.deadExports.length) lines.push('', `Exports nothing uses: ${a.deadExports.join(', ')}`)
  if (a.testOnlyExports.length) lines.push(`Exports only tests use: ${a.testOnlyExports.join(', ')}`)
  lines.push(...fileDocsLines(a.docs))
  // the riskiest functions (a straight-line one is no risk to speak of)
  const risky = a.functions.filter(f => f.complexity > 1).slice(0, FILE_FUNCTIONS)
  if (risky.length) lines.push('', 'Functions, riskiest first:', ...risky.map(f => `  ${riskLine(f, false)}`))
  return `${lines.join('\n')}\n`
}

/** Functions listed in `query file`. */
const FILE_FUNCTIONS = 8

const percent = (x: number) => `${Math.round(x * 100)} %`

/** `rowProblem  CRAP 65 · complexity 23 · coverage 57 %` (with the place, for a folder). */
function riskLine(f: FunctionRisk, where: boolean): string {
  const at = where ? `  ${f.path}:${f.line}` : ` (line ${f.line})`
  const facts = [f.crap !== undefined && `CRAP ${f.crap}`, `complexity ${f.complexity}`, f.coverage !== undefined && `coverage ${percent(f.coverage)}`, f.stale && 'changed since the coverage run', f.unmeasured && 'not in the coverage run'].filter(Boolean)
  return `${f.name}${at}  ${facts.join(' · ')}`
}

export function risksText(a: RisksAnswer, max: number): string {
  const scored = a.functions.filter(f => f.crap !== undefined)
  const over = scored.filter(f => f.crap! >= 10).length
  const lines = [
    `${placeName(a.place)}: ${a.functions.length} functions, riskiest first`,
    a.coverage
      ? `  CRAP = complexity² × (1 − coverage)³ + complexity, coverage from ${a.coverage.file} (${a.coverage.at.slice(0, 16).replace('T', ' ')} UTC): ${over} of ${scored.length} at CRAP 10 or more`
      : '  no coverage run found (npm run test:coverage writes one): by complexity only',
  ]
  if (a.stale.length) lines.push(`  ${a.stale.length} file${a.stale.length === 1 ? '' : 's'} changed since that run: complexity only (${a.stale.slice(0, 3).join(', ')}${a.stale.length > 3 ? ' …' : ''})`)
  lines.push('', ...a.functions.slice(0, max).map(f => `  ${riskLine(f, a.place.kind !== 'file')}`))
  if (a.functions.length > max) lines.push(`  … ${a.functions.length - max} more (--max)`)
  return `${lines.join('\n')}\n`
}

// ── impact ────────────────────────────────────────────────────────────────

/** Files each list of `query impact` shows. */
const IMPACT_MAX = 20

/** `query impact`: what depends on a file, folder, function or class (`<path>#<name>`, an `s:` id) or package. */
function impactReply(q: Query, args: QueryArgs): { text: string; code: number } {
  if (!args.paths.length) return { text: 'archrift query impact: a path needed\n', code: EXIT.usage }
  const seed = q.impactSeed(args.paths[0])
  if (seed.kind === 'ambiguous') return { text: `${seed.path}: several files have that name, which one?\n${seed.candidates.map(c => `  ${c}`).join('\n')}\n`, code: EXIT.ambiguous }
  if (seed.kind === 'missing') return { text: `${seed.path}: no file, folder, function, class or package by that name\n`, code: EXIT.missing }
  const a = q.impact(seed, args.depth)
  return { text: args.format === 'json' ? `${JSON.stringify(a, null, 2)}\n` : impactText(a, args.max ?? IMPACT_MAX), code: EXIT.ok }
}

export function impactText(a: ImpactAnswer, max: number): string {
  const name = seedName(a.seed)
  if (a.seed.kind === 'new') return `${name}: no file there yet, so nothing depends on it yet\n`
  if (!a.hits.length) return `${name}: nothing depends on it${a.seed.kind === 'folder' ? ' from outside it' : ''}\n`
  return `${[...impactHead(a, name), ...impactLevels(a, max), ...impactReach(a, max)].join('\n')}\n`
}

function impactHead(a: ImpactAnswer, name: string): string[] {
  const direct = a.hits.filter(h => h.depth === 1).length
  const outside = a.seed.kind === 'folder' ? ' from outside it' : ''
  const walked = a.depth ? `; walked ${count(a.depth, 'step')}${a.beyond ? `, ${count(a.beyond, 'file')} further (--depth)` : ''}` : ''
  const reach = [a.features.length && `in ${count(a.features.length, 'feature')}`, a.entryPoints.length && count(a.entryPoints.length, 'entry point')].filter(Boolean)
  return [
    `${name}: ${count(a.hits.length, 'file')} depend${a.hits.length === 1 ? 's' : ''} on it${outside} (${direct} directly)${reach.length ? `, ${reach.join(', ')}` : ''}`,
    `  ${count(a.production, 'production file')}, ${count(a.tests, 'test file')} (${a.testsToRun.length} to run); by steps ${a.levels.map(l => `${l.depth}: ${l.production + l.tests}`).join(' · ')}${walked}`,
  ]
}

/** The files by step, each list capped at `max`: the first two steps, or as many as --depth asked; further ones counted. */
function impactLevels(a: ImpactAnswer, max: number): string[] {
  const listed = a.depth ?? 2
  const out: string[] = []
  for (const l of a.levels.filter(x => x.depth <= listed)) {
    const hits = a.hits.filter(h => h.depth === l.depth)
    const title = l.depth === 1 ? 'Directly (' : l.depth === 2 ? 'Through them (2 steps, ' : `${l.depth} steps (`
    out.push('', `${title}${hits.length}):`, ...hits.slice(0, max).map(h => `  ${hitLine(h, l.depth > 1 || a.seed.kind === 'folder')}`), ...more(hits.length, max))
  }
  const further = a.levels.filter(l => l.depth > listed)
  if (further.length) out.push('', `Further: ${further.map(l => `${count(l.depth, 'step')}: ${count(l.production + l.tests, 'file')}`).join(' · ')} (--depth ${further.at(-1)!.depth} lists them, --format json has every file)`)
  return out
}

function impactReach(a: ImpactAnswer, max: number): string[] {
  const out: string[] = []
  if (a.features.length) out.push('', `Features: ${a.features.map(f => `${f.name} ${f.files}`).join(' · ')}`)
  if (a.entryPoints.length) out.push('', `Entry points reached (${a.entryPoints.length}):`, ...a.entryPoints.slice(0, max).map(e => `  ${e.route ? `${e.kind} ${e.route}  ` : ''}${e.path}`), ...more(a.entryPoints.length, max))
  const support = a.tests - a.testsToRun.length
  out.push('', a.testsToRun.length ? `Tests that reach it (run these, ${a.testsToRun.length}):` : 'Tests that reach it: none', ...a.testsToRun.slice(0, max).map(t => `  ${t}`), ...more(a.testsToRun.length, max))
  if (support) out.push(`  (${count(support, 'more test file')} reach${support === 1 ? 'es' : ''} it: helpers, fixtures or setup, which run nothing)`)
  return out
}

const hitLine = (h: ImpactHit, via: boolean) => `${h.path}${h.line ? `:${h.line}` : ''}${via ? `  via ${h.via}` : ''}  (${h.kinds.join(', ')})`
const more = (n: number, max: number) => (n > max ? [`  … ${n - max} more (--max)`] : [])
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
const seedName = (s: ImpactStart) => (s.kind === 'symbol' ? `${s.path} › ${s.name}` : s.kind === 'external' ? path_(s.id) : s.kind === 'folder' ? `${s.path || '(root)'}/` : s.path)

export function violationLine(v: Violation): string {
  if (v.measure || v.expects) return `${v.severity === 'error' ? '✗' : '!'} ${v.rule}: ${v.message}`
  const ends = v.path && v.path.length > 2 ? v.path.map(path_).join(' → ') : `${path_(v.from)} → ${path_(v.to)}`
  return `${v.severity === 'error' ? '✗' : '!'} ${v.rule}: ${ends}`
}

const path_ = (id: string) => id.replace(/^f:/, '').replace(/^x:npm:/, '')
const placeName = (p: Place) => (p.kind === 'folder' ? `${p.path || '(root)'}/` : p.path)

// ── documents ─────────────────────────────────────────────────────────────

/** Documents and ids `query file` lists. */
const FILE_DOCS = 5

function fileDocsLines(d: FileAnswer['docs']): string[] {
  if (!d.named.length && !d.cites.length) return []
  const out = ['', `Docs (query docs ${'<path>'} for all):`]
  out.push(...d.cites.slice(0, FILE_DOCS).map(c => `  cites ${citeLine(c)}`))
  if (d.cites.length > FILE_DOCS) out.push(`  … ${d.cites.length - FILE_DOCS} more ids`)
  out.push(...d.named.slice(0, FILE_DOCS).map(r => `  named in ${refLine(r)}`))
  if (d.named.length > FILE_DOCS) out.push(`  … ${d.named.length - FILE_DOCS} more documents`)
  return out
}

/** `D34 (line 12): Savings plan … — ../architecture/09-…html:339; also in 1 more`. */
function citeLine(c: CitedId): string {
  const def = c.meant[0]
  const where = c.meant.map(m => `${m.doc}:${m.line}`).join(', ')
  return `${c.id} (line ${c.line})${def ? `: ${def.label} — ${where}` : ''}${c.also.length ? `; also defined in ${count(c.also.length, 'other document')}` : ''}`
}

/** `../architecture/05-….html (kept current) § 5.1 Level 1 …, line 120`. */
function refLine(r: DocRef): string {
  const first = r.places[0]
  const at = `${first.section ? `§ ${first.section}, ` : ''}line ${first.line}`
  return `${r.doc}${r.current ? ' (kept current)' : ''}  ${at}${r.places.length > 1 ? ` (+${r.places.length - 1} more)` : ''}`
}

const defLine = (d: IdDefinition, current: boolean) => `${d.doc}:${d.line}${current ? ' (kept current)' : ''}  ${d.label}`

export function docsText(a: DocsAnswer, max: number): string {
  switch (a.kind) {
    case 'none':
      return a.place.kind === 'ambiguous' ? `${a.place.path}: several files have that name, which one?\n${a.place.candidates.map(c => `  ${c}`).join('\n')}\n` : `${a.place.path}: no file, folder, function, decision id or document by that name${a.read ? '' : ' (no documents were read: config docs.include)'}\n`
    case 'id':
      return idText(a, max)
    case 'doc':
      return docText(a, max)
    case 'code':
      return codeDocsText(a, max)
  }
}

function idText(a: DocsAnswer & { kind: 'id' }, max: number): string {
  const lines = [`${a.id.id}: defined in ${count(a.id.defined.length, 'document')}`, ...a.id.defined.map(d => `  ${defLine(d, a.current.has(d.doc))}`)]
  lines.push('', `Cited by ${count(a.id.cited.length, 'file')}:`)
  for (const c of a.id.cited.slice(0, max)) lines.push(`  ${c.file}:${c.line}${c.count > 1 ? ` (${c.count}×)` : ''}${a.id.defined.length > 1 ? `  → ${c.docs.join(', ')}` : ''}`)
  if (a.id.cited.length > max) lines.push(`  … ${a.id.cited.length - max} more (--max)`)
  return `${lines.join('\n')}\n`
}

function docText(a: DocsAnswer & { kind: 'doc' }, max: number): string {
  const d = a.doc
  const lines = [`${d.path}: ${d.title}${d.current ? ' (kept current)' : ''}`]
  const bySection = new Map<string, string[]>()
  for (const m of d.mentions) bySection.set(m.section ?? '', [...(bySection.get(m.section ?? '') ?? []), nodeName(m.node)])
  lines.push('', d.mentions.length ? `Names ${count(d.mentions.length, 'place')} in the code:` : 'Names nothing in the code.')
  for (const [section, names] of [...bySection].slice(0, max)) lines.push(`  ${section ? `§ ${section}: ` : ''}${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}`)
  if (bySection.size > max) lines.push(`  … ${bySection.size - max} more sections (--max)`)
  if (a.defines.length) lines.push('', `Defines ${count(a.defines.length, 'id')} the code cites:`, ...a.defines.slice(0, max).map(x => `  ${x.id} (line ${x.line}): ${x.label}  — cited by ${count(x.cited, 'file')}${x.meant < x.cited ? `, ${x.meant} meaning this document` : ''}`))
  if (d.dangling?.length) lines.push('', `Paths it names that no file has (${d.dangling.length}): ${d.dangling.slice(0, 6).map(x => x.text).join(', ')}${d.dangling.length > 6 ? ' …' : ''}`)
  return `${lines.join('\n')}\n`
}

function codeDocsText(a: DocsAnswer & { kind: 'code' }, max: number): string {
  const name = a.symbol ? a.symbol.replace(/^s:/, '') : placeName(a.place)
  if (!a.read) return `${name}: no documents were read (config docs.include)\n`
  const lines = [`${name}: named in ${count(a.named.length, 'document')}${a.cites.length ? `, cites ${count(a.cites.length, 'decision id')}` : ''}`]
  if (a.cites.length) lines.push('', 'Cites:', ...a.cites.slice(0, max).map(c => `  ${c.file === a.place.path ? '' : `${c.file}: `}${citeLine(c)}`))
  if (a.named.length) lines.push('', 'Named in (kept current first):')
  for (const r of a.named.slice(0, max)) {
    lines.push(`  ${r.doc}${r.current ? ' (kept current)' : ''}`)
    for (const p of r.places.slice(0, 3)) lines.push(`    ${p.section ? `§ ${p.section}, ` : ''}line ${p.line}: ${nodeName(p.node)}${p.count > 1 ? ` (${p.count}×)` : ''}`)
    if (r.places.length > 3) lines.push(`    … ${r.places.length - 3} more`)
  }
  if (a.named.length > max) lines.push(`  … ${a.named.length - max} more documents (--max)`)
  return `${lines.join('\n')}\n`
}

const nodeName = nodeLabel
