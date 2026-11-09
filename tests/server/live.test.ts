import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/analyzer/config.ts'
import { startSession } from '../../src/analyzer/isolated.ts'
import type { AnalysisSession } from '../../src/analyzer/isolated.ts'
import { dumpGraph } from '../../src/core/dump.ts'
import type { Graph } from '../../src/core/model.ts'
import { applyPatch } from '../../src/core/patch.ts'
import type { GraphPatch } from '../../src/core/patch.ts'
import { decodeGraph, encodeGraph } from '../../src/core/serialize.ts'
import { LiveGraph } from '../../src/server/live.ts'
import { startServer } from '../../src/server/server.ts'
import { analyzeFixture, copyFixture } from '../helpers/fixtures.ts'

// watch mode end to end, minus the file watcher: a session re-analyzes a
// copy of plain-ts after edits, the server turns each graph into a patch
let root = ''
let viewerDir = ''
let server: http.Server
let port = 0
let session: AnalysisSession
let first: Graph
const live = new LiveGraph()

beforeAll(async () => {
  root = copyFixture('plain-ts')
  viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-viewer-'))
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html>')
  const started = await startSession({ root, config: loadConfig(root), cacheDir: false, history: false })
  session = started.session
  first = started.graph
  server = await startServer({ root, graph: first, port: 0, viewerDir, live })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await session.close()
  server.closeAllConnections()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(viewerDir, { recursive: true, force: true })
})

const get = (p: string) =>
  new Promise<string>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => {
        let body = ''
        res.on('data', c => (body += c))
        res.on('end', () => resolve(body))
      })
      .on('error', reject)
  })

/** Server-Sent Events from /api/events, as they arrive. */
function listen() {
  const events: { event: string; data: unknown }[] = []
  let buffer = ''
  const waiters: (() => void)[] = []
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` } }, res => {
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (event && data) events.push({ event, data: JSON.parse(data) })
        waiters.splice(0).forEach(w => w())
      }
    })
  })
  const next = async (event: string) => {
    for (;;) {
      const hit = events.find(e => e.event === event)
      if (hit) {
        events.splice(events.indexOf(hit), 1)
        return hit.data
      }
      await new Promise<void>(r => waiters.push(r))
    }
  }
  return { next, close: () => req.destroy() }
}

describe('watch mode', () => {
  it('pushes a patch that turns the old overview into the new one', async () => {
    const events = listen()
    expect(await events.next('hello')).toEqual({ version: 1, live: true })
    const before = decodeGraph(JSON.parse(await get('/api/overview')))
    expect(JSON.parse(await get('/api/info'))).toMatchObject({ version: 1, live: true })

    // a new function in util.ts that app.ts starts calling
    fs.appendFileSync(path.join(root, 'src/util.ts'), '\nexport function twice(n: number) {\n  return n * 2\n}\n')
    const app = path.join(root, 'src/app.ts')
    fs.writeFileSync(app, `import { twice } from './util'\n${fs.readFileSync(app, 'utf8')}\nexport const doubled = twice(2)\n`)
    const { graph, ms } = await session.update()
    live.publish({ graph, ms })

    const patch = (await events.next('patch')) as GraphPatch & { ms: number }
    expect(patch).toMatchObject({ from: 1, to: 2 })
    expect(patch.files).toEqual(expect.arrayContaining(['f:src/app.ts', 'f:src/util.ts']))
    const after = decodeGraph(JSON.parse(await get('/api/overview')))
    const patched = applyPatch(before, patch)
    // through the wire format, which fixes the order of keys
    const key = (g: Graph) => {
      const d = decodeGraph(encodeGraph(g).graph)
      return JSON.stringify({ nodes: [...d.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: d.edges.map(e => JSON.stringify(e)).sort() })
    }
    expect(key(patched)).toBe(key(after))
    expect(JSON.parse(await get('/api/info')).version).toBe(2)
    const details = JSON.parse(await get(`/api/file?id=${encodeURIComponent('f:src/util.ts')}`))
    expect(details.symbols.map((s: { name: string }) => s.name)).toContain('twice')
    events.close()
  })

  it('re-analyzes to the same graph a cold run gives', async () => {
    fs.rmSync(path.join(root, 'src/lazy.ts'))
    const { graph } = await session.update()
    live.publish({ graph, ms: 0 })
    const cold = await analyzeFixture('plain-ts', { root })
    expect(dumpGraph(graph)).toBe(dumpGraph(cold))
  })

  it("doesn't push anything when nothing changed", async () => {
    const events = listen()
    await events.next('hello')
    const { graph } = await session.update()
    live.publish({ graph, ms: 0 })
    const version = JSON.parse(await get('/api/info')).version
    expect(version).toBe(3)
    events.close()
  })
})
