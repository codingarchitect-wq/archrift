import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyzer/analyze.ts'
import { ConfigSchema } from '../../src/analyzer/config.ts'
import { DEFAULT_HISTORY, parseLog, summarizeHistory } from '../../src/analyzer/history.ts'
import type { Commit } from '../../src/analyzer/history.ts'
import { pickRevisions, takeSnapshots } from '../../src/analyzer/snapshots.ts'
import type { Graph } from '../../src/core/model.ts'
import { decodeGraph, encodeGraph } from '../../src/core/serialize.ts'
import type { SerializedGraph } from '../../src/core/serialize.ts'
import { startServer } from '../../src/server/server.ts'
import { makeHistoryRepo } from '../helpers/history-repo.ts'

const unix = (iso: string) => Date.parse(iso) / 1000

describe('parseLog', () => {
  it('reads commits, line counts, binary files and renames', () => {
    const text =
      '\x1eaaa\x1f200\x1fAda\x1fsecond\0\n3\t1\tsrc/a.ts\0-\t-\tlogo.png\0' +
      '2\t0\t\0src/b.ts\0src/lib/b.ts\0' +
      '\x1ebbb\x1f100\x1fBo\x1ffirst: with\ttabs\0\n5\t0\tsrc/a.ts\0'
    expect(parseLog(text)).toEqual([
      {
        sha: 'aaa',
        time: 200,
        author: 'Ada',
        subject: 'second',
        files: [
          { path: 'src/a.ts', added: 3, deleted: 1 },
          { path: 'logo.png', added: 0, deleted: 0 },
          { path: 'src/lib/b.ts', from: 'src/b.ts', added: 2, deleted: 0 },
        ],
      },
      { sha: 'bbb', time: 100, author: 'Bo', subject: 'first: with\ttabs', files: [{ path: 'src/a.ts', added: 5, deleted: 0 }] },
    ])
  })
})

describe('summarizeHistory', () => {
  const day = 86_400
  const commit = (i: number, author: string, files: [string, number, string?][]): Commit => ({
    sha: `c${i}`,
    time: i * day,
    author,
    subject: '',
    files: files.map(([p, n, from]) => ({ path: p, added: n, deleted: 0, ...(from ? { from } : {}) })),
  })
  // newest first, as git log gives them
  const commits = [
    commit(100, 'Ada', [['x.ts', 10], ['y.ts', 1]]),
    commit(90, 'Bo', [['x.ts', 5], ['y.ts', 5]]),
    commit(50, 'Ada', [['y.ts', 0, 'old-y.ts'], ['x.ts', 7]]), // y.ts used to be old-y.ts
    commit(40, 'Ada', [['x.ts', 1], ['old-y.ts', 1], ['gone.ts', 1]]),
    commit(30, 'Ada', Array.from({ length: 40 }, (_, i) => [`f${i}.ts`, 1] as [string, number]).concat([['x.ts', 1], ['y.ts', 1]])),
  ]
  const current = new Set(['x.ts', 'y.ts', 'z.ts'])

  it('counts commits, authors and the first and last change per file, following renames', () => {
    const h = summarizeHistory(commits, current, 'head', { ...DEFAULT_HISTORY, windowDays: 30 })
    expect(h.files.get('x.ts')).toEqual({ commits: 5, churn: 15, authors: 2, lastCommit: 100 * day, firstCommit: 30 * day })
    // the commits under its old name count; the window (30 days before the newest commit) holds only two
    expect(h.files.get('y.ts')).toEqual({ commits: 5, churn: 6, authors: 2, lastCommit: 100 * day, firstCommit: 30 * day })
    expect(h.files.has('z.ts')).toBe(false)
    expect(h).toMatchObject({ head: 'head', commits: 5, authors: 2, since: 30 * day, until: 100 * day })
  })

  it('pairs files that change together, skipping mass edits', () => {
    const h = summarizeHistory(commits, current, 'head')
    // four commits with both; the 42-file one doesn't count
    expect(h.coChanges).toEqual([{ a: 'x.ts', b: 'y.ts', support: 4, confidence: 1 }])
    expect(summarizeHistory(commits, current, 'head', { ...DEFAULT_HISTORY, minSupport: 5 }).coChanges).toEqual([])
    expect(summarizeHistory(commits, current, 'head', { ...DEFAULT_HISTORY, maxFilesPerCommit: 50 }).coChanges[0].support).toBe(5)
  })
})

