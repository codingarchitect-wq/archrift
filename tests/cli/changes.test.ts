// The viewer's Changes panel: the served graph against its base, with git's
// changed files and the agent's notes (src/cli/changes.ts, src/core/changes.ts).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyzer/analyze.ts'
import { loadConfig } from '../../src/analyzer/config.ts'
import { changedFiles, changesPath, changesReport, recentCommits } from '../../src/cli/changes.ts'
import { revisionLabel } from '../../src/cli/diff.ts'
import { findingsByFile, modeOf, notesFor, parseChangeTasks, rangeFor, worstTone } from '../../src/core/changes.ts'
import type { Graph } from '../../src/core/model.ts'

const dirs: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-changes-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

/** A shop whose pages must not use the server, committed; the change adds a page that does and edits another. */
function shop() {
  const repo = tmp()
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), text)
  }
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }))
  write('.archrift/config.json', JSON.stringify({ name: 'shop', rules: [{ name: 'pages-not-server', forbid: { from: 'src/app/**', to: 'src/server/**' } }] }))
  write('src/app/a.ts', 'export const a = 1\n')
  write('src/app/b.ts', 'export const b = 2\n')
  write('src/server/db.ts', 'export const db = { rows: [] as string[] }\n')
  const git = (...args: string[]) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: repo })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'start')
  write('src/app/c.ts', "import { db } from '../server/db'\nexport const c = () => db.rows.length\n")
  write('src/app/a.ts', 'export const a = 1\nexport const a2 = 2\n')
  fs.rmSync(path.join(repo, 'src/app/b.ts'))
  return repo
}

describe('the change in progress', () => {
  it('lists the files git sees changed since the base, with their lines; new files count as added', () => {
    const repo = shop()
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
    expect(changedFiles(repo, sha)).toEqual([
      { path: 'src/app/a.ts', status: 'modified', added: 1, removed: 0 },
      { path: 'src/app/b.ts', status: 'removed', added: 0, removed: 1 },
      { path: 'src/app/c.ts', status: 'added', added: 2, removed: 0 },
    ])
  })

  it("compares the served graph with its base, and carries the agent's notes", async () => {
    const repo = shop()
    fs.writeFileSync(changesPath(repo), JSON.stringify({ tasks: [{ title: 'Row count', request: 'Show how many rows there are', summary: 'A page counts the rows.', notes: { './src/app/c.ts': 'Counts the rows; reads the database directly.' } }] }))
    const config = loadConfig(repo)
    const head: Graph = await analyze({ root: repo, config, cacheDir: false, history: false })
    const bases = new Map<string, Graph>()
    const r = await changesReport({ root: repo, config, out: path.join(tmp(), 'graph.json'), head, baseGraphs: bases })
    expect(r.base.label).toMatch(/^HEAD \([0-9a-f]{8}\)$/)
    expect(r.head).toBe('the working tree')
    expect(r.files.map(f => `${f.status} ${f.path}`)).toEqual(['modified src/app/a.ts', 'removed src/app/b.ts', 'added src/app/c.ts'])
    expect(r.errors).toBe(1)
    expect(r.tasks).toEqual([{ title: 'Row count', request: 'Show how many rows there are', summary: 'A page counts the rows.', notes: { 'src/app/c.ts': 'Counts the rows; reads the database directly.' } }])
    const findings = findingsByFile(r.diff)
    expect(findings.get('src/app/c.ts')).toEqual([
      expect.objectContaining({ kind: 'rule', tone: 'error', text: 'breaks pages-not-server: src/app/c.ts must not depend on src/server/db.ts', violation: expect.objectContaining({ rule: 'pages-not-server' }) }),
      expect.objectContaining({ kind: 'block', tone: 'warn' }),
    ])
    expect(worstTone(findings.get('src/app/c.ts'))).toBe('error')
    expect(notesFor(r.tasks, 'src/app/c.ts').map(n => n.note)).toEqual(['Counts the rows; reads the database directly.'])
    // the base is analyzed once
    expect(bases.size).toBe(1)
  })
})

