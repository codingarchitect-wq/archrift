import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeGraph } from '../../src/core/serialize.ts'
import type { SerializedGraph } from '../../src/core/serialize.ts'
import { startServer } from '../../src/server/server.ts'
import type { ClassDiagram } from '../../src/core/classes.ts'
import type { ClassChoices, FileDetails, SearchHit } from '../../src/server/views.ts'
import { FIXTURES, analyzeFixture } from '../helpers/fixtures.ts'

let server: http.Server
let port = 0
let viewerDir = ''
const root = path.join(FIXTURES, 'plain-ts')

beforeAll(async () => {
  viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-viewer-'))
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><title>viewer</title>')
  server = await startServer({ root, graph: await analyzeFixture('plain-ts'), port: 0, viewerDir, viewsDir: path.join(viewerDir, 'views') })
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
  fs.rmSync(viewerDir, { recursive: true, force: true })
})

function request(method: string, pathname: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ method, host: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
const get = (pathname: string, headers: Record<string, string> = {}) => request('GET', pathname, headers)
const json = async <T>(pathname: string) => {
  const r = await get(pathname)
  expect(r.status).toBe(200)
  return JSON.parse(r.body.toString()) as T
}

describe('archrift API', () => {
  it('serves an overview with files and file-level edges only', async () => {
    const g = decodeGraph(await json<SerializedGraph>('/api/overview'))
    expect(new Set(g.nodes.map(n => n.kind))).toEqual(new Set(['directory', 'file']))
    expect(g.edges.every(e => e.source.startsWith('f:') && e.target.startsWith('f:'))).toBe(true)
    const calls = g.edges.find(e => e.source === 'f:src/app.ts' && e.target === 'f:src/util.ts' && e.kind === 'calls')
    expect(calls?.count).toBe(3)
  })

  it('gzips large responses when asked', async () => {
    const r = await get('/api/overview', { 'accept-encoding': 'gzip' })
    expect(r.headers['content-encoding']).toBe('gzip')
    expect(JSON.parse(zlib.gunzipSync(r.body).toString()).schemaVersion).toBe(1)
  })

  it('serves a file’s symbols in source order with the edges touching them', async () => {
    const d = await json<FileDetails>(`/api/file?id=${encodeURIComponent('f:src/shapes.ts')}`)
    expect(d.symbols.filter(s => s.kind === 'symbol').map(s => s.name)).toEqual(['Base', 'Circle', 'makeCircle'])
    const implementsEdge = d.edges.find(e => e.source === 's:src/shapes.ts#Base.area' && e.kind === 'implements')
    expect(implementsEdge?.sites).toEqual([6, 12])
    expect(d.edges.some(e => e.source === 's:src/app.ts#main' && e.target === 's:src/shapes.ts#makeCircle')).toBe(true)
    expect(d.endpoints.map(n => n.id)).toContain('s:src/app.ts#main')
    expect((await get('/api/file?id=f:nope.ts')).status).toBe(404)
  })

  it('serves the type families and folders, and a family’s or a folder’s class diagram', async () => {
    const choices = await json<ClassChoices>('/api/classes')
    expect(choices.families.map(f => `${f.name}: ${f.types.length}`)).toEqual(['Shape: 3'])
    expect(choices.folders).toEqual([{ path: 'src', types: 5 }])
    const family = await json<ClassDiagram>(`/api/classes?family=${encodeURIComponent('s:src/types.ts#Shape')}`)
    expect(family.types.map(t => t.name)).toEqual(['Shape', 'Base', 'Circle'])
    expect(family.relations.map(r => r.kind)).toEqual(['implements', 'extends'])
    const folder = await json<ClassDiagram>('/api/classes?folder=src')
    expect(folder.title).toBe('src')
    // by file, then in source order; the value-and-type Color is a value here
    expect(folder.types.map(t => `${t.kind} ${t.name}`)).toEqual(['abstract Base', 'class Circle', 'interface Shape', 'type Point', 'enum Unit'])
    expect((await json<ClassDiagram>('/api/classes?folder=nowhere')).types).toEqual([])
  })

  it('ranks exact names first in search', async () => {
    const hits = await json<SearchHit[]>('/api/search?q=circle')
    expect(hits[0].id).toBe('s:src/shapes.ts#Circle')
    expect(hits.map(h => h.id)).toContain('s:src/shapes.ts#makeCircle')
    expect((await json<SearchHit[]>('/api/search?q=mc')).map(h => h.id)).toContain('s:src/shapes.ts#makeCircle') // initials
  })

  it('reads source lines of known files only', async () => {
    const src = await json<{ lines: string[]; start: number; end: number }>('/api/source?path=src/util.ts&start=1&end=2')
    expect(src.lines).toEqual(['export function round(n: number, digits = 2): number {', '  const f = 10 ** digits'])
    expect((await get('/api/source?path=../../package.json')).status).toBe(404)
    expect((await get('/api/source?path=tsconfig.json')).status).toBe(404) // not a graph node
  })

  it('refuses foreign hosts and cross-site origins', async () => {
    expect((await get('/api/info', { host: 'evil.example:80' })).status).toBe(403)
    expect((await get('/api/info', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await get('/api/info', { origin: `http://localhost:${port}` })).status).toBe(200)
  })

  it('keeps saved views as JSON files, written only as JSON', async () => {
    const view = { name: 'Data layer: local vs cloud', state: { options: { view: 'layers' }, selected: 's:src/types.ts#Shape' } }
    expect((await request('POST', '/api/views', { 'content-type': 'text/plain' }, JSON.stringify(view))).status).toBe(415)
    expect((await request('POST', '/api/views', { 'content-type': 'application/json' }, '{"state":{}}')).status).toBe(400)
    expect((await request('POST', '/api/views', { 'content-type': 'application/json' }, JSON.stringify(view))).status).toBe(200)
    expect(fs.existsSync(path.join(viewerDir, 'views', 'data-layer-local-vs-cloud.json'))).toBe(true)
    expect(await json('/api/views')).toEqual([view])
    expect((await request('POST', '/api/views', { 'content-type': 'application/json', origin: 'https://evil.example' }, JSON.stringify(view))).status).toBe(403)
    expect((await request('DELETE', `/api/views?name=${encodeURIComponent(view.name)}`)).status).toBe(200)
    expect(await json('/api/views')).toEqual([])
    expect((await request('PUT', '/api/views')).status).toBe(405)
    expect((await request('POST', '/api/file')).status).toBe(405)
  })

  it('falls back to the viewer for any other path', async () => {
    const r = await get('/some/deep/link')
    expect(r.status).toBe(200)
    expect(r.body.toString()).toContain('<title>viewer</title>')
  })
})

describe('archrift API: descriptions', () => {
  let described: http.Server
  let dport = 0
  let dir = ''
  const file = () => path.join(dir, 'descriptions.json')
  const at = async <T>(pathname: string) => {
    const r = await new Promise<Buffer>((resolve, reject) =>
      http.get({ host: '127.0.0.1', port: dport, path: pathname, headers: { host: `127.0.0.1:${dport}` } }, res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      }).on('error', reject),
    )
    return JSON.parse(r.toString()) as T
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-described-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>viewer</title>')
    described = await startServer({ root, graph: await analyzeFixture('plain-ts'), port: 0, viewerDir: dir, descriptions: file() })
    dport = (described.address() as AddressInfo).port
  })

  afterAll(() => {
    described.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('serves none until the file is there, then each entry, stale ones marked, and reads it again when it changes', async () => {
    expect(await at('/api/descriptions')).toEqual({ entries: {}, orphans: [] })
    fs.writeFileSync(file(), JSON.stringify({ project: 'Shapes.', entries: { 'f:src/util.ts': { name: 'Helpers', summary: 'Small helpers the app calls.' }, 'f:src/shapes.ts': { summary: 'Shapes.', surface: 'old' }, 'f:src/gone.ts': { summary: 'x' } } }))
    expect(await at('/api/descriptions')).toEqual({
      project: 'Shapes.',
      entries: { 'f:src/util.ts': { name: 'Helpers', summary: 'Small helpers the app calls.' }, 'f:src/shapes.ts': { summary: 'Shapes.', stale: true } },
      orphans: ['f:src/gone.ts'],
    })
    fs.writeFileSync(file(), JSON.stringify({ entries: {} }))
    // the file's mtime may not move within a millisecond: give it one it can't miss
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file(), later, later)
    expect(await at('/api/descriptions')).toEqual({ entries: {}, orphans: [] })
  })

  it('finds a file by the name or the words written for it', async () => {
    fs.writeFileSync(file(), JSON.stringify({ entries: { 'f:src/util.ts': { name: 'Helpers', summary: 'Small helpers the app calls.' } } }))
    const later = new Date(Date.now() + 10000)
    fs.utimesSync(file(), later, later)
    const byName = await at<SearchHit[]>('/api/search?q=helpers')
    expect(byName[0]).toMatchObject({ id: 'f:src/util.ts', described: 'Helpers' })
    const byWords = await at<SearchHit[]>('/api/search?q=app%20calls')
    expect(byWords[0]).toMatchObject({ id: 'f:src/util.ts', described: 'Small helpers the app calls.' })
  })
})

describe('archrift API: the change in progress', () => {
  it('answers from the comparison it is given, once per graph version and range, a failure as 409; without one, 404; lists commits to pick from', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-changes-api-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>viewer</title>')
    const graph = await analyzeFixture('plain-ts')
    let calls = 0
    let fail = false
    let asked: unknown
    const report = { base: { sha: 'abc', label: 'HEAD (abc)' }, head: 'the working tree', files: [{ path: 'src/util.ts', status: 'modified' }], errors: 0, tasks: [], commits: [], diff: {} }
    const commits = [{ sha: 'abc', subject: 'start', author: 'Ada', date: 1 }]
    const s = await startServer({
      root,
      graph,
      port: 0,
      viewerDir: dir,
      commits: () => commits,
      changes: async (head, range) => {
        calls++
        asked = range
        expect(head.meta.name).toBe(graph.meta.name)
        if (fail) throw new Error('not in a git repository')
        return report as never
      },
    })
    const p = (s.address() as AddressInfo).port
    const ask = (q = '', route = '/api/changes') =>
      new Promise<{ status: number; body: unknown }>((resolve, reject) =>
        http.get({ host: '127.0.0.1', port: p, path: `${route}${q}`, headers: { host: `127.0.0.1:${p}` } }, res => {
          const chunks: Buffer[] = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }))
        }).on('error', reject),
      )
    try {
      expect(await ask()).toEqual({ status: 200, body: report })
      expect(asked).toEqual({})
      await ask()
      expect(calls).toBe(1) // the same graph: the same answer
      // the last commit: a range, compared anew
      await ask('?base=HEAD~1&head=HEAD')
      expect(asked).toEqual({ base: 'HEAD~1', head: 'HEAD' })
      expect(calls).toBe(2)
      // the commits to pick a range from
      expect(await ask('', '/api/commits')).toEqual({ status: 200, body: commits })
      fail = true
      expect(await ask('?fresh=1')).toEqual({ status: 409, body: { error: 'not in a git repository' } })
      expect(calls).toBe(3)
      expect((await get('/api/changes')).status).toBe(404) // the shared server has no comparison
      expect((await get('/api/commits')).status).toBe(404)
    } finally {
      s.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('archrift API: asking', () => {
  it('streams the agent’s steps, then its answer; says in /api/info whether it can ask, and refuses what isn’t a question', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-ask-api-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>viewer</title>')
    const graph = await analyzeFixture('plain-ts')
    let asked: unknown
    let available = true
    const status = { get available() { return available }, engine: 'Claude Code', why: 'no claude' }
    const s = await startServer({
      root,
      graph,
      port: 0,
      viewerDir: dir,
      ask: {
        status,
        run: async (input, onProgress) => {
          asked = input
          onProgress('Reading src/app.ts')
          if (input.question === 'fail') throw new Error('Not logged in')
          return { question: input.question, title: 'T', answer: 'A', nodes: [], steps: [], followUps: [], refs: {}, unknown: [] }
        },
      },
    })
    const p = (s.address() as AddressInfo).port
    const post = (body: string, type = 'application/json', method = 'POST') =>
      new Promise<{ status: number; type?: string; text: string }>((resolve, reject) => {
        const req = http.request({ method, host: '127.0.0.1', port: p, path: '/api/ask', headers: { host: `127.0.0.1:${p}`, 'content-type': type } }, res => {
          const chunks: Buffer[] = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'], text: Buffer.concat(chunks).toString() }))
        })
        req.on('error', reject)
        req.end(body)
      })
    try {
      const info = await new Promise<string>((resolve, reject) =>
        http.get({ host: '127.0.0.1', port: p, path: '/api/info', headers: { host: `127.0.0.1:${p}` } }, res => {
          let t = ''
          res.on('data', c => (t += c))
          res.on('end', () => resolve(t))
        }).on('error', reject),
      )
      expect(JSON.parse(info).ask).toEqual({ available: true, engine: 'Claude Code', why: 'no claude' })
      const ok = await post(JSON.stringify({ question: ' How does it start? ', context: { view: 'city' } }))
      expect(ok.status).toBe(200)
      expect(ok.type).toMatch(/application\/x-ndjson/)
      expect(ok.text.trim().split('\n').map(l => JSON.parse(l))).toEqual([
        { type: 'progress', text: 'Reading src/app.ts' },
        { type: 'answer', answer: { question: 'How does it start?', title: 'T', answer: 'A', nodes: [], steps: [], followUps: [], refs: {}, unknown: [] } },
      ])
      expect(asked).toEqual({ question: 'How does it start?', context: { view: 'city' } })
      const failed = await post(JSON.stringify({ question: 'fail' }))
      expect(failed.text.trim().split('\n').at(-1)).toBe(JSON.stringify({ type: 'error', error: 'Not logged in' }))
      expect((await post(JSON.stringify({ question: '' }))).status).toBe(400)
      expect((await post(JSON.stringify({ question: 'x'.repeat(2001) }))).status).toBe(400)
      expect((await post('question=x', 'application/x-www-form-urlencoded')).status).toBe(415)
      expect((await post('', 'application/json', 'GET')).status).toBe(405)
      available = false
      expect(await post(JSON.stringify({ question: 'Q' }))).toMatchObject({ status: 409, text: JSON.stringify({ error: 'no claude' }) })
    } finally {
      s.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
