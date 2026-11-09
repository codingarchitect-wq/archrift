// `archrift export html`: the viewer and a project's graph in one HTML file,
// to open from disk with no server and no network (and to share). The static
// viewer's template comes from `npm run build` (vite.static.ts); this writes
// the graph, the saved views and the view to open on into a copy of it, and
// with --source the project's files and the syntax highlighter.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { analyzeIsolated } from '../analyzer/isolated.ts'
import { loadConfig } from '../analyzer/config.ts'
import { absPathOf } from '../analyzer/mounts.ts'
import type { Graph } from '../core/model.ts'
import { encodeGraph } from '../core/serialize.ts'
import { readSavedViews } from '../server/api.ts'
import { EMBED_MARK, embedTags } from '../server/embed.ts'
import type { ExportMeta } from '../server/embed.ts'
import { infoOf } from '../server/views.ts'
import { DEFAULT_OPTIONS, VIEW_IDS, optionsFromQuery, optionsToQuery } from '../viewer/url-state.ts'
import { countFiles } from './output.ts'
import { TOOL_DIR, defaultOut, descriptionsPath, slug } from './projects.ts'
import { readDescriptionsFile } from './describe.ts'
import { resolveDescriptions } from '../core/descriptions.ts'

export const STATIC_DIR = path.join(TOOL_DIR, 'dist', 'static')

export interface ExportOptions {
  root: string
  config?: string
  /** The HTML file (default: beside the project's graph, named after the project). */
  out?: string
  /** Where the project's graph goes (its cache and saved views are beside it). */
  graphOut?: string
  /** The saved views to carry (default: views/ beside the graph). */
  views?: string
  /** A view's id, or a viewer link (`http://127.0.0.1:4300/?view=wheel&group=feature#n=…`, or its `?…#…`). */
  view?: string
  /** Carry the project's files, so the inspector shows their source. */
  source?: boolean
  cache?: boolean
  history?: boolean
  /** The built static viewer (default: dist/static). */
  staticDir?: string
  log?: (msg: string) => void
}

export interface ExportResult {
  file: string
  bytes: number
  /** The view the page opens on. */
  view: string
  /** Bytes of each embedded part as written (compressed and base64-encoded). */
  parts: Record<string, number>
  /** Files left out of --source (binary, too large or unreadable). */
  skipped: string[]
}

/** Larger files stay out of --source: generated bundles, not code to read. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

export async function runExport(o: ExportOptions): Promise<ExportResult> {
  const log = o.log ?? (() => {})
  const files = templateFiles(o.staticDir ?? STATIC_DIR, !!o.source)
  const project = projectOf(o)
  const start = startLink(o.view, log)
  const graph = await analyzeIsolated({
    root: project.root,
    config: project.config,
    files: countFiles(project.root, project.config),
    cacheDir: project.cacheDir,
    history: o.history !== false,
    log,
  })
  const sources = o.source ? readSources(graph, project.root) : undefined
  const shared = shareable(graph)
  const parts = pageParts(shared, sources?.texts, files.highlighter && fs.readFileSync(files.highlighter, 'utf8'))
  const described = readDescriptionsFile(descriptionsPath(project.root, o.config)).data
  const meta: ExportMeta = {
    info: infoOf(shared, { root: '', version: 1, live: false }),
    views: readSavedViews(project.views),
    start: start.link,
    ...(Object.keys(described.entries).length || described.project ? { descriptions: resolveDescriptions(graph, described) } : {}),
    exportedAt: new Date().toISOString(),
  }
  const html = fillTemplate(fs.readFileSync(files.template, 'utf8'), project.name, embedTags(meta, parts))
  fs.mkdirSync(path.dirname(project.file), { recursive: true })
  fs.writeFileSync(project.file, html)
  const sizes = Object.fromEntries(Object.entries(parts).flatMap(([k, v]) => (v ? [[k, v.length]] : [])))
  return { file: project.file, bytes: Buffer.byteLength(html), view: start.view, parts: sizes, skipped: sources?.skipped ?? [] }
}

/** The graph, and with --source the files' text and the highlighter's code: each gzipped and base64-encoded. */
export function pageParts(graph: Graph, texts?: Record<string, string>, highlighter?: string): Record<'graph' | 'source' | 'highlighter', string | undefined> {
  return {
    graph: gzipBase64(JSON.stringify(encodeGraph(graph))),
    source: texts && gzipBase64(JSON.stringify(texts)),
    highlighter: texts && highlighter ? gzipBase64(highlighter) : undefined,
  }
}