describe('a range of commits', () => {
  /** The shop with its change committed (a message with a body), then a.ts changed once more, uncommitted. */
  function committed() {
    const repo = shop()
    const git = (...args: string[]) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...args], { cwd: repo, encoding: 'utf8' }).stdout.trim()
    git('add', '-A')
    git('commit', '-qm', 'Count the rows', '-m', 'A page reads the database directly.')
    fs.writeFileSync(path.join(repo, 'src/app/a.ts'), 'export const a = 3\n')
    fs.writeFileSync(changesPath(repo), JSON.stringify({ tasks: [{ title: 'Three', notes: { 'src/app/a.ts': 'a is three now.' } }] }))
    return { repo, git }
  }

  it('compares the last commit: its files and its commit, not the uncommitted change, and no agent notes', async () => {
    const { repo, git } = committed()
    const config = loadConfig(repo)
    const served: Graph = await analyze({ root: repo, config, cacheDir: false, history: false })
    const bases = new Map<string, Graph>()
    const r = await changesReport({ root: repo, config, out: path.join(tmp(), 'graph.json'), head: served, range: { base: 'HEAD~1', head: 'HEAD' }, baseGraphs: bases })
    expect(r.base.label).toMatch(/^HEAD~1 \([0-9a-f]{8}\)$/)
    expect(r.head).toMatch(/^HEAD \([0-9a-f]{8}\)$/)
    expect(r.headSha).toBe(git('rev-parse', 'HEAD'))
    // a.ts as the commit left it: one line added, not the uncommitted rewrite
    expect(r.files).toEqual([
      { path: 'src/app/a.ts', status: 'modified', added: 1, removed: 0 },
      { path: 'src/app/b.ts', status: 'removed', added: 0, removed: 1 },
      { path: 'src/app/c.ts', status: 'added', added: 2, removed: 0 },
    ])
    expect(r.commits).toEqual([{ sha: git('rev-parse', 'HEAD'), subject: 'Count the rows', body: 'A page reads the database directly.', author: 'Ada', date: expect.any(Number) }])
    expect(r.tasks).toEqual([])
    expect(r.errors).toBe(1) // the commit's page reads the server
    // both revisions analyzed once, kept for the next range
    expect(bases.size).toBe(2)
  })

  it('compares the working tree since an older commit: the commits since, then the change in progress', async () => {
    const { repo, git } = committed()
    const config = loadConfig(repo)
    const served: Graph = await analyze({ root: repo, config, cacheDir: false, history: false })
    const start = git('rev-list', '--max-parents=0', 'HEAD')
    const r = await changesReport({ root: repo, config, out: path.join(tmp(), 'graph.json'), head: served, range: { base: start }, baseGraphs: new Map() })
    expect(r.head).toBe('the working tree')
    expect(r.headSha).toBeUndefined()
    // a sha written out reads shortened
    expect(r.base.label).toBe(start.slice(0, 8))
    expect(r.files.map(f => `${f.status} ${f.path} +${f.added}`)).toEqual(['modified src/app/a.ts +1', 'removed src/app/b.ts +0', 'added src/app/c.ts +2'])
    expect(r.commits.map(c => c.subject)).toEqual(['Count the rows'])
    expect(r.tasks.map(t => t.title)).toEqual(['Three'])
  })

  it('are labelled as the reader names them, a sha written out shortened', () => {
    const sha = 'a'.repeat(40)
    const parent = 'b'.repeat(40)
    expect(revisionLabel('main', sha)).toBe('main (aaaaaaaa)')
    expect(revisionLabel('HEAD~1', parent)).toBe('HEAD~1 (bbbbbbbb)')
    expect(revisionLabel(sha, sha)).toBe('aaaaaaaa')
    expect(revisionLabel(`${sha}~1`, parent)).toBe('aaaaaaaa~1 (bbbbbbbb)')
  })

  it("are what the panel's choices compare, and read back as those choices", () => {
    expect(rangeFor('progress')).toEqual({})
    expect(rangeFor('last')).toEqual({ base: 'HEAD~1', head: 'HEAD' })
    expect(rangeFor('commit', 'abc123')).toEqual({ base: 'abc123~1', head: 'abc123' })
    expect(rangeFor('since', 'abc123')).toEqual({ base: 'abc123' })
    for (const [mode, sha] of [['progress'], ['last'], ['commit', 'abc123'], ['since', 'abc123']] as const) expect(modeOf(rangeFor(mode, sha))).toEqual({ mode, ...(sha ? { sha } : {}) })
  })

  it('lists the latest commits to pick from, newest first', () => {
    const { repo } = committed()
    expect(recentCommits(repo).map(c => [c.subject, c.author, c.body, c.root])).toEqual([
      ['Count the rows', 'Ada', 'A page reads the database directly.', undefined],
      ['start', 'Ada', undefined, true], // the first: nothing before it
    ])
    expect(recentCommits(repo, 1)).toHaveLength(1)
    expect(recentCommits(tmp())).toEqual([]) // no repository: nothing to pick
  })

  it("leave out commits that don't touch the project, in a repository holding more than one", () => {
    const { repo } = committed()
    // the shop as a folder of a bigger repository, beside another project
    const outer = tmp()
    fs.cpSync(repo, path.join(outer, 'shop'), { recursive: true })
    fs.rmSync(path.join(outer, 'shop/.git'), { recursive: true, force: true })
    fs.mkdirSync(path.join(outer, 'other'))
    fs.writeFileSync(path.join(outer, 'other/x.ts'), 'export const x = 1\n')
    const g = (...args: string[]) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...args], { cwd: outer, encoding: 'utf8' })
    g('init', '-q')
    g('add', 'shop')
    g('commit', '-qm', 'The shop')
    g('add', 'other')
    g('commit', '-qm', 'Another project')
    expect(recentCommits(path.join(outer, 'shop')).map(c => c.subject)).toEqual(['The shop'])
  })
})

