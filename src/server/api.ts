// The viewer's API, as a connect-style handler so both
// `archrift serve` and the Vite dev server can mount it. Only a local page may
// call it; it reads only files that are nodes of the graph and writes only
// saved views (JSON files in the views directory). With `?snapshot=<sha>`, the
// graph endpoints answer from that snapshot and sources come from git.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { NO_DESCRIPTIONS, parseDescriptions, resolveDescriptions } from '../core/descriptions.ts'
import type { ResolvedDescriptions } from '../core/descriptions.ts'
import type { ChangesRange, ChangesReport, CommitInfo } from '../core/changes.ts'
import type { Answer, AskContext } from '../core/ask.ts'
import { GraphIndex } from '../core/graph-index.ts'
import type { Graph } from '../core/model.ts'
import { diffGraphs, patchShare } from '../core/patch.ts'
import { decodeGraph, encodeGraph } from '../core/serialize.ts'
import type { SerializedGraph } from '../core/serialize.ts'
import { readSnapshotIndex, snapshotFile } from '../core/snapshot-index.ts'
import { absPathOf } from '../analyzer/mounts.ts'
import type { LiveGraph } from './live.ts'
import type { ProjectsHandle } from './projects.ts'
import { classes, fileDetails, infoOf, overview, search, sourceLines } from './views.ts'
import type { Info } from './views.ts'

export interface ApiOptions {
  /** Absolute root of the analyzed codebase (for source reads and editor links). */
  root: string
  graph: Graph
  /** Where saved views are kept (one JSON file each); none = views can't be saved. */
  viewsDir?: string
  /** Snapshots from `archrift snapshot` (index.json + one graph per commit). */
  snapshotsDir?: string
  /** The project's names and descriptions (`archrift describe`), read on request; viewers hear when it changes. */
  descriptions?: string
  /** A range of the code against its base (`archrift diff`), for the Changes panel: `head` is the graph served now (the working tree), `range.head` a revision to compare instead. */
  changes?: (head: Graph, range: ChangesRange) => Promise<ChangesReport>
  /** The latest commits, for the Changes panel's range picker. */
  commits?: () => CommitInfo[]
  /** The Ask bar: an agent answering questions about the code (POST /api/ask streams its progress, then the answer). */
  ask?: {
    status: { available: boolean; engine?: string; why?: string }
    run: (input: { question: string; context?: AskContext }, onProgress: (text: string) => void, signal: AbortSignal) => Promise<Answer>
  }
  /** Watch mode: new graphs as files change, pushed to the viewers as patches on /api/events. */
  live?: LiveGraph
  /** The project switcher: /api/projects, with progress on /api/events. */
  projects?: ProjectsHandle
}

interface SavedView {
  name: string
  state: Record<string, unknown>
}

const MAX_BODY = 256 * 1024
/** The longest question the Ask bar takes. */
const MAX_QUESTION = 2000
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

/** Past this share of the overview changed, viewers reload it instead of patching. */
const RELOAD_SHARE = 0.5

/** Snapshot graphs kept in memory at once. */
const SNAPSHOT_CACHE = 12
type Next = (err?: unknown) => void

interface Served {
  index: GraphIndex
  overview: Graph
  overviewJson: string
}

// encoded once: the overview is what every page load (and every timeline step) asks for
const serve = (graph: Graph): Served => {
  const index = new GraphIndex(graph)
  const o = overview(index)
  return { index, overview: o, overviewJson: JSON.stringify(encodeGraph(o).graph) }
}

