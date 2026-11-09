// An exported page answers the viewer's calls in the browser (src/viewer/static):
// for the same graph, the same answers as `archrift serve`. The page's data goes
// the whole way here: written by the exporter, read back from the page's
// script elements, decompressed as the browser does.
import fs from 'node:fs'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageParts } from '../../src/cli/export-html.ts'
import type { ResolvedDescriptions } from '../../src/core/descriptions.ts'
import type { Graph } from '../../src/core/model.ts'
import { decodeGraph } from '../../src/core/serialize.ts'
import type { SerializedGraph } from '../../src/core/serialize.ts'
import { EMBED, NO_SOURCE, embedTags } from '../../src/server/embed.ts'
import type { EmbedPart } from '../../src/server/embed.ts'
import { startServer } from '../../src/server/server.ts'
import { infoOf } from '../../src/server/views.ts'
import type { Api } from '../../src/viewer/api.ts'
import { createStaticApi } from '../../src/viewer/static/backend.ts'
import { openAtStart, readExport } from '../../src/viewer/static/embedded.ts'
import { FIXTURES, analyzeFixture } from '../helpers/fixtures.ts'

const root = path.join(FIXTURES, 'fullstack')
let graph: Graph
let server: http.Server
let base = ''
let viewerDir = ''

/** A page's parts, found the way the browser finds them: by the element's id. */
const readerOf = (html: string) => (part: EmbedPart) => html.match(new RegExp(`id="${EMBED[part]}">([^<]*)</script>`))?.[1]

const files = () => graph.nodes.filter(n => n.kind === 'file')
const texts = () => Object.fromEntries(files().map(f => [f.path!, fs.readFileSync(path.join(root, f.path!), 'utf8')]))

/** The static backend over an exported page of the graph: with the files' text, or without. */
function exported(withSource: boolean, descriptions?: ResolvedDescriptions): Api {
  const meta = { info: infoOf(graph, { root: '', version: 1, live: false }), views: [{ name: 'Wheel', state: { options: { view: 'wheel' }, selected: null } }], start: '', exportedAt: '', ...(descriptions ? { descriptions } : {}) }
  const html = embedTags(meta, pageParts(graph, withSource ? texts() : undefined, withSource ? 'export const tokenize = () => undefined' : undefined))
  return createStaticApi(readExport(readerOf(html)).data)
}

