// `archrift diff` (docs/QUERY.md): what a change does to the architecture, for
// a pull request or before a commit. The base (a ref; by default where the
// branch left the main one, which on the main branch is HEAD) is analyzed in a
// worktree beside the snapshots'; the head is the working tree, or a ref. Both
// sides are measured with today's config, and blocks are the head's.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { Config } from '../analyzer/config.ts'
import { pathTags } from '../analyzer/config.ts'
import { gitRoot } from '../analyzer/history.ts'
import { analyzeIsolated } from '../analyzer/isolated.ts'
import { analyzeRevision, resolveRevisions } from '../analyzer/snapshots.ts'
import { diffArchitecture } from '../core/diff.ts'
import type { ArchitectureDiff, JobChange } from '../core/diff.ts'
import type { Graph } from '../core/model.ts'
import type { ReachChange, ReachDiff } from '../core/reach.ts'
import type { Violation } from '../core/rules.ts'
import { blockFinder, coherenceOf } from './coherence.ts'
import { JSON_SCHEMA_VERSION } from './output.ts'

export interface DiffArgs {
  base?: string
  head?: string
  /** Also fail on new deviations and new ways (not only on rules with severity error). */
  strict: boolean
  format: 'text' | 'json' | 'markdown'
}

/**
 * Branches a feature branch usually leaves from, in the order tried: the local main first (on it,
 * the base is HEAD, so the diff is the uncommitted change, however far ahead of the remote it is),
 * then the remote's (a CI checkout has no local main).
 */
const MAIN_BRANCHES = ['main', 'master', 'origin/HEAD', 'origin/main', 'origin/master']

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** The base to compare with: the ref given, else the merge base of HEAD and the main branch, else HEAD. */
/** A revision as the reader names it, with its short sha: `main (1a2b3c4d)`; a sha written out shortened (`1a2b3c4d`, `1a2b3c4d~1 (0f9e8d7c)`). */
export function revisionLabel(ref: string, sha: string): string {
  const named = ref.replace(/\b[0-9a-f]{40}\b/g, full => full.slice(0, 8))
  return named === sha.slice(0, 8) ? named : `${named} (${sha.slice(0, 8)})`
}

export function baseRevision(root: string, ref?: string): { sha: string; label: string } {
  if (ref) {
    const [r] = resolveRevisions(root, [ref])
    return { sha: r.sha, label: revisionLabel(ref, r.sha) }
  }
  for (const branch of MAIN_BRANCHES) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])
      const sha = git(root, ['merge-base', 'HEAD', branch])
      const head = git(root, ['rev-parse', 'HEAD'])
      return { sha, label: sha === head ? `HEAD (${sha.slice(0, 8)})` : `where HEAD left ${branch.replace(/^origin\/HEAD$/, 'the remote main branch')} (${sha.slice(0, 8)})` }
    } catch {
      // not this one
    }
  }
  const sha = git(root, ['rev-parse', 'HEAD'])
  return { sha, label: `HEAD (${sha.slice(0, 8)})` }
}

export interface Comparison {
  base: { sha: string; label: string }
  /** The head revision's sha; none for the working tree. */
  head?: string
  headLabel: string
  headGraph: Graph
  diff: ArchitectureDiff
  /** Paths the change touches (added, changed, removed), relative to the root. */
  touched: string[]
  /** New violations of error rules, error limits broken further, error rules left matching nothing. */
  errors: number
  /** Unaccepted drift: files doing a job differently from their block, and new ways. */
  drift: number
}

/**
 * The working tree (or `head`) against its base, as `archrift diff` and the viewer's Changes
 * panel see it. `headGraph`: the working tree already analyzed (the server's graph);
 * `baseGraphs`: bases analyzed before, by commit (a base doesn't change).
 */
