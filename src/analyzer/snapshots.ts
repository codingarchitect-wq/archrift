// Snapshots for time travel: older commits analyzed in a temporary
// git worktree and kept by commit sha. One worktree, at a path that stays the
// same between runs, is checked out at each revision in turn, so compiler
// options don't change and the fragment cache carries unchanged files from one
// snapshot to the next.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Graph } from '../core/model.ts'
import { encodeGraph } from '../core/serialize.ts'
import { SNAPSHOT_INDEX, readSnapshotIndex } from '../core/snapshot-index.ts'
import type { Revision, SnapshotInfo } from '../core/snapshot-index.ts'
import type { Config } from './config.ts'
import { gitRoot } from './history.ts'
import { analyzeIsolated } from './isolated.ts'
import { WORKTREE_PREFIX, inWorktree } from './worktrees.ts'

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })

function parseRevisions(text: string, rev?: string): Revision[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, time, subject] = line.split('\x1f')
      return { sha, rev: rev ?? sha, time: Number(time), subject }
    })
}

/** Named revisions (tags, branches, HEAD~n), resolved to commits. */
export function resolveRevisions(root: string, revs: string[]): Revision[] {
  return revs.map(rev => {
    const [r] = parseRevisions(git(root, ['log', '-1', '--format=%H%x1f%ct%x1f%s', rev, '--']), rev)
    if (!r) throw new Error(`no commit for ${rev}`)
    return r
  })
}

/**
 * `count` commits from the root's first-parent history, not counting HEAD
 * (that's "now"): every `every`-th one back from HEAD, or spread evenly in
 * time from the first commit on (work comes in bursts, so evenly by count
 * would crowd the recent weeks).
 */
export function pickRevisions(root: string, count: number, every?: number): Revision[] {
  const all = parseRevisions(git(root, ['log', '--first-parent', '--format=%H%x1f%ct%x1f%s', '--', '.'])) // newest first
  if (all.length < 2) return []
  const picked = new Set<number>()
  const first = all.at(-1)!.time
  const span = all[0].time - first
  for (let i = 0; i < count; i++) {
    // the last commit at or before each step in time
    const index = every ? (i + 1) * every : all.findIndex(c => c.time <= first + (i * span) / count)
    if (index > 0 && index < all.length) picked.add(index)
  }
  return [...picked].sort((a, b) => b - a).map(i => all[i])
}

export interface SnapshotOptions {
  root: string
  config: Config
  /** About how many source files there are (sizes the analysis heap). */
  files?: number
  /** Where snapshot graphs, their index and their fragment cache go. */
  dir: string
  revisions: Revision[]
  log?: (msg: string) => void
}

/** Analyzes every revision not already in `dir`; returns the whole index, oldest first. */
export async function takeSnapshots(options: SnapshotOptions): Promise<SnapshotInfo[]> {
  const log = options.log ?? (() => {})
  const repo = gitRoot(options.root)
  if (!repo) throw new Error(`${options.root} is not in a git repository with commits`)
  fs.mkdirSync(options.dir, { recursive: true })
  const index = new Map(readSnapshotIndex(options.dir).map(s => [s.sha, s]))
  const save = () => fs.writeFileSync(path.join(options.dir, SNAPSHOT_INDEX), JSON.stringify([...index.values()].sort((a, b) => a.time - b.time), null, 2) + '\n')
  const todo = options.revisions.filter(r => !index.has(r.sha))
  // already taken: keep the friendlier name
  for (const r of options.revisions) {
    const s = index.get(r.sha)
    if (s && r.rev !== r.sha) s.rev = r.rev
  }
  if (todo.length)
    await inWorktree(repo.top, worktreeFor(options.dir, 'snapshots'), todo[0].sha, async worktree => {
      for (const [i, r] of todo.entries()) {
        log(`snapshot ${i + 1}/${todo.length}: ${r.rev} ${r.sha.slice(0, 8)} (${new Date(r.time * 1000).toISOString().slice(0, 10)}) ${r.subject}`)
        git(worktree, ['checkout', '--detach', '--force', '--quiet', r.sha])
        const graph = await analyzeCheckout(worktree, repo.prefix, options)
        if (!graph) {
          log(`  skipped: ${repo.prefix || '.'} didn't exist yet`)
          continue
        }
        graph.meta.snapshot = { sha: r.sha, rev: r.rev, time: r.time, subject: r.subject }
        fs.writeFileSync(path.join(options.dir, `${r.sha}.json`), JSON.stringify(encodeGraph(graph).graph))
        index.set(r.sha, { ...r, files: graph.meta.counts.files ?? 0, loc: graph.meta.counts.loc ?? 0 })
        save() // an interrupted run keeps what it finished
      }
    })
  save()
  return [...index.values()].sort((a, b) => a.time - b.time)
}

/**
 * One commit analyzed on its own (`archrift diff`'s base), in a worktree of its
 * own beside the snapshots' and with their fragment cache; undefined when the
 * root didn't exist at that commit.
 */
export async function analyzeRevision(options: Omit<SnapshotOptions, 'revisions'> & { sha: string }): Promise<Graph | undefined> {
  const repo = gitRoot(options.root)
  if (!repo) throw new Error(`${options.root} is not in a git repository with commits`)
  return inWorktree(repo.top, worktreeFor(options.dir, 'revision'), options.sha, worktree => analyzeCheckout(worktree, repo.prefix, options))
}

/** A worktree's place: the same for a snapshots folder every run, so compiler options don't change and the cache carries over. */
const worktreeFor = (dir: string, use: string) => path.join(os.tmpdir(), `${WORKTREE_PREFIX}${crypto.createHash('sha1').update(`${path.resolve(dir)}${use === 'snapshots' ? '' : `#${use}`}`).digest('hex').slice(0, 10)}`)

/** The root as a checkout has it, analyzed without history; undefined when it didn't exist then. */
async function analyzeCheckout(worktree: string, prefix: string, options: { root: string; config: Config; files?: number; dir: string }): Promise<Graph | undefined> {
  const root = path.join(worktree, prefix)
  if (!fs.existsSync(root)) return undefined
  // packages aren't committed: borrow today's, so imports of them still resolve
  const modules = path.join(options.root, 'node_modules')
  const link = path.join(root, 'node_modules')
  if (fs.existsSync(modules) && !fs.existsSync(link)) fs.symlinkSync(modules, link, 'dir')
  return analyzeIsolated({ root, config: options.config, files: options.files, cacheDir: path.join(options.dir, 'cache'), history: false })
}