describe('the change notes', () => {
  it('are read leniently: text kept, the rest left out', () => {
    expect(parseChangeTasks(null)).toEqual([])
    expect(parseChangeTasks({ tasks: 'no' })).toEqual([])
    expect(parseChangeTasks({ tasks: [{ title: ' T ', notes: { 'a.ts': ' why ', 'b.ts': 3 } }, { notes: {} }, 7] })).toEqual([{ title: 'T', notes: { 'a.ts': 'why' } }])
    expect(changesPath('/p')).toBe('/p/.archrift/changes.json')
    expect(changesPath('/p', '/tools/configs/app.json')).toBe('/tools/configs/app.changes.json')
  })

  it('pin each finding to its file: a cycle to each member, a grown limit with its numbers, fixed ones as good news, a document to check', () => {
    const v = (rule: string, from: string, extra: object = {}) => ({ rule, severity: 'error' as const, message: `${from} …`, from: `f:${from}`, to: `f:${from}`, targets: ['web'], ...extra })
    const f = findingsByFile({
      files: { added: [], removed: [] },
      rules: {
        added: [],
        grew: [{ before: v('small', 'src/x.ts', { measure: { metric: 'complexity', value: 12, bound: 'max', limit: 9, symbol: 's:src/x.ts#run' } }), after: v('small', 'src/x.ts', { measure: { metric: 'complexity', value: 14, bound: 'max', limit: 9, symbol: 's:src/x.ts#run' } }) }],
        fixed: [v('no-server', 'src/y.ts')],
        unmatched: [],
      },
      cycles: { added: [['f:src/a.ts', 'f:src/b.ts']], fixed: [] },
      jobs: [],
      blocks: { added: [], removed: [] },
      reach: { added: [{ from: 'src/p.tsx', to: 'src/big.ts', files: ['src/q.ts', 'src/r.ts'], packages: ['chart.js'], entries: ['src/page.tsx'], targets: ['web'] }], removed: [] },
      docs: [{ doc: 'docs/data.md', title: 'Data', line: 12, section: 'Storage', names: 'src/z.ts › save', path: 'src/z.ts', why: 'reshaped' }],
    })
    expect(f.get('src/x.ts')?.[0]).toMatchObject({ kind: 'grew', tone: 'error', text: "small: run's complexity 12 → 14 (max 9)" })
    expect(f.get('src/y.ts')?.[0]).toMatchObject({ kind: 'fixed', tone: 'good' })
    expect([f.get('src/a.ts')?.[0].text, f.get('src/b.ts')?.[0].text]).toEqual(['in a new import cycle of 2 files', 'in a new import cycle of 2 files'])
    expect(f.get('src/p.tsx')?.[0].text).toBe('importing src/big.ts brings 2 files and chart.js into 1 entry point')
    expect(f.get('src/z.ts')?.[0]).toMatchObject({ kind: 'docs', tone: 'warn', text: 'docs/data.md § Storage (line 12) names src/z.ts › save, which changed shape: does it still hold?' })
    expect(worstTone(f.get('src/y.ts'))).toBe('good')
    expect(worstTone(undefined)).toBeUndefined()
  })
})