export async function compareWithBase(options: { root: string; config: Config; files?: number; out: string; base?: string; head?: string; headGraph?: Graph; baseGraphs?: Map<string, Graph>; log?: (msg: string) => void }): Promise<Comparison> {
  const { root, config } = options
  if (!gitRoot(root)) throw new Error(`${root} is not in a git repository with commits`)
  const dir = path.join(path.dirname(options.out), 'snapshots')
  const base = baseRevision(root, options.base)
  const head = options.head ? resolveRevisions(root, [options.head])[0] : undefined
  const headLabel = head ? revisionLabel(options.head!, head.sha) : 'the working tree'
  options.log?.(`archrift diff: ${base.label} → ${headLabel}`)
  const baseGraph = options.baseGraphs?.get(base.sha) ?? (await analyzeRevision({ root, config, files: options.files, dir, sha: base.sha })) ?? empty()
  options.baseGraphs?.set(base.sha, baseGraph)
  // a revision's graph never changes: kept with the bases (the viewer's Changes panel compares one range after another)
  const headGraph = head
    ? (options.baseGraphs?.get(head.sha) ?? (await analyzeRevision({ root, config, files: options.files, dir, sha: head.sha })) ?? empty())
    : (options.headGraph ?? (await analyzeIsolated({ root, config, files: options.files, cacheDir: path.join(path.dirname(options.out), 'cache'), history: false })))
  if (head) options.baseGraphs?.set(head.sha, headGraph)

  const tagsFor = pathTags(config)
  const blockOf = blockFinder(headGraph, p => tagsFor(p).find(t => t.startsWith('group:'))?.slice(6))
  const touched = [
    ...git(root, ['diff', '--name-only', '--relative', base.sha, ...(head ? [head.sha] : [])]).split('\n'),
    ...(head ? [] : git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')),
  ].filter(Boolean)
  const diff = diffArchitecture({
    base: { graph: baseGraph, coherence: coherenceOf(baseGraph, blockOf) },
    head: { graph: headGraph, coherence: coherenceOf(headGraph, blockOf) },
    blockOf,
    touched,
  })
  const errors = [...diff.rules.added, ...diff.rules.grew.map(g => g.after), ...diff.rules.unmatched].filter(v => v.severity === 'error').length
  const drift = diff.jobs.filter(j => !j.accepted).reduce((n, j) => n + j.deviations.length + j.newWays.length, 0)
  return { base, head: head?.sha, headLabel, headGraph, diff, touched, errors, drift }
}

export async function runDiff(options: { root: string; config: Config; files?: number; out: string; args: DiffArgs; log: (msg: string) => void }): Promise<{ text: string; code: number }> {
  const { args } = options
  const c = await compareWithBase({ ...options, base: args.base, head: args.head })
  const code = c.errors || (args.strict && c.drift) ? 1 : 0
  const meta = { project: c.headGraph.meta.name, base: c.base.label, head: c.headLabel, touched: c.touched.length }
  if (args.format === 'json') return { text: `${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ...meta, ...c.diff }, null, 2)}\n`, code }
  return { text: args.format === 'markdown' ? diffMarkdown(c.diff, meta) : diffText(c.diff, meta), code }
}

/** A side that didn't exist yet. */
function empty(): Graph {
  return { meta: { name: '', generatedAt: '', tool: { name: 'archrift', version: '' }, analyzers: [], targets: [], counts: {}, timings: {}, cycles: [], violations: [], concerns: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } }, nodes: [], edges: [], sites: [] }
}

interface Meta {
  project: string
  base: string
  head: string
  touched: number
}