export function createApi(options: ApiOptions) {
  // the open project: replaced when the project switcher opens another one
  let root = options.root
  let mounts = options.graph.meta.mounts
  let viewsDir = options.viewsDir
  let snapshotsDir = options.snapshotsDir
  let descriptionsFile = options.descriptions
  let current = serve(options.graph)
  let version = 1
  const infoFor = (graph: Graph): Info => infoOf(graph, { root, mounts, version, live: !!options.live, project: options.projects?.list().active, ask: options.ask?.status })
  let info = infoFor(options.graph)

  // watch mode: each new graph becomes a patch for every viewer listening
  const listeners = new Set<ServerResponse>()
  const broadcast = (event: string, data: unknown) => {
    const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of listeners) res.write(text)
  }
  options.live?.subscribe(({ graph, ms }) => {
    const next = serve(graph)
    const patch = diffGraphs(current.overview, next.overview, version, version + 1)
    current = next
    if (!patch.nodes.length && !patch.removedNodes.length && !patch.edges.length && !patch.removedEdges.length) return
    version++
    info = infoFor(graph)
    if (patchShare(next.overview, patch) > RELOAD_SHARE) broadcast('reload', { version, ms })
    else broadcast('patch', { ...patch, ms })
  })
  // the project switcher: progress while a project opens, then everything is that project's
  options.projects?.subscribe(e => {
    if (e.type === 'progress') return broadcast('project', { state: 'opening', name: e.name, message: e.message })
    if (e.type === 'failed') return broadcast('project', { state: 'failed', name: e.name, error: e.error })
    root = e.root
    mounts = e.graph.meta.mounts
    viewsDir = e.views
    snapshotsDir = e.snapshots
    watchDescriptions(e.descriptions)
    current = serve(e.graph)
    snapshots.clear()
    version++
    info = infoFor(e.graph)
    broadcast('project', { state: 'open', name: e.name, version })
  })

  // the descriptions, resolved against the graph shown now; read again when the file or the graph changes
  let described: { key: string; value: ResolvedDescriptions } | undefined
  const descriptionsNow = (served: Served): ResolvedDescriptions => {
    const file = descriptionsFile
    if (!file) return NO_DESCRIPTIONS
    let mtime = 0
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      return NO_DESCRIPTIONS
    }
    const key = `${file}\0${mtime}\0${served.overviewJson.length}\0${version}`
    if (described?.key === key && served === current) return described.value
    let value = NO_DESCRIPTIONS
    try {
      value = resolveDescriptions(served.index.graph, parseDescriptions(JSON.parse(fs.readFileSync(file, 'utf8'))).file, served.index)
    } catch {
      // being written, or not a descriptions file: none until it is
    }
    if (served === current) described = { key, value }
    return value
  }
  // a change to the file reaches every open viewer
  let watched: string | undefined
  const onDescriptions = () => broadcast('descriptions', { version })
  function watchDescriptions(file: string | undefined) {
    if (watched) fs.unwatchFile(watched, onDescriptions)
    watched = descriptionsFile = file
    described = undefined
    // polled (one file, once a second), and never what keeps the process alive
    if (file) fs.watchFile(file, { interval: 1000 }, onDescriptions).unref()
  }
  watchDescriptions(descriptionsFile)

  // one comparison at a time per graph version and base: a second panel waits for the first's answer
  let comparing: { key: string; report: Promise<ChangesReport> } | undefined
  const changes = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!options.changes) return send(req, res, 404, { error: 'this server compares no changes (archrift serve does)' })
    const range: ChangesRange = { base: url.searchParams.get('base') || undefined, head: url.searchParams.get('head') || undefined }
    const key = `${version}\0${range.base ?? ''}\0${range.head ?? ''}\0${url.searchParams.get('fresh') ?? ''}`
    if (comparing?.key !== key) comparing = { key, report: options.changes(current.index.graph, range) }
    const asked = comparing
    try {
      return send(req, res, 200, await asked.report)
    } catch (err) {
      if (comparing === asked) comparing = undefined
      return send(req, res, 409, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  // a question for the agent: newline-delimited JSON, its steps as it works, then the answer (or what went wrong)
  const ask = async (req: IncomingMessage, res: ServerResponse) => {
    if (!options.ask) return send(req, res, 404, { error: 'this server asks no agent (archrift serve does)' })
    if (!options.ask.status.available) return send(req, res, 409, { error: options.ask.status.why ?? 'no agent to ask' })
    const body = await readJson(req)
    if ('error' in body) return send(req, res, body.status, { error: body.error })
    const question = typeof body.value.question === 'string' ? body.value.question.trim() : ''
    if (!question || question.length > MAX_QUESTION) return send(req, res, 400, { error: `a question, at most ${MAX_QUESTION} characters` })
    const context = body.value.context && typeof body.value.context === 'object' ? (body.value.context as AskContext) : undefined
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
    const line = (x: unknown) => res.write(`${JSON.stringify(x)}\n`)
    const stop = new AbortController()
    // the page closed or asked something else: the agent stops
    res.on('close', () => stop.abort())
    try {
      const answer = await options.ask.run({ question, context }, text => line({ type: 'progress', text }), stop.signal)
      line({ type: 'answer', answer })
    } catch (err) {
      line({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    res.end()
  }

  const projects = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const hub = options.projects
    if (!hub) return send(req, res, 404, { error: 'this server has no project list' })
    if (req.method === 'GET') return send(req, res, 200, hub.list())
    try {
      if (req.method === 'DELETE') {
        hub.remove(url.searchParams.get('name') ?? '')
        return send(req, res, 200, hub.list())
      }
      const body = await readJson(req)
      if ('error' in body) return send(req, res, body.status, { error: body.error })
      const input = body.value
      if (url.pathname === '/api/projects/open') {
        if (typeof input.name !== 'string') return send(req, res, 400, { error: 'which project? (name)' })
        hub.open(input.name)
        return send(req, res, 202, { opening: input.name })
      }
      if (typeof input.root !== 'string' || !input.root.trim()) return send(req, res, 400, { error: 'a project needs a folder (root)' })
      const added = hub.add({
        root: input.root.trim(),
        name: typeof input.name === 'string' ? input.name : undefined,
        config: typeof input.config === 'string' && input.config.trim() ? input.config.trim() : undefined,
      })
      return send(req, res, 200, added)
    } catch (err) {
      return send(req, res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const snapshots = new Map<string, Served>() // least recently used first
  /** The graph a request is about: now, or `?snapshot=<sha>` (undefined when there's no such snapshot). */
  const servedFor = (url: URL): Served | undefined => {
    const sha = url.searchParams.get('snapshot')
    if (!sha) return current
    const hit = snapshots.get(sha)
    if (hit) {
      snapshots.delete(sha)
      snapshots.set(sha, hit)
      return hit
    }
    const file = snapshotsDir ? snapshotFile(snapshotsDir, sha) : undefined
    if (!file || !fs.existsSync(file)) return undefined
    const loaded = serve(decodeGraph(JSON.parse(fs.readFileSync(file, 'utf8')) as SerializedGraph))
    snapshots.set(sha, loaded)
    if (snapshots.size > SNAPSHOT_CACHE) snapshots.delete(snapshots.keys().next().value!)
    return loaded
  }

  const views = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (req.method === 'GET') return send(req, res, 200, readSavedViews(viewsDir))
    const dir = viewsDir
    if (!dir) return send(req, res, 404, { error: 'this server keeps no views (start it with --views <dir>)' })
    if (req.method === 'DELETE') {
      const file = path.join(dir, `${slug(url.searchParams.get('name') ?? '')}.json`)
      if (fs.existsSync(file)) fs.unlinkSync(file)
      return send(req, res, 200, { ok: true })
    }
    // POST: JSON only, so a plain cross-site form can't write here
    if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) return send(req, res, 415, { error: 'expected application/json' })
    const body = await readBody(req)
    if (body === undefined) return send(req, res, 413, { error: 'view too large' })
    let view: SavedView
    try {
      view = JSON.parse(body) as SavedView
    } catch {
      return send(req, res, 400, { error: 'not JSON' })
    }
    if (typeof view?.name !== 'string' || !slug(view.name) || !view.state || typeof view.state !== 'object')
      return send(req, res, 400, { error: 'a view needs a name and a state' })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${slug(view.name)}.json`), JSON.stringify({ name: view.name, state: view.state }, null, 2) + '\n')
    return send(req, res, 200, { ok: true })
  }

  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next()
    if (!isLocalRequest(req)) return send(req, res, 403, { error: 'forbidden' })
    const writable =
      ((url.pathname === '/api/views' || url.pathname === '/api/projects') && (req.method === 'POST' || req.method === 'DELETE')) ||
      (url.pathname === '/api/projects/open' && req.method === 'POST') ||
      (url.pathname === '/api/ask' && req.method === 'POST')
    if (req.method !== 'GET' && !writable) return send(req, res, 405, { error: 'method not allowed' })
    try {
      switch (url.pathname) {
        case '/api/views':
          return await views(req, res, url)
        case '/api/projects':
        case '/api/projects/open':
          return await projects(req, res, url)
        case '/api/info':
          return send(req, res, 200, info)
        case '/api/changes':
          return await changes(req, res, url)
        case '/api/commits':
          return options.commits ? send(req, res, 200, options.commits()) : send(req, res, 404, { error: 'this server lists no commits (archrift serve does)' })
        case '/api/ask':
          return req.method === 'POST' ? await ask(req, res) : send(req, res, 405, { error: 'method not allowed' })
        case '/api/snapshots':
          return send(req, res, 200, snapshotsDir ? readSnapshotIndex(snapshotsDir) : [])
        case '/api/events': {
          // Server-Sent Events: `patch` (or `reload`) whenever watch mode finds a change
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
          res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ version, live: !!options.live })}\n\n`)
          listeners.add(res)
          req.on('close', () => listeners.delete(res))
          return
        }
        case '/api/overview':
        case '/api/file':
        case '/api/search':
        case '/api/source':
        case '/api/classes':
        case '/api/descriptions':
          break
        default:
          return send(req, res, 404, { error: 'unknown endpoint' })
      }
      const served = servedFor(url)
      if (!served) return send(req, res, 404, { error: 'no such snapshot' })
      const sha = url.searchParams.get('snapshot')
      switch (url.pathname) {
        case '/api/overview':
          return sendText(req, res, 200, served.overviewJson)
        case '/api/file': {
          const details = fileDetails(served.index, url.searchParams.get('id') ?? '')
          return details ? send(req, res, 200, details) : send(req, res, 404, { error: 'no such file node' })
        }
        case '/api/search':
          return send(req, res, 200, search(served.index, url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 30), descriptionsNow(served)))
        case '/api/descriptions':
          return send(req, res, 200, descriptionsNow(served))
        case '/api/classes':
          return send(req, res, 200, classes(served.index.graph, { family: url.searchParams.get('family'), folder: url.searchParams.get('folder') }))
        default: {
          const rel = url.searchParams.get('path') ?? ''
          // only files the graph knows, inside the root: no arbitrary reads
          if (!served.index.node(`f:${rel}`) || rel.split('/').includes('..')) return send(req, res, 404, { error: 'unknown file' })
          // a snapshot is of the root's repository: a mounted file is read as it is now
          const mounted = mounts !== undefined && Object.hasOwn(mounts, rel.split('/')[0])
          const text =
            sha && !mounted
              ? execFileSync('git', ['-C', root, 'show', `${sha}:./${rel}`], { encoding: 'utf8', maxBuffer: 1 << 26 })
              : fs.readFileSync(absPathOf(root, mounts, rel), 'utf8')
          const end = url.searchParams.get('end')
          return send(req, res, 200, sourceLines(rel, text, Number(url.searchParams.get('start') ?? 1), end === null ? undefined : Number(end)))
        }
      }
    } catch (err) {
      return send(req, res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** The saved views in a directory (one JSON file each), by name; files that aren't views are skipped. */
export function readSavedViews(dir: string | undefined): SavedView[] {
  if (!dir || !fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SavedView
        return typeof v.name === 'string' && v.state && typeof v.state === 'object' ? [v] : []
      } catch {
        return []
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Only a page served from localhost may call the API: the Host header must be
 * local (DNS rebinding) and a cross-site Origin is refused.
 */
function isLocalRequest(req: IncomingMessage) {
  const local = (h: string | undefined) => !!h && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h)
  if (!local(req.headers.host)) return false
  const origin = req.headers.origin
  return origin === undefined || local(origin.replace(/^https?:\/\//, ''))
}

/** A JSON body, from a JSON request only (so a plain cross-site form can't post here). */
async function readJson(req: IncomingMessage): Promise<{ value: Record<string, unknown> } | { error: string; status: number }> {
  if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) return { error: 'expected application/json', status: 415 }
  const body = await readBody(req)
  if (body === undefined) return { error: 'too large', status: 413 }
  try {
    const value = JSON.parse(body) as unknown
    return { value: value && typeof value === 'object' ? (value as Record<string, unknown>) : {} }
  } catch {
    return { error: 'not JSON', status: 400 }
  }
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        resolve(undefined)
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  sendText(req, res, status, JSON.stringify(body))
}

function sendText(req: IncomingMessage, res: ServerResponse, status: number, text: string) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  const gzip = text.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
  if (gzip) {
    res.setHeader('Content-Encoding', 'gzip')
    res.end(zlib.gzipSync(text, { level: 6 }))
  } else {
    res.end(text)
  }
}

