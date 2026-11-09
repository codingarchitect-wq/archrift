import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectHub } from '../../src/cli/hub.ts'
import { ProjectList } from '../../src/cli/projects.ts'
import { decodeGraph } from '../../src/core/serialize.ts'
import { startServer } from '../../src/server/server.ts'
import { FIXTURES } from '../helpers/fixtures.ts'

// the project switcher end to end: a hub over two fixtures behind the real server
let dir = ''
let server: http.Server
let port = 0
let hub: ProjectHub

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-hub-'))
  const viewerDir = path.join(dir, 'viewer')
  fs.mkdirSync(viewerDir)
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html>')
  const list = new ProjectList(path.join(dir, 'projects.json'))
  for (const name of ['plain-ts', 'fullstack']) list.add({ root: path.join(FIXTURES, name), out: path.join(dir, name, 'graph.json') })
  hub = new ProjectHub(list, { watch: false, cache: false, history: false, log: () => {} })
  const { graph, project } = await hub.load('plain-ts')
  server = await startServer({ root: project.root, graph, port: 0, viewerDir, viewsDir: project.views, snapshotsDir: project.snapshots, projects: hub })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await hub.close()
  server.closeAllConnections()
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function request(method: string, p: string, body?: unknown) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request(
      { method, host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } },
      res => {
        let text = ''
        res.on('data', c => (text += c))
        res.on('end', () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }))
      },
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

/** The next `project` event on /api/events with the given state. */
function projectEvent(state: string) {
  return new Promise<any>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` } }, res => {
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        for (const block of buffer.split('\n\n')) {
          if (!block.includes('event: project')) continue
          const data = JSON.parse(/^data: (.*)$/m.exec(block)![1])
          if (data.state === state) {
            req.destroy()
            resolve(data)
          }
        }
      })
    })
    req.on('error', reject)
  })
}

describe('the project switcher', () => {
  it('lists the projects, the open one marked', async () => {
    const { json } = await request('GET', '/api/projects')
    expect(json.active).toBe('plain-ts')
    expect(json.projects.map((p: { name: string; active: boolean }) => [p.name, p.active])).toEqual([
      ['plain-ts', true],
      ['fullstack', false],
    ])
    expect(json.projects[0].analyzedAt).toMatch(/^\d{4}-/)
    expect((await request('GET', '/api/info')).json).toMatchObject({ name: 'plain-ts', project: 'plain-ts' })
  })

  it('opens another project: progress, then everything answers for it', async () => {
    const opened = projectEvent('open')
    const progress = projectEvent('opening')
    const r = await request('POST', '/api/projects/open', { name: 'fullstack' })
    expect(r.status).toBe(202)
    expect(await progress).toMatchObject({ name: 'fullstack' })
    expect(await opened).toMatchObject({ name: 'fullstack', version: 2 })
    expect((await request('GET', '/api/info')).json).toMatchObject({ name: 'fullstack', project: 'fullstack', version: 2 })
    const overview = decodeGraph((await request('GET', '/api/overview')).json)
    expect(overview.nodes.some(n => n.id === 'f:src/server/routers/accounts.ts')).toBe(true)
    // sources come from the open project's folder
    expect((await request('GET', '/api/source?path=src/server/trpc.ts&start=1&end=1')).status).toBe(200)
    expect((await request('GET', '/api/source?path=src/app.ts&start=1&end=1')).status).toBe(404)
  })

  it('reports a project that fails to open, and leaves the open one alone', async () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ "targets": { "web": { "moduleSufixes": [""] } } }')
    const list = new ProjectList(path.join(dir, 'projects.json'))
    list.add({ root: path.join(FIXTURES, 'js-only'), config: path.join(dir, 'bad.json'), out: path.join(dir, 'js-only', 'graph.json') })
    const failed = projectEvent('failed')
    await request('POST', '/api/projects/open', { name: 'js-only' })
    expect((await failed).error).toMatch(/invalid config/)
    expect((await request('GET', '/api/info')).json.project).toBe('fullstack')
  })

  it('adds a folder, refuses what is not one, and keeps the open project', async () => {
    const added = await request('POST', '/api/projects', { root: path.join(FIXTURES, 'react-tsx') })
    expect(added).toMatchObject({ status: 200, json: { name: 'react-tsx', active: false } })
    expect(await request('POST', '/api/projects', { root: path.join(FIXTURES, 'nowhere') })).toMatchObject({ status: 400, json: { error: expect.stringMatching(/not a folder/) } })
    expect(await request('POST', '/api/projects', {})).toMatchObject({ status: 400 })
    expect(await request('DELETE', '/api/projects?name=fullstack')).toMatchObject({ status: 400, json: { error: expect.stringMatching(/is open/) } })
    const removed = await request('DELETE', '/api/projects?name=react-tsx')
    expect(removed.json.projects.map((p: { name: string }) => p.name)).not.toContain('react-tsx')
  })

  it('takes JSON only, from a local page only', async () => {
    const form = await new Promise<number>(resolve => {
      const req = http.request(
        { method: 'POST', host: '127.0.0.1', port, path: '/api/projects/open', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' } },
        res => resolve(res.statusCode!),
      )
      req.end('name=plain-ts')
    })
    expect(form).toBe(415)
    const foreign = await new Promise<number>(resolve => {
      const req = http.request(
        { method: 'POST', host: '127.0.0.1', port, path: '/api/projects', headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'application/json' } },
        res => resolve(res.statusCode!),
      )
      req.end('{"root":"/"}')
    })
    expect(foreign).toBe(403)
  })
})