/** Findings, as lines (markdown: `code` for paths, bold for names). */
function findings(d: ArchitectureDiff, md: boolean): { title: string; lines: string[] }[] {
  const c = (s: string) => (md ? `\`${s}\`` : s)
  const b = (s: string) => (md ? `**${s}**` : s)
  const v = (x: Violation) => {
    if (x.measure) {
      const where = `${c(x.from.replace(/^f:/, ''))}${x.measure.symbol ? ` › ${c(x.measure.symbol.slice(x.measure.symbol.indexOf('#') + 1))}` : ''}`
      return `${x.severity === 'error' ? '✗' : '!'} ${b(x.rule)} (${x.severity}): ${where}: ${x.measure.metric} ${x.measure.value}, ${x.measure.bound === 'max' ? 'more' : 'less'} than ${x.measure.limit}`
    }
    if (x.expects) {
      const where = `${c(x.from.replace(/^f:/, ''))}${x.expects.symbol ? ` › ${c(x.expects.symbol.slice(x.expects.symbol.indexOf('#') + 1))}` : ''}`
      return `${x.severity === 'error' ? '✗' : '!'} ${b(x.rule)} (${x.severity}): ${where} never reaches ${c(x.expects.to)}`
    }
    const ends = x.path && x.path.length > 2 ? x.path.map(id => c(id.replace(/^f:/, ''))).join(' → ') : `${c(x.from.replace(/^f:/, ''))} → ${c(x.to.replace(/^f:/, ''))}`
    return `${x.severity === 'error' ? '✗' : '!'} ${b(x.rule)} (${x.severity}): ${ends}`
  }
  // a limit broken further: the measure before → after
  const grown = ({ before, after }: { before: Violation; after: Violation }) => {
    const line = v(after)
    const m = after.measure!
    return `↑ ${line.slice(2).replace(`${m.metric} ${m.value},`, `${m.metric} ${before.measure!.value} → ${m.value},`)} (grew)`
  }
  const out: { title: string; lines: string[] }[] = []
  const emptied = d.rules.unmatched.length
  const grew = d.rules.grew.length
  if (d.rules.added.length || grew || d.rules.fixed.length || emptied)
    out.push({
      title: `Rules: ${[d.rules.added.length && count(d.rules.added.length, 'new violation'), grew && `${count(grew, 'limit')} broken further`, d.rules.fixed.length && `${d.rules.fixed.length} fixed`, emptied && `${count(emptied, 'rule')} now matching nothing`].filter(Boolean).join(', ')}`,
      lines: [
        ...d.rules.unmatched.flatMap(r => r.parts.map(p => `${r.severity === 'error' ? '✗' : '!'} ${b(r.rule)} (${r.severity}): ${p}, so the rule checks nothing there`)),
        ...d.rules.added.map(v),
        ...d.rules.grew.map(grown),
        ...d.rules.fixed.map(x => `✓ fixed: ${v(x).slice(2)}`),
      ],
    })
  if (d.cycles.added.length || d.cycles.fixed.length)
    out.push({
      title: `Import cycles: ${both(count(d.cycles.added.length, 'new one'), d.cycles.added.length, `${d.cycles.fixed.length} gone`, d.cycles.fixed.length)}`,
      lines: [...d.cycles.added.map(x => `new: ${[...x, x[0]].map(id => c(id.replace(/^f:/, ''))).join(' → ')}`), ...d.cycles.fixed.map(x => `gone: ${x.map(id => c(id.replace(/^f:/, ''))).join(', ')}`)],
    })
  const jobs = d.jobs.filter(j => j.deviations.length || j.newWays.length || j.goneWays.length || j.resolved.length || j.progress.length)
  if (jobs.length) {
    const deviations = jobs.reduce((n, j) => n + j.deviations.length, 0)
    const ways = jobs.reduce((n, j) => n + j.newWays.length, 0)
    const better = jobs.reduce((n, j) => n + j.resolved.length + j.progress.length, 0)
    const parts = [ways && count(ways, 'new way'), deviations && count(deviations, 'file that does a job differently from its block', 'files that do a job differently from their block'), better && count(better, 'file back in line', 'files back in line')]
    out.push({ title: `Coherence: ${parts.filter(Boolean).join(', ') || 'ways changed'}`, lines: jobs.flatMap(j => jobLines(j, c, b)) })
  }
  if (d.blocks.added.length || d.blocks.removed.length)
    out.push({
      title: `Blocks: ${both(`${count(d.blocks.added.length, 'new dependency', 'new dependencies')} between blocks`, d.blocks.added.length, `${count(d.blocks.removed.length, 'dependency', 'dependencies')} gone`, d.blocks.removed.length)}`,
      lines: [
        ...d.blocks.added.slice(0, 10).map(x => `${c(x.from)} → ${c(x.to)}, through ${c(x.via[0])} → ${c(x.via[1])}`),
        ...(d.blocks.added.length > 10 ? [`… ${d.blocks.added.length - 10} more`] : []),
        ...d.blocks.removed.slice(0, 10).map(x => `gone: ${c(x.from)} → ${c(x.to)}`),
      ],
    })
  const reach = reachFinding(d.reach, c)
  if (reach) out.push(reach)
  const docs = docsFinding(d.docs, c)
  if (docs) out.push(docs)
  return out
}

/** Documents kept current that name what the change removes or reshapes: worth a look, they may no longer hold. */
function docsFinding(docs: ArchitectureDiff['docs'] | undefined, c: (s: string) => string): { title: string; lines: string[] } | undefined {
  if (!docs?.length) return undefined
  const files = new Set(docs.map(d => d.doc)).size
  return {
    title: `Docs: ${count(docs.length, 'place')} in ${count(files, 'document')} kept current ${docs.length === 1 ? 'names' : 'name'} code this change removes or reshapes: do they still hold?`,
    lines: [
      ...docs.slice(0, 12).map(d => `${c(d.doc)}${d.section ? ` § ${d.section}` : ''} (line ${d.line}) names ${c(d.names)}, which ${d.why === 'removed' ? 'is gone' : 'changed its exports or signature'}`),
      ...(docs.length > 12 ? [`… ${docs.length - 12} more (--format json lists all)`] : []),
    ],
  }
}