const json = async <T>(pathname: string): Promise<T> => {
  const res = await fetch(`${base}${pathname}`)
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

beforeAll(async () => {
  graph = await analyzeFixture('fullstack')
  viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-static-'))
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><title>viewer</title>')
  server = await startServer({ root, graph, port: 0, viewerDir })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(viewerDir, { recursive: true, force: true })
})

describe('an exported page answers like the server', () => {
  const api = () => exported(true)

  it('the overview', async () => {
    const fromServer = decodeGraph(await json<SerializedGraph>('/api/overview'))
    const fromPage = await api().overview()
    expect(fromPage.nodes.length).toBeGreaterThan(10)
    expect(fromPage).toEqual(fromServer)
  })

  it("every file's details: symbols, references with their sites, the other ends", async () => {
    const page = api()
    for (const f of files()) {
      const fromPage = await page.file(f.id)
      expect(fromPage).toEqual(await json(`/api/file?id=${encodeURIComponent(f.id)}`))
    }
    const accounts = await page.file('f:src/server/routers/accounts.ts')
    expect(accounts.symbols.length).toBeGreaterThan(0)
    expect(accounts.edges.some(e => e.sites.length > 0)).toBe(true)
  })

  it('search, by name, initials and route', async () => {
    const page = api()
    for (const q of ['accounts', 'acc', 'Service', 'ds', 'health', 'x']) {
      expect(await page.search(q)).toEqual(await json(`/api/search?q=${encodeURIComponent(q)}`))
    }
    expect((await page.search('accounts')).length).toBeGreaterThan(0)
  })

  it("a file's lines, clamped the same way", async () => {
    const page = api()
    for (const f of files()) {
      for (const [start, end] of [[1, 12], [0, 100000], [3, 3]]) {
        expect(await page.source(f.path!, start, end)).toEqual(await json(`/api/source?path=${encodeURIComponent(f.path!)}&start=${start}&end=${end}`))
      }
    }
  })

  it('the class families and folders, and their diagrams', async () => {
    const page = api()
    const choices = await page.classChoices()
    expect(choices).toEqual(await json('/api/classes'))
    expect(choices.folders.length).toBeGreaterThan(0)
    for (const f of choices.families) expect(await page.classDiagram({ family: f.id })).toEqual(await json(`/api/classes?family=${encodeURIComponent(f.id)}`))
    for (const f of choices.folders) expect(await page.classDiagram({ folder: f.path })).toEqual(await json(`/api/classes?folder=${encodeURIComponent(f.path)}`))
  })

  it('what /api/info says, without the local folder', async () => {
    expect(await api().info()).toEqual({ ...(await json<object>('/api/info')), root: '' })
  })
})

describe('an exported page carries the descriptions', () => {
  it('as they were at export, in its answers and its search; none when there were none', async () => {
    const file = files().find(f => !f.tags?.includes('test'))!
    const descriptions: ResolvedDescriptions = { project: 'A shop.', entries: { [file.id]: { name: 'Checkout hub', summary: 'Where orders are put together.' } }, orphans: [] }
    const page = exported(false, descriptions)
    expect(await page.descriptions()).toEqual(descriptions)
    expect((await page.search('checkout hub'))[0]).toMatchObject({ id: file.id, described: 'Checkout hub' })
    expect(await exported(false).descriptions()).toEqual({ entries: {}, orphans: [] })
  })
})

describe('what an exported page leaves out', () => {
  it('says it can show no project list, timeline, live updates, saving, the change in progress or Ask, and refuses those calls', async () => {
    const page = exported(true)
    expect(page.capabilities).toEqual({ projects: false, snapshots: false, saveViews: false, live: false, source: true, changes: false, ask: false })
    await expect(page.changes()).rejects.toThrow(/archrift serve/)
    await expect(page.ask({ question: 'Q' }, () => {})).rejects.toThrow(/archrift serve/)
    await expect(page.saveView({ name: 'x', state: { options: {}, selected: null } })).rejects.toThrow(/archrift serve/)
    await expect(page.deleteView('Wheel')).rejects.toThrow(/archrift serve/)
    await expect(page.projects()).rejects.toThrow(/archrift serve/)
    await expect(page.overview('0123abcd')).rejects.toThrow(/no such snapshot/)
    expect(await page.snapshots()).toEqual([])
    expect(await page.views()).toEqual([{ name: 'Wheel', state: { options: { view: 'wheel' }, selected: null } }])
  })

  it("without --source: no source, and the panel's message says how to get it", async () => {
    const page = exported(false)
    expect(page.capabilities.source).toBe(false)
    await expect(page.source('src/app/page.tsx', 1, 10)).rejects.toThrow(NO_SOURCE)
    expect((await page.file('f:src/app/page.tsx')).symbols.length).toBeGreaterThan(0)
  })

  it('answers no file outside the graph', async () => {
    const page = exported(true)
    await expect(page.source('../../etc/passwd', 1, 10)).rejects.toThrow(/unknown file/)
    await expect(page.source('__proto__', 1, 10)).rejects.toThrow(/unknown file/)
    await expect(page.file('f:nope.ts')).rejects.toThrow(/no such file/)
  })
})

describe('the page opens on the view it was exported with', () => {
  const at = (search: string, hash: string) => {
    const calls: string[] = []
    openAtStart('?view=wheel#n=f%3Asrc%2Fa.ts', { pathname: '/x/app.html', search, hash }, { replaceState: (_s, _t, url) => void calls.push(String(url)) })
    return calls
  }

  it('until the link says otherwise (a reload keeps where the reader was)', () => {
    expect(at('', '')).toEqual(['/x/app.html?view=wheel#n=f%3Asrc%2Fa.ts'])
    expect(at('?view=matrix', '')).toEqual([])
    expect(at('', '#n=f%3Asrc%2Fb.ts')).toEqual([])
  })

  it('a page with no graph says what it is missing', () => {
    expect(() => readExport(() => undefined)).toThrow(/archrift export html/)
  })
})