describe('git history of a repository', () => {
  let repo = ''
  let out = ''
  let shas: string[] = []
  let graph: Graph
  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-history-'))
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-history-out-'))
    shas = makeHistoryRepo(repo)
    graph = await analyze({ root: repo, cacheDir: path.join(out, 'cache') })
  })
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  })
  const node = (id: string) => graph.nodes.find(n => n.id === id)!

  it('adds commits, churn, authors, the last change and hotspots to files', () => {
    expect(graph.meta.history).toMatchObject({ head: shas.at(-1), commits: 6, authors: 1, since: unix('2026-01-05T10:00:00Z'), until: unix('2026-06-01T10:00:00Z'), windowDays: 90 })
    const a = node('f:src/a.ts').metrics!
    expect(a).toMatchObject({ commits: 5, authors: 1, lastCommit: unix('2026-05-04T10:00:00Z') })
    // the last 90 days hold commits 4–6: a.ts grew by 2 branches, then 6 (a line each)
    expect(a.churn).toBe(8)
    expect(a.hotspot).toBe(a.churn * a.complexity)
    // b.ts's history before the move counts, back to when it was written
    expect(node('f:src/lib/b.ts').metrics).toMatchObject({ commits: 5, lastCommit: unix('2026-05-04T10:00:00Z'), firstCommit: unix('2026-01-05T10:00:00Z') })
    expect(node('f:src/d.ts').metrics?.firstCommit).toBe(unix('2026-05-04T10:00:00Z'))
  })

  it('links files that change together with weighted co-change edges', () => {
    const co = graph.edges.filter(e => e.kind === 'co-changes')
    expect(co.map(e => [e.source, e.target, e.count, e.weight])).toEqual([['f:src/a.ts', 'f:src/lib/b.ts', 5, 1]])
    // no import between them: hidden coupling
    expect(graph.edges.some(e => e.kind === 'imports' && [e.source, e.target].sort().join() === 'f:src/a.ts,f:src/lib/b.ts')).toBe(false)
    expect(graph.meta.counts['edges.co-changes']).toBe(1)
    const round = decodeGraph(encodeGraph(graph).graph)
    expect(round.edges.find(e => e.kind === 'co-changes')?.weight).toBe(1)
  })

  it('reads the log once per HEAD', async () => {
    const cached = JSON.parse(fs.readFileSync(path.join(out, 'cache', 'git-log.json'), 'utf8'))
    expect(cached.head).toBe(shas.at(-1))
    expect(cached.commits).toHaveLength(6)
    const again = await analyze({ root: repo, cacheDir: path.join(out, 'cache') })
    expect(again.meta.history).toEqual(graph.meta.history)
  })

  it('picks snapshots spread over time, analyzes them in a worktree and cleans up', async () => {
    const revisions = pickRevisions(repo, 3)
    expect(revisions.map(r => r.subject)).toEqual(['start', 'a and b', 'move b into lib'])
    const dir = path.join(out, 'snapshots')
    const list = await takeSnapshots({ root: repo, config: ConfigSchema.parse({}), dir, revisions })
    expect(list.map(s => [s.sha, s.files])).toEqual([
      [shas[0], 3],
      [shas[1], 3],
      [shas[3], 3],
    ])
    const moved = decodeGraph(JSON.parse(fs.readFileSync(path.join(dir, `${shas[3]}.json`), 'utf8')) as SerializedGraph)
    expect(moved.meta.snapshot).toMatchObject({ sha: shas[3], subject: 'move b into lib' })
    expect(moved.nodes.some(n => n.id === 'f:src/lib/b.ts')).toBe(true)
    expect(moved.nodes.some(n => n.id === 'f:src/d.ts')).toBe(false)
    // the worktree is gone, and a second run has nothing to do
    expect(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(1)
    const again = await takeSnapshots({ root: repo, config: ConfigSchema.parse({}), dir, revisions: [{ ...revisions[0], rev: 'first' }] })
    expect(again.map(s => s.rev)).toEqual(['first', shas[1], shas[3]])
  })

  it('serves snapshots, and their sources from git', async () => {
    const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-viewer-'))
    fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html>')
    const server = await startServer({ root: repo, graph, port: 0, viewerDir, snapshotsDir: path.join(out, 'snapshots') })
    const port = (server.address() as AddressInfo).port
    const get = (p: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => {
            let body = ''
            res.on('data', c => (body += c))
            res.on('end', () => resolve({ status: res.statusCode!, body }))
          })
          .on('error', reject)
      })
    try {
      const list = JSON.parse((await get('/api/snapshots')).body)
      expect(list.map((s: { sha: string }) => s.sha)).toEqual([shas[0], shas[1], shas[3]])
      const then = decodeGraph(JSON.parse((await get(`/api/overview?snapshot=${shas[0]}`)).body))
      expect(then.nodes.some(n => n.id === 'f:src/b.ts')).toBe(true)
      const source = JSON.parse((await get(`/api/source?path=src/a.ts&snapshot=${shas[0]}`)).body)
      expect(source.total).toBe(8) // 4 branches then; 20 now
      expect((await get(`/api/source?path=src/d.ts&snapshot=${shas[0]}`)).status).toBe(404)
      expect((await get('/api/overview?snapshot=HEAD')).status).toBe(404)
      const file = JSON.parse((await get(`/api/file?id=${encodeURIComponent('f:src/b.ts')}&snapshot=${shas[1]}`)).body)
      expect(file.symbols.map((s: { name: string }) => s.name)).toEqual(['b'])
    } finally {
      server.close()
      fs.rmSync(viewerDir, { recursive: true, force: true })
    }
  })
})
