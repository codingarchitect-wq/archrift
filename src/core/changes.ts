// The change in progress, for the viewer's Changes panel: the files the
// working tree changes since its base (where the branch left main; on main,
// HEAD), what `archrift diff` finds about it, and what the coding agent said it
// did and why (`.archrift/changes.json`, written by the agent: notes per file).
// The server computes it (cli/changes.ts); this is its shape, and the findings
// grouped by the file they are about, for coloring and the inspector. Pure.
import type { ArchitectureDiff } from './diff.ts'
import type { Violation } from './rules.ts'

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  /** A renamed file's old path. */
  from?: string
  /** Lines added and removed (none for a binary file). */
  added?: number
  removed?: number
}

/** One thing the agent was asked to do, what it did, and why each file changed (`.archrift/changes.json`). */
export interface ChangeTask {
  title?: string
  /** What was asked, in the asker's words. */
  request?: string
  /** What was done, and where it stands. */
  summary?: string
  /** File path → how its change serves the request. */
  notes: Record<string, string>
}

/** A commit, for the Changes panel's range picker and the commits a range spans. */
export interface CommitInfo {
  sha: string
  subject: string
  /** The message below the subject, when there is one. */
  body?: string
  author: string
  /** Unix seconds (the committer's date). */
  date: number
  /** The repository's first commit: nothing before it to compare with. */
  root?: true
}

/**
 * What the Changes panel compares: `base` (a revision; default: where HEAD left
 * main, else HEAD) with `head` (a revision; default: the working tree, the
 * change in progress). The last commit is `HEAD~1`..`HEAD`.
 */
export interface ChangesRange {
  base?: string
  head?: string
}

export interface ChangesReport {
  /** What the head is compared with. */
  base: { sha: string; label: string }
  /** The head's label: `the working tree`, or a revision with its short sha. */
  head: string
  /** The head revision's sha; none for the working tree (the change in progress). */
  headSha?: string
  files: ChangedFile[]
  diff: ArchitectureDiff
  /** New violations of error rules, and error limits broken further: what makes `archrift diff` exit 1. */
  errors: number
  /** What the agent wrote about the change in progress, when it wrote anything (none for a range of commits: their messages say it). */
  tasks: ChangeTask[]
  /** The commits from the base to the head (to HEAD for the working tree), newest first, at most MAX_COMMITS. */
  commits: CommitInfo[]
}

/** The most commits a report lists. */
export const MAX_COMMITS = 50

/** The Changes panel's ways to pick a range: the change in progress, the last commit, one commit, or everything since one (to the working tree). */
export type RangeMode = 'progress' | 'last' | 'commit' | 'since'

/** The range a choice in the panel compares (`sha`: the commit picked, for one commit or since one). */
export function rangeFor(mode: RangeMode, sha?: string): ChangesRange {
  if (mode === 'last') return { base: 'HEAD~1', head: 'HEAD' }
  if (mode === 'commit' && sha) return { base: `${sha}~1`, head: sha }
  if (mode === 'since' && sha) return { base: sha }
  return {}
}

/** The panel's choice a range stands for (rangeFor's inverse). */
export function modeOf(range: ChangesRange): { mode: RangeMode; sha?: string } {
  if (!range.base && !range.head) return { mode: 'progress' }
  if (range.base === 'HEAD~1' && range.head === 'HEAD') return { mode: 'last' }
  if (range.head && range.base === `${range.head}~1`) return { mode: 'commit', sha: range.head }
  return { mode: 'since', sha: range.base }
}

export type FindingKind = 'rule' | 'grew' | 'fixed' | 'cycle' | 'job' | 'block' | 'reach' | 'docs'

/** Something `archrift diff` found, pinned to the file it is about. */
export interface Finding {
  kind: FindingKind
  /** Bad news (a broken rule, a new cycle), news (a new way), or good news (fixed, back in line). */
  tone: 'error' | 'warn' | 'good'
  text: string
  /** For a rule: the violation, to find it in the graph shown (by `violationKey`). */
  violation?: Violation
}

const pathOf = (id: string) => id.replace(/^f:/, '')

