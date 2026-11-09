// The viewer's Changes panel (core/changes.ts): the served graph (the working
// tree as analyzed) against its base, as `archrift diff` compares them, with the
// files git sees changed and what the coding agent wrote about the change in
// `.archrift/changes.json`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../analyzer/config.ts'
import { MAX_COMMITS, parseChangeTasks } from '../core/changes.ts'
import type { ChangeTask, ChangedFile, ChangesRange, ChangesReport, CommitInfo } from '../core/changes.ts'
import type { Graph } from '../core/model.ts'
import { compareWithBase } from './diff.ts'
import { projectDir } from '../analyzer/config.ts'

/**
 * Where a coding agent writes what it did and why (`{ "tasks": [{ "title", "request", "summary",
 * "notes": { "<path>": "why" } }] }`): beside the descriptions, left out of git (it is about the
 * change in progress, not the code).
 */
export function changesPath(root: string, config?: string): string {
  if (!config) return path.join(projectDir(root), 'changes.json')
  const abs = path.resolve(config)
  const base = path.basename(abs)
  return path.join(path.dirname(abs), base === 'config.json' ? 'changes.json' : `${base.replace(/\.json$/, '')}.changes.json`)
}

export function readChangeTasks(file: string): ChangeTask[] {
  try {
    return parseChangeTasks(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * The files changed from `base` to `head` (a revision; default: the working tree), with lines added
 * and removed; in the working tree, new files git doesn't know yet count as added.
 */
export function changedFiles(root: string, base: string, head?: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  const range = head ? [base, head] : [base]
  for (const line of git(root, ['diff', '--name-status', '-M', '--relative', ...range]).split('\n').filter(Boolean)) {
    const [code, a, b] = line.split('\t')
    const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'removed' : code.startsWith('R') ? 'renamed' : 'modified'
    const p = status === 'renamed' ? b : a
    files.set(p, { path: p, status, ...(status === 'renamed' ? { from: a } : {}) })
  }
  for (const line of git(root, ['diff', '--numstat', '-M', '--relative', ...range]).split('\n').filter(Boolean)) {
    const [added, removed, ...rest] = line.split('\t')
    // a rename reads `old => new` or `dir/{old => new}/x`
    const name = rest.join('\t').replace(/\{([^}]*) => ([^}]*)\}/, '$2').replace(/^.* => /, '')
    const f = files.get(name)
    if (f && added !== '-') Object.assign(f, { added: Number(added), removed: Number(removed) })
  }
  for (const p of head ? [] : git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    let lines: number | undefined
    try {
      const text = fs.readFileSync(path.join(root, p), 'utf8')
      lines = text.includes('\u0000') ? undefined : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    } catch {
      lines = undefined
    }
    files.set(p, { path: p, status: 'added', ...(lines !== undefined ? { added: lines, removed: 0 } : {}) })
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
}

const FIELD = '\u001f'
const RECORD = '\u001e'

/** `git log` with the given arguments, as commits (newest first): those touching the project's folder (a repository can hold more than one). */
function log(root: string, args: string[]): CommitInfo[] {
  const out = git(root, ['log', `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ct${FIELD}%s${FIELD}%b${RECORD}`, ...args, '--', '.'])
  return out
    .split(RECORD)
    .map(r => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map(r => {
      const [sha, parents, author, date, subject, body] = r.split(FIELD)
      return { sha, subject, ...(body?.trim() ? { body: body.trim() } : {}), author, date: Number(date), ...(parents ? {} : { root: true as const }) }
    })
}

/** The latest commits on HEAD touching the project, for the Changes panel's range picker. */
export function recentCommits(root: string, max = 30): CommitInfo[] {
  try {
    return log(root, [`--max-count=${max}`, 'HEAD'])
  } catch {
    return [] // no commits yet
  }
}

/**
 * The served graph (the working tree, `head`) or a revision (`range.head`) against the base
 * (`range.base`; default: where HEAD left main, else HEAD), as `archrift diff` compares them, with
 * the files and commits between them and, for the working tree, the agent's notes.
 */
export async function changesReport(options: { root: string; config: Config; configPath?: string; out: string; head: Graph; range?: ChangesRange; baseGraphs: Map<string, Graph> }): Promise<ChangesReport> {
  const range = options.range ?? {}
  const c = await compareWithBase({ root: options.root, config: options.config, out: options.out, base: range.base, head: range.head, headGraph: options.head, baseGraphs: options.baseGraphs })
  const notes = changesPath(options.root, options.configPath)
  // the notes are about the change in progress, not part of it
  const own = path.relative(options.root, notes).split(path.sep).join('/')
  return {
    base: c.base,
    head: c.headLabel,
    ...(c.head ? { headSha: c.head } : {}),
    files: changedFiles(options.root, c.base.sha, c.head).filter(f => f.path !== own),
    diff: c.diff,
    errors: c.errors,
    tasks: c.head ? [] : readChangeTasks(notes),
    commits: log(options.root, [`--max-count=${MAX_COMMITS}`, `${c.base.sha}..${c.head ?? 'HEAD'}`]),
  }
}
