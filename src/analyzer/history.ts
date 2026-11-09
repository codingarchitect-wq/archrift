// Git history: one `git log` pass over the analyzed root feeds
// per-file churn, commit and author counts, the last change, and the pairs of
// files that change together. Renames are followed, so a file's history
// includes the commits made under its old names.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Graph } from '../core/model.ts'

export interface CommitFile {
  path: string
  /** The path before a rename in this commit. */
  from?: string
  added: number
  deleted: number
}

export interface Commit {
  sha: string
  /** Author time, unix seconds. */
  time: number
  author: string
  subject: string
  files: CommitFile[]
}

export interface HistoryOptions {
  /** Churn counts the lines changed in this many days before the newest commit. */
  windowDays: number
  /** Commits touching more files than this don't count toward co-change (mass edits, renames). */
  maxFilesPerCommit: number
  /** A pair must change together at least this often… */
  minSupport: number
  /** …in at least this share of the commits of the file that changes less. */
  minConfidence: number
  /** Each file keeps its strongest partners only. */
  maxPartners: number
}

export const DEFAULT_HISTORY: HistoryOptions = { windowDays: 90, maxFilesPerCommit: 30, minSupport: 3, minConfidence: 0.3, maxPartners: 12 }

export interface FileHistory {
  commits: number
  /** Lines added + deleted within the window. */
  churn: number
  authors: number
  /** Unix seconds of its last commit. */
  lastCommit: number
  /** Unix seconds of its first commit (under any of its names): when it was written. */
  firstCommit: number
}

export interface CoChange {
  a: string
  b: string
  /** Commits that changed both. */
  support: number
  /** support / commits of the file that changes less (0–1). */
  confidence: number
}

export interface History {
  head: string
  commits: number
  authors: number
  /** Oldest and newest commit, unix seconds. */
  since: number
  until: number
  windowDays: number
  files: Map<string, FileHistory>
  coChanges: CoChange[]
}

export interface GitRoot {
  /** The repository's top level, and the analyzed root's path inside it ('' or 'sub/dir/'). */
  top: string
  prefix: string
  head: string
}

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] })

/** The repository `root` lives in, or undefined when it isn't in one (or has no commits). */
export function gitRoot(root: string): GitRoot | undefined {
  try {
    const [top, prefix, head] = git(root, ['rev-parse', '--show-toplevel', '--show-prefix', 'HEAD']).split('\n')
    return { top, prefix, head }
  } catch {
    return undefined
  }
}

/** Every commit touching `root`, newest first, with paths relative to root. */
export function readLog(root: string, rev = 'HEAD'): Commit[] {
  const text = git(root, ['log', rev, '-M', '--numstat', '-z', '--relative', '--no-color', '--format=%x1e%H%x1f%at%x1f%aN%x1f%s', '--', '.'])
  return parseLog(text)
}

/**
 * `git log -z --numstat --format=%x1e%H%x1f%at%x1f%aN%x1f%s`: a record per
 * commit, its header ending in NUL, then `added\tdeleted\tpath` NUL-terminated,
 * or for a rename `added\tdeleted\t` NUL `old` NUL `new` NUL. Binary files
 * count `-` lines.
 */
export function parseLog(text: string): Commit[] {
  const commits: Commit[] = []
  for (const record of text.split('\x1e')) {
    if (!record.trim()) continue
    const tokens = record.split('\0')
    const [sha, time, author, subject] = tokens[0].split('\x1f')
    const files: CommitFile[] = []
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i].replace(/^\n+/, '')
      if (!t) continue
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(t)
      if (!m) continue
      const added = m[1] === '-' ? 0 : Number(m[1])
      const deleted = m[2] === '-' ? 0 : Number(m[2])
      if (m[3]) files.push({ path: m[3], added, deleted })
      else {
        files.push({ path: tokens[i + 2], from: tokens[i + 1], added, deleted })
        i += 2
      }
    }
    commits.push({ sha, time: Number(time), author, subject: subject ?? '', files })
  }
  return commits
}

