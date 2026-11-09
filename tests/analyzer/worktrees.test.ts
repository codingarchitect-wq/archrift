// The worktrees archrift checks older commits out in (diff's base, snapshot):
// gone however the process ends, and a killed run's removed by the next one,
// while another live run's is left alone.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKTREE_PREFIX, inWorktree, removeStaleWorktrees, staleWorktrees } from '../../src/analyzer/worktrees.ts'
import { makeHistoryRepo } from '../helpers/history-repo.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const listed = (repo: string) => git(repo, 'worktree', 'list', '--porcelain')
let base: string
let repo: string
let sha: string
beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-worktrees-'))
  repo = path.join(base, 'repo')
  sha = makeHistoryRepo(repo).at(-1)!
})
afterAll(() => {
  git(repo, 'worktree', 'prune')
  fs.rmSync(base, { recursive: true, force: true })
})
const place = (name: string) => path.join(base, `${WORKTREE_PREFIX}${name}`)
/** A process id that was just used and is gone. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!

describe('archrift worktrees', () => {
  it('exist while in use, locked with the process id, and are gone after', async () => {
    const at = place('use')
    const seen = await inWorktree(repo, at, sha, async wt => ({ files: fs.existsSync(path.join(wt, 'src')), listed: listed(repo) }))
    expect(seen.files).toBe(true)
    expect(seen.listed).toContain(`worktree ${fs.realpathSync(base)}/${path.basename(at)}\nHEAD ${sha}\ndetached\nlocked archrift ${process.pid}`)
    expect(fs.existsSync(at)).toBe(false)
    expect(listed(repo)).not.toContain(path.basename(at))
  })

  it('are gone after an error too', async () => {
    const at = place('error')
    await expect(inWorktree(repo, at, sha, async () => Promise.reject(new Error('analysis failed')))).rejects.toThrow('analysis failed')
    expect(fs.existsSync(at)).toBe(false)
    expect(listed(repo)).not.toContain(path.basename(at))
  })

  it('a killed run left are removed by the next run; a live run keeps its own', () => {
    const left = place('killed')
    const live = place('live')
    const theirs = path.join(base, 'not-archrift')
    git(repo, 'worktree', 'add', '--detach', '--lock', '--reason', `archrift ${deadPid()}`, left, sha)
    git(repo, 'worktree', 'add', '--detach', '--lock', '--reason', `archrift ${process.pid}`, live, sha)
    git(repo, 'worktree', 'add', '--detach', theirs, sha)
    removeStaleWorktrees(repo)
    expect(fs.existsSync(left)).toBe(false)
    expect(listed(repo)).not.toContain(path.basename(left))
    expect(listed(repo)).toContain(path.basename(live))
    expect(listed(repo)).toContain('not-archrift')
    git(repo, 'worktree', 'remove', '--force', '--force', live)
    git(repo, 'worktree', 'remove', '--force', theirs)
  })

  it('are read from git\'s list: archrift\'s own, locked by a process that is gone', () => {
    const porcelain = [
      `worktree /repo\nHEAD ${sha}\nbranch refs/heads/main`,
      `worktree /tmp/${WORKTREE_PREFIX}a\nHEAD ${sha}\ndetached\nlocked archrift 41`,
      `worktree /tmp/${WORKTREE_PREFIX}b\nHEAD ${sha}\ndetached\nlocked archrift 42`,
      `worktree /tmp/${WORKTREE_PREFIX}c\nHEAD ${sha}\ndetached\nlocked`,
      `worktree /tmp/other\nHEAD ${sha}\ndetached\nlocked archrift 41`,
    ].join('\n\n')
    expect(staleWorktrees(porcelain, pid => pid === 42)).toEqual([`/tmp/${WORKTREE_PREFIX}a`])
  })

  it.skipIf(process.platform === 'win32')('are gone when the process is stopped (SIGTERM), which exits 143', async () => {
    const at = place('signal')
    const module = path.resolve(import.meta.dirname, '../../src/analyzer/worktrees.ts')
    const script = `import { inWorktree } from ${JSON.stringify(module)}\nawait inWorktree(${JSON.stringify(repo)}, ${JSON.stringify(at)}, ${JSON.stringify(sha)}, () => { console.log('ready'); return new Promise(() => setInterval(() => {}, 1000)) })`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>(resolve => child.stdout.on('data', (d: Buffer) => d.toString().includes('ready') && resolve()))
    expect(fs.existsSync(at)).toBe(true)
    const code = new Promise<number | null>(resolve => child.on('exit', c => resolve(c)))
    child.kill('SIGTERM')
    expect(await code).toBe(143)
    expect(fs.existsSync(at)).toBe(false)
    expect(listed(repo)).not.toContain(path.basename(at))
  })
})
