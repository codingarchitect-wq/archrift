// The temporary git worktrees archrift checks older commits out in (`diff`'s
// base, `snapshot`). Each is locked with the id of the process that added it
// and removed when that process ends, however it ends: done, an error, Ctrl-C,
// a timeout's SIGTERM, a closed terminal. After a kill nothing can catch, the
// next archrift that adds a worktree in the same repository removes it. A
// worktree whose process still runs (another agent's diff, in parallel) is
// left alone.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })

/** The start of every archrift worktree's folder name (in the temp folder). */
export const WORKTREE_PREFIX = 'archrift-worktree-'
/** The lock reason: `archrift <pid>`. */
const LOCK = /^archrift (\d+)$/

/** The worktrees this process holds, each with its repository's top folder. */
const held = new Map<string, string>()
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

function onSignal(signal: NodeJS.Signals) {
  for (const [worktree, top] of held) removeWorktree(top, worktree)
  process.exit(128 + (os.constants.signals[signal] ?? 0))
}

function hold(worktree: string, top: string) {
  if (!held.size) for (const s of SIGNALS) process.on(s, onSignal)
  held.set(worktree, top)
}

function release(worktree: string) {
  held.delete(worktree)
  if (!held.size) for (const s of SIGNALS) process.off(s, onSignal)
}

/** Checks `sha` out in a worktree at `worktree` for as long as `use` runs, then removes it. */
export async function inWorktree<T>(top: string, worktree: string, sha: string, use: (worktree: string) => Promise<T>): Promise<T> {
  removeStaleWorktrees(top)
  removeWorktree(top, worktree) // one left at this place
  git(top, ['worktree', 'add', '--detach', '--quiet', '--lock', '--reason', `archrift ${process.pid}`, worktree, sha])
  hold(worktree, top)
  try {
    return await use(worktree)
  } finally {
    removeWorktree(top, worktree)
    release(worktree)
  }
}

/** Removes a worktree, locked or not, and whatever git still lists for it. */
export function removeWorktree(top: string, worktree: string) {
  try {
    git(top, ['worktree', 'remove', '--force', '--force', worktree])
  } catch {
    fs.rmSync(worktree, { recursive: true, force: true })
    try {
      git(top, ['worktree', 'unlock', worktree])
    } catch {
      // not locked, or not a worktree
    }
  }
  try {
    git(top, ['worktree', 'prune'])
  } catch {
    // nothing to prune
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The archrift worktrees in `git worktree list --porcelain` whose process is gone. */
export function staleWorktrees(porcelain: string, alive: (pid: number) => boolean = isAlive): string[] {
  return porcelain
    .split(/\n\n+/)
    .map(block => {
      const lines = block.split('\n')
      const where = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
      const pid = LOCK.exec(lines.find(l => l.startsWith('locked '))?.slice('locked '.length) ?? '')?.[1]
      return { where, pid: pid ? Number(pid) : undefined }
    })
    .filter(w => w.where && path.basename(w.where).startsWith(WORKTREE_PREFIX) && w.pid !== undefined && !alive(w.pid))
    .map(w => w.where!)
}

/** Removes the worktrees archrift processes that are gone left in the repository. */
export function removeStaleWorktrees(top: string) {
  for (const worktree of staleWorktrees(git(top, ['worktree', 'list', '--porcelain']))) removeWorktree(top, worktree)
}