/** Every finding, by the file it is about (a violation by the file to fix; a cycle by each member). */
export function findingsByFile(diff: ArchitectureDiff): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>()
  const add = (path: string, f: Finding) => out.set(path, [...(out.get(path) ?? []), f])
  for (const v of diff.rules.added) add(pathOf(v.from), { kind: 'rule', tone: v.severity === 'error' ? 'error' : 'warn', text: `breaks ${v.rule}: ${v.message}`, violation: v })
  for (const { before, after } of diff.rules.grew) {
    const m = after.measure!
    add(pathOf(after.from), { kind: 'grew', tone: after.severity === 'error' ? 'error' : 'warn', text: `${after.rule}: ${m.symbol ? `${m.symbol.slice(m.symbol.indexOf('#') + 1)}'s ` : ''}${m.metric} ${before.measure!.value} → ${m.value} (${m.bound} ${m.limit})`, violation: after })
  }
  for (const v of diff.rules.fixed) add(pathOf(v.from), { kind: 'fixed', tone: 'good', text: `no longer breaks ${v.rule}` })
  for (const c of diff.cycles.added) for (const id of c) add(pathOf(id), { kind: 'cycle', tone: 'error', text: `in a new import cycle of ${c.length} files` })
  for (const j of diff.jobs) {
    for (const d of j.deviations) add(d.path, { kind: 'job', tone: j.accepted ? 'good' : 'warn', text: `${j.label}: uses ${d.ways.join(' and ')}, its block ${d.block} uses ${d.blockWay}` })
    for (const p of j.progress) add(p.path, { kind: 'job', tone: 'good', text: `${j.label}: off the legacy way (${p.to.join(', ')})` })
    for (const p of j.resolved) add(p, { kind: 'job', tone: 'good', text: `${j.label}: now its block's way` })
  }
  for (const b of diff.blocks.added) add(b.via[0], { kind: 'block', tone: 'warn', text: `${b.from} now depends on ${b.to} (through ${b.via[1]})` })
  for (const r of diff.reach.added) {
    const what = [r.files.length && `${r.files.length} file${r.files.length === 1 ? '' : 's'}`, r.packages.length && r.packages.join(', ')].filter(Boolean).join(' and ')
    add(r.from, { kind: 'reach', tone: 'warn', text: `importing ${r.to} brings ${what} into ${r.entries.length} entry point${r.entries.length === 1 ? '' : 's'}` })
  }
  for (const d of diff.docs ?? []) add(d.path, { kind: 'docs', tone: 'warn', text: `${d.doc}${d.section ? ` § ${d.section}` : ''} (line ${d.line}) names ${d.names}, which ${d.why === 'removed' ? 'is gone' : 'changed shape'}: does it still hold?` })
  return out
}

/** The worst tone among a file's findings, for its color. */
export function worstTone(findings: readonly Finding[] | undefined): Finding['tone'] | undefined {
  if (!findings?.length) return undefined
  return findings.some(f => f.tone === 'error') ? 'error' : findings.some(f => f.tone === 'warn') ? 'warn' : 'good'
}

/** The agent's notes for a file, from every task that has one. */
export function notesFor(tasks: readonly ChangeTask[], path: string): { task: ChangeTask; note: string }[] {
  return tasks.flatMap(task => (task.notes[path] ? [{ task, note: task.notes[path] }] : []))
}

/** `.archrift/changes.json` as written by an agent, read leniently: what isn't text is left out. */
export function parseChangeTasks(raw: unknown): ChangeTask[] {
  const r = raw as { tasks?: unknown } | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.tasks)) return []
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  return r.tasks.flatMap((t: unknown) => {
    if (!t || typeof t !== 'object') return []
    const x = t as Record<string, unknown>
    const notes = x.notes && typeof x.notes === 'object' && !Array.isArray(x.notes) ? Object.fromEntries(Object.entries(x.notes as Record<string, unknown>).flatMap(([k, v]) => (text(v) ? [[k.replace(/^\.\//, ''), text(v)!]] : []))) : {}
    const task: ChangeTask = { ...(text(x.title) ? { title: text(x.title) } : {}), ...(text(x.request) ? { request: text(x.request) } : {}), ...(text(x.summary) ? { summary: text(x.summary) } : {}), notes }
    return task.title || task.request || task.summary || Object.keys(notes).length ? [task] : []
  })
}