/** Aggregates commits (newest first) for the files that exist now. */
export function summarizeHistory(commits: readonly Commit[], current: ReadonlySet<string>, head: string, options: HistoryOptions = DEFAULT_HISTORY): History {
  // follow renames: walking back in time, an old name stands for the file's current name
  const alias = new Map<string, string>()
  const nameOf = (p: string) => alias.get(p) ?? p
  const until = commits[0]?.time ?? 0
  const windowStart = until - options.windowDays * 86_400
  const stats = new Map<string, { commits: number; churn: number; authors: Set<string>; lastCommit: number; firstCommit: number; eligible: number }>()
  const support = new Map<string, number>()
  const authors = new Set<string>()
  for (const c of commits) {
    authors.add(c.author)
    const touched = new Set<string>()
    for (const f of c.files) {
      const now = nameOf(f.path)
      if (f.from !== undefined && f.from !== f.path) alias.set(f.from, now)
      if (!current.has(now)) continue
      touched.add(now)
      let s = stats.get(now)
      if (!s) stats.set(now, (s = { commits: 0, churn: 0, authors: new Set(), lastCommit: c.time, firstCommit: c.time, eligible: 0 }))
      s.firstCommit = Math.min(s.firstCommit, c.time)
      if (c.time >= windowStart) s.churn += f.added + f.deleted
    }
    // a mass edit is one by what it touched then, files deleted since included
    const massEdit = c.files.length > options.maxFilesPerCommit
    const files = [...touched].sort()
    for (const f of files) {
      const s = stats.get(f)!
      s.commits++
      s.authors.add(c.author)
      if (!massEdit) s.eligible++
    }
    if (files.length < 2 || massEdit) continue
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\0${files[j]}`
        support.set(key, (support.get(key) ?? 0) + 1)
      }
  }

  const candidates: CoChange[] = []
  for (const [key, n] of support) {
    if (n < options.minSupport) continue
    const [a, b] = key.split('\0')
    const confidence = n / Math.min(stats.get(a)!.eligible, stats.get(b)!.eligible)
    if (confidence >= options.minConfidence) candidates.push({ a, b, support: n, confidence: Math.round(confidence * 100) / 100 })
  }
  // keep a pair when it is among the strongest of either file
  const strongest = (x: CoChange, y: CoChange) => y.support - x.support || y.confidence - x.confidence || (x.a + x.b < y.a + y.b ? -1 : 1)
  const partners = new Map<string, CoChange[]>()
  for (const c of candidates) for (const f of [c.a, c.b]) partners.set(f, [...(partners.get(f) ?? []), c])
  const kept = new Set<CoChange>()
  for (const list of partners.values()) list.sort(strongest).slice(0, options.maxPartners).forEach(c => kept.add(c))

  const files = new Map<string, FileHistory>()
  for (const [f, s] of [...stats].sort((x, y) => (x[0] < y[0] ? -1 : 1)))
    files.set(f, { commits: s.commits, churn: s.churn, authors: s.authors.size, lastCommit: s.lastCommit, firstCommit: s.firstCommit })
  return {
    head,
    commits: commits.length,
    authors: authors.size,
    since: commits.at(-1)?.time ?? 0,
    until,
    windowDays: options.windowDays,
    files,
    coChanges: [...kept].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1)),
  }
}

/** A folder whose history counts: the root ('' prefix), or a mount (its name and a slash). */
export interface HistoryRoot {
  dir: string
  prefix: string
}

type LogMemo = { head?: string; prefix?: string; commits?: Commit[] }

/**
 * The log of each folder at its HEAD, cached in `cacheDir` by HEAD's sha
 * (reading the log is the slow part; summarizing is cheap), with paths as the
 * graph has them. A mount's commits are its own repository's: they join the
 * root's by time. Undefined when no folder is in a repository.
 */
export function loadHistory(
  roots: readonly HistoryRoot[],
  current: ReadonlySet<string>,
  options: HistoryOptions,
  cacheDir?: string,
  /** A long-lived session's copy, so each run doesn't read the cache files again. */
  memo?: Record<string, LogMemo>,
): History | undefined {
  const logs: { head: string; commits: Commit[] }[] = []
  for (const { dir, prefix } of roots) {
    const repo = gitRoot(dir)
    if (!repo) continue
    const own = memo ? (memo[prefix] ??= {}) : undefined
    const file = cacheDir ? path.join(cacheDir, prefix ? `git-log-${prefix.slice(0, -1)}.json` : 'git-log.json') : undefined
    let commits: Commit[] | undefined = own?.head === repo.head && own.prefix === repo.prefix ? own.commits : undefined
    if (!commits && file && fs.existsSync(file)) {
      try {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as { head: string; prefix: string; commits: Commit[] }
        if (cached.head === repo.head && cached.prefix === repo.prefix) commits = cached.commits
      } catch {
        // a broken cache is read again
      }
    }
    if (!commits) {
      commits = readLog(dir)
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ head: repo.head, prefix: repo.prefix, commits }))
      }
    }
    if (own) Object.assign(own, { head: repo.head, prefix: repo.prefix, commits })
    logs.push({ head: repo.head, commits: prefix ? commits.map(c => ({ ...c, files: c.files.map(f => ({ ...f, path: prefix + f.path, ...(f.from !== undefined ? { from: prefix + f.from } : {}) })) })) : commits })
  }
  if (!logs.length) return undefined
  const commits = logs.length === 1 ? logs[0].commits : logs.flatMap(l => l.commits).sort((a, b) => b.time - a.time)
  return summarizeHistory(commits, current, logs[0].head, options)
}

/**
 * Adds the history to a graph: per-file `commits`, `churn`, `authors`,
 * `lastCommit`, `firstCommit` and `hotspot` (churn × complexity), and
 * `co-changes` edges.
 */
export function applyHistory(graph: Graph, h: History) {
  const byPath = new Map(graph.nodes.filter(n => n.kind === 'file').map(n => [n.path!, n]))
  for (const [p, n] of byPath) {
    const f = h.files.get(p)
    n.metrics ??= {}
    n.metrics.commits = f?.commits ?? 0
    n.metrics.churn = f?.churn ?? 0
    n.metrics.authors = f?.authors ?? 0
    if (f) {
      n.metrics.lastCommit = f.lastCommit
      n.metrics.firstCommit = f.firstCommit
    }
    n.metrics.hotspot = (f?.churn ?? 0) * (n.metrics.complexity ?? 0)
  }
  for (const c of h.coChanges) {
    graph.edges.push({
      source: `f:${c.a}`,
      target: `f:${c.b}`,
      kind: 'co-changes',
      count: c.support,
      targets: [...graph.meta.targets],
      confidence: 'inferred',
      weight: c.confidence,
    })
    if (graph.sites.length) graph.sites.push([])
  }
  const { head, commits, authors, since, until, windowDays } = h
  graph.meta.history = { head, commits, authors, since, until, windowDays }
  graph.meta.counts['edges.co-changes'] = h.coChanges.length
  graph.meta.counts.edges = (graph.meta.counts.edges ?? 0) + h.coChanges.length
}