/** Imports that bring files into entry points (up to ten, the most first), and gone ones. */
function reachFinding(r: ReachDiff, c: (s: string) => string): { title: string; lines: string[] } | undefined {
  if (!r.added.length && !r.removed.length) return undefined
  const files = (xs: ReachChange[]) => new Set(xs.flatMap(x => x.files)).size
  const packages = (xs: ReachChange[]) => new Set(xs.flatMap(x => x.packages)).size
  const amount = (xs: ReachChange[]) => [files(xs) && count(files(xs), 'file'), packages(xs) && count(packages(xs), 'package')].filter(Boolean).join(' and ')
  const title = [
    r.added.length && `${count(r.added.length, 'import brings', 'imports bring')} ${amount(r.added)} into entry points that didn't load them`,
    r.removed.length && `${count(r.removed.length, 'import', 'imports')} gone, taking ${amount(r.removed)} out`,
  ]
  const what = (x: ReachChange) => [x.files.length && count(x.files.length, 'file'), x.packages.length && `${x.packages.length === 1 ? 'package' : 'packages'} ${x.packages.map(c).join(', ')}`].filter(Boolean).join(' and ')
  const into = (x: ReachChange) => `${count(x.entries.length, 'entry point')}${x.targets.join() === 'default' ? '' : ` (${x.targets.join(', ')})`}`
  const some = (xs: string[], n: number) => `${xs.slice(0, n).map(c).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`
  return {
    title: `Reach: ${title.filter(Boolean).join('; ')}`,
    lines: [
      ...r.added.slice(0, 10).flatMap(x => [
        `${c(x.from)} → ${c(x.to)} brings ${what(x)} into ${into(x)}`,
        ...(x.files.length ? [`  files: ${some(x.files, 3)}`] : []),
        `  entry points: ${some(x.entries, 2)}`,
      ]),
      ...(r.added.length > 10 ? [`… ${r.added.length - 10} more`] : []),
      ...r.removed.slice(0, 10).map(x => `gone: ${c(x.from)} → ${c(x.to)}, so ${into(x)} no longer ${x.entries.length === 1 ? 'loads' : 'load'} ${what(x)}`),
    ],
  }
}

function jobLines(j: JobChange, c: (s: string) => string, b: (s: string) => string): string[] {
  const head = `${b(`${j.stack} · ${j.label}`)}${j.newWays.length ? `: new way ${j.newWays.join(', ')}` : ''}${j.goneWays.length ? `${j.newWays.length ? ';' : ':'} no longer ${j.goneWays.join(', ')}` : ''}${j.accepted ? ` (several ways on purpose: ${j.accepted})` : ''}`
  return [
    head,
    ...j.deviations.map(x => `  ${c(x.path)} uses ${x.ways.join(' and ')}; ${c(x.block)} uses ${x.blockWay}${x.examples.length ? ` (e.g. ${x.examples.map(c).join(', ')})` : ''}${x.touched ? '' : ' (not touched: its block changed)'}`),
    ...j.progress.map(x => `  ✓ ${c(x.path)}: ${x.from.length ? `${x.from.join(', ')} → ` : 'new, '}${x.to.join(', ')} (off the legacy way)`),
    ...j.resolved.map(p => `  ✓ ${c(p)} now does it its block's way`),
  ]
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** "2 new, 1 fixed", leaving out a part that's zero. */
const both = (a: string, an: number, b: string, bn: number) => [an && a, bn && b].filter(Boolean).join(', ')

export function diffText(d: ArchitectureDiff, m: Meta): string {
  const lines = [`archrift diff ${m.project}: ${m.base} → ${m.head}, ${count(m.touched, 'file')} touched (${d.files.added.length} new, ${d.files.removed.length} removed)`]
  const f = findings(d, false)
  if (!f.length) lines.push('', 'Nothing changes for the rules, the import cycles, coherence, the dependencies between blocks, what entry points load or the documents kept current.')
  for (const x of f) lines.push('', x.title, ...x.lines.map(l => `  ${l}`))
  return `${lines.join('\n')}\n`
}

export function diffMarkdown(d: ArchitectureDiff, m: Meta): string {
  const lines = [`### archrift: what this change does to the architecture`, '', `${m.base} → ${m.head} · ${count(m.touched, 'file')} touched`]
  const f = findings(d, true)
  if (!f.length) lines.push('', 'Nothing changes for the rules, the import cycles, coherence, the dependencies between blocks, what entry points load or the documents kept current. ✓')
  for (const x of f) lines.push('', `**${x.title}**`, '', ...x.lines.map(l => (l.startsWith('  ') ? `  - ${l.trim()}` : `- ${l}`)))
  return `${lines.join('\n')}\n`
}
