// `archrift export html`: one HTML file with the viewer and the project's graph
// inside. The template here is a stand-in for the built one (dist/static), with
// the mark where the data goes; tests/e2e/export-html.spec.ts opens real ones.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { runExport, startLink } from '../../src/cli/export-html.ts'
import { HOME_DIR } from '../../src/cli/projects.ts'
import { decodeGraph } from '../../src/core/serialize.ts'
import { EMBED, EMBED_MARK } from '../../src/server/embed.ts'
import type { EmbedPart, ExportGraph, ExportMeta } from '../../src/server/embed.ts'
import { copyFixture } from '../helpers/fixtures.ts'

const CLI = path.resolve(import.meta.dirname, '../../src/cli/main.ts')
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix = 'archrift-export-') => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(d)
  return d
}
const fixture = (name: string) => {
  const d = copyFixture(name)
  dirs.push(d)
  return d
}

const HIGHLIGHTER = 'export const tokenize = async () => undefined'

/** A built static viewer's stand-in: a template with the mark, and a highlighter. */
function staticDir() {
  const dir = tmp('archrift-static-')
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><title>archrift</title></head><body><div id="ui"></div>${EMBED_MARK}</body></html>`)
  fs.writeFileSync(path.join(dir, 'highlight.js'), HIGHLIGHTER)
  return dir
}

const part = (html: string, name: EmbedPart) => html.match(new RegExp(`id="${EMBED[name]}">([^<]*)</script>`))?.[1]
const unzip = (base64: string) => zlib.gunzipSync(Buffer.from(base64, 'base64')).toString('utf8')
const metaOf = (html: string) => JSON.parse(part(html, 'meta')!) as ExportMeta
/** The page as a reader of its data would see it: the HTML and every part decompressed. */
const readable = (html: string) => [html, ...(['graph', 'source'] as const).flatMap(p => (part(html, p) ? [unzip(part(html, p)!)] : []))].join('\n')
const graphOf = (html: string) => {
  const { graph, sites } = JSON.parse(unzip(part(html, 'graph')!)) as ExportGraph
  return decodeGraph(graph, sites)
}

describe('archrift export html', () => {
  it("writes the project's graph, its saved views and the chosen view into the page, and no source", async () => {
    const root = fixture('fullstack')
    fs.mkdirSync(path.join(root, '.archrift', 'views'), { recursive: true })
    fs.writeFileSync(path.join(root, '.archrift', 'views', 'pages.json'), JSON.stringify({ name: 'Pages', state: { options: { view: 'transit' }, selected: null } }))
    const r = await runExport({ root, view: 'wheel', history: false, staticDir: staticDir() })

    // beside the project's graph, named after it: the config is in the project's .archrift/
    expect(r.file).toBe(path.join(root, '.archrift', `${path.basename(root)}.html`))
    const html = fs.readFileSync(r.file, 'utf8')
    expect(r.bytes).toBe(Buffer.byteLength(html))
    expect(html).toContain(`<title>${path.basename(root)} · archrift</title>`)
    expect(html).not.toContain(EMBED_MARK)

    const meta = metaOf(html)
    expect(meta.start).toBe('?view=wheel')
    expect(meta.views).toEqual([{ name: 'Pages', state: { options: { view: 'transit' }, selected: null } }])
    expect(meta.info).toMatchObject({ root: '', live: false, version: 1, targets: ['default'] })

    const graph = graphOf(html)
    expect(graph.nodes.some(n => n.id === 's:src/server/routers/accounts.ts#accountsRouter')).toBe(true)
    expect(graph.sites.some(s => s.length > 0)).toBe(true)
    expect(meta.info.counts.files).toBe(graph.nodes.filter(n => n.kind === 'file').length)

    expect(part(html, 'source')).toBeUndefined()
    expect(part(html, 'highlighter')).toBeUndefined()
    expect(readable(html)).not.toContain(root) // nothing of the local folder: the file gets shared
  })

  it("with --source: every file's text, and the highlighter", async () => {
    const root = fixture('fullstack')
    const out = path.join(tmp(), 'page.html')
    const r = await runExport({ root, out, source: true, history: false, staticDir: staticDir() })
    expect(r.file).toBe(out)
    const html = fs.readFileSync(out, 'utf8')
    const texts = JSON.parse(unzip(part(html, 'source')!)) as Record<string, string>
    const files = graphOf(html).nodes.filter(n => n.kind === 'file')
    expect(Object.keys(texts).sort()).toEqual(files.map(f => f.path!).sort())
    expect(texts['src/server/routers/accounts.ts']).toBe(fs.readFileSync(path.join(root, 'src/server/routers/accounts.ts'), 'utf8'))
    expect(unzip(part(html, 'highlighter')!)).toBe(HIGHLIGHTER)
    expect(Object.keys(r.parts).sort()).toEqual(['graph', 'highlighter', 'source'])
  })

  it("reads a mount's files for --source, and leaves its folder out of the page", async () => {
    const root = tmp('archrift-app-')
    const infra = tmp('archrift-infra-')
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(infra, 'up.sh'), '#!/bin/bash\nkafka-topics.sh --create --topic orders\n')
    fs.mkdirSync(path.join(root, '.archrift'))
    fs.writeFileSync(path.join(root, '.archrift', 'config.json'), JSON.stringify({ name: 'mounted', mounts: { infra } }))
    const r = await runExport({ root, source: true, history: false, staticDir: staticDir() })
    const html = fs.readFileSync(r.file, 'utf8')
    expect(path.basename(r.file)).toBe('mounted.html')
    const texts = JSON.parse(unzip(part(html, 'source')!)) as Record<string, string>
    expect(texts['infra/up.sh']).toBe('#!/bin/bash\nkafka-topics.sh --create --topic orders\n')
    expect(texts['src/a.ts']).toBe('export const a = 1\n')
    expect(graphOf(html).meta.mounts).toBeUndefined()
    expect(readable(html)).not.toContain(infra)
    expect(readable(html)).not.toContain(root)
  })

  it("goes to archrift's home folder, projects/<name>/, for a project without a config of its own", async () => {
    const root = fixture('plain-ts')
    const name = path.basename(root)
    dirs.push(path.join(HOME_DIR, 'projects', name))
    const r = await runExport({ root, history: false, staticDir: staticDir() })
    expect(r.file).toBe(path.join(HOME_DIR, 'projects', name, `${name}.html`))
    expect(r.view).toBe('city')
    expect(metaOf(fs.readFileSync(r.file, 'utf8')).start).toBe('')
  })

  it('asks for the build when the static viewer is missing, before analyzing anything', async () => {
    const empty = tmp()
    await expect(runExport({ root: fixture('plain-ts'), staticDir: empty })).rejects.toThrow(/run `npm run build`/)
    fs.writeFileSync(path.join(empty, 'index.html'), `<html><body>${EMBED_MARK}</body></html>`)
    await expect(runExport({ root: fixture('plain-ts'), source: true, staticDir: empty })).rejects.toThrow(/highlight\.js missing/)
  })

  it('refuses a template from before the mark', async () => {
    const dir = staticDir()
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body></body></html>')
    await expect(runExport({ root: fixture('plain-ts'), history: false, staticDir: dir })).rejects.toThrow(/no place for the data/)
  })
})

describe('the view an export opens on', () => {
  it("a view's id, or a viewer link whose options and selection carry over (not its timeline or project)", () => {
    expect(startLink('wheel')).toEqual({ link: '?view=wheel', view: 'wheel' })
    expect(startLink('city')).toEqual({ link: '', view: 'city' })
    expect(startLink(undefined)).toEqual({ link: '', view: 'city' })
    expect(startLink('http://127.0.0.1:4300/?view=matrix&group=feature&color=hotspot&timeline=true&at=abc&project=fp#n=f%3Asrc%2Fa.ts')).toEqual({
      link: '?view=matrix&group=feature&color=hotspot#n=f%3Asrc%2Fa.ts',
      view: 'matrix',
    })
    expect(startLink('?view=tree&tests=true').link).toBe('?view=tree&tests=true')
  })

  it('says when it knows no such view (the page then shows the City)', () => {
    const said: string[] = []
    startLink('whel', m => said.push(m))
    expect(said.join()).toMatch(/no view "whel" \(city, layers, galaxy, .*wheel/)
    startLink('wheel', m => said.push(m))
    expect(said).toHaveLength(1)
  })
})

describe('the command line', () => {
  it('names the formats it writes when asked for another', () => {
    const r = cli('export', 'pdf')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('archrift export: html or archify')
  })

  it('finds a project by name in the list', () => {
    const r = cli('export', 'html', '--project', 'no-such-project', '--projects', path.join(tmp(), 'projects.json'))
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no project named no-such-project/)
  })
})