/** The project's root, config and name; its cache and saved views, beside its graph; and where the page goes. */
function projectOf(o: ExportOptions) {
  const root = path.resolve(o.root)
  const config = loadConfig(root, o.config)
  const name = config.name ?? path.basename(root)
  const dir = path.dirname(path.resolve(o.graphOut ?? defaultOut(name, root)))
  return {
    root,
    config,
    name,
    cacheDir: o.cache === false ? (false as const) : path.join(dir, 'cache'),
    views: o.views ?? path.join(dir, 'views'),
    file: path.resolve(o.out ?? path.join(dir, `${slug(name)}.html`)),
  }
}

/** The template, and with --source the highlighter; a missing one means the build hasn't run. */
function templateFiles(dir: string, source: boolean): { template: string; highlighter?: string } {
  const template = path.join(dir, 'index.html')
  const highlighter = path.join(dir, 'highlight.js')
  for (const file of source ? [template, highlighter] : [template])
    if (!fs.existsSync(file)) throw new Error(`the static viewer isn't built (${file} missing): run \`npm run build\` in the archrift checkout first`)
  return { template, highlighter: source ? highlighter : undefined }
}

/** The page's title and parts; a template without the mark is from an older build. */
export function fillTemplate(template: string, name: string, tags: string): string {
  if (!template.includes(EMBED_MARK)) throw new Error(`the static viewer's template has no place for the data (${EMBED_MARK}): run \`npm run build\` in the archrift checkout again`)
  return template.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(name)} · archrift</title>`).replace(EMBED_MARK, () => tags)
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const gzipBase64 = (text: string) => zlib.gzipSync(text, { level: 9 }).toString('base64')

/** The graph without the absolute folders of mounts: the file gets shared, and the page never opens them. */
function shareable(graph: Graph): Graph {
  if (!graph.meta.mounts) return graph
  const { mounts: _, ...meta } = graph.meta
  return { ...graph, meta }
}

/**
 * The link the page opens on, from `--view`: a view's id, or a viewer link
 * whose options (and `#n=` selection) carry over. The timeline and the project
 * don't: an export has neither.
 */
export function startLink(view: string | undefined, log: (msg: string) => void = () => {}): { link: string; view: string } {
  if (!view) return { link: '', view: DEFAULT_OPTIONS.view }
  const url = /^[a-z][a-z0-9-]*$/.test(view) ? new URL(`?view=${view}`, 'http://archrift/') : new URL(view, 'http://archrift/')
  const options = { ...optionsFromQuery(url.search), timeline: false, at: '' }
  if (!(VIEW_IDS as readonly string[]).includes(options.view)) log(`archrift export: no view "${options.view}" (${VIEW_IDS.join(', ')}); the page opens on the City`)
  const hash = url.hash.startsWith('#n=') ? url.hash : ''
  return { link: optionsToQuery(options) + hash, view: options.view }
}


/** The text of every file the graph knows, by path; binary, very large and unreadable ones stay out. */
function readSources(graph: Graph, root: string): { texts: Record<string, string>; skipped: string[] } {
  const texts: Record<string, string> = {}
  const skipped: string[] = []
  for (const n of graph.nodes) {
    if (n.kind !== 'file' || !n.path) continue
    const text = readText(absPathOf(root, graph.meta.mounts, n.path))
    if (text === undefined) skipped.push(n.path)
    else texts[n.path] = text
  }
  return { texts, skipped }
}

function readText(file: string): string | undefined {
  try {
    const bytes = fs.readFileSync(file)
    return bytes.length > MAX_SOURCE_BYTES || bytes.includes(0) ? undefined : bytes.toString('utf8')
  } catch {
    return undefined
  }
}
