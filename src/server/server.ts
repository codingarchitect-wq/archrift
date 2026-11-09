// `archrift serve`: the API plus the built viewer (dist/viewer), on 127.0.0.1.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { Graph } from '../core/model.ts'
import { createApi } from './api.ts'
import type { ApiOptions } from './api.ts'
import type { LiveGraph } from './live.ts'
import type { ProjectsHandle } from './projects.ts'

export const VIEWER_DIST = path.resolve(import.meta.dirname, '../../dist/viewer')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
}

export interface ServeOptions {
  root: string
  graph: Graph
  port: number
  host?: string
  viewerDir?: string
  viewsDir?: string
  /** Snapshots from `archrift snapshot`, for the timeline. */
  snapshotsDir?: string
  /** The project's descriptions file (`archrift describe`). */
  descriptions?: string
  /** The Changes panel's comparison (the project hub's). */
  changes?: ApiOptions['changes']
  /** The Changes panel's commits to pick from (the project hub's). */
  commits?: ApiOptions['commits']
  /** The Ask bar's agent (the project hub's). */
  ask?: ApiOptions['ask']
  /** Watch mode: new graphs to push to the viewers. */
  live?: LiveGraph
  /** The project switcher (`serve` has one; tests and the dev server don't). */
  projects?: ProjectsHandle
}

export function startServer(options: ServeOptions): Promise<http.Server> {
  const viewerDir = options.viewerDir ?? VIEWER_DIST
  if (!fs.existsSync(path.join(viewerDir, 'index.html')))
    throw new Error(`viewer not built (${viewerDir} missing): run \`npm run build\` in the archrift checkout first`)
  const api = createApi({
    root: options.root,
    graph: options.graph,
    viewsDir: options.viewsDir,
    snapshotsDir: options.snapshotsDir,
    descriptions: options.descriptions,
    changes: options.changes,
    commits: options.commits,
    ask: options.ask,
    live: options.live,
    projects: options.projects,
  })
  const server = http.createServer((req, res) => {
    void api(req, res, () => serveStatic(viewerDir, req, res))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve(server))
  })
}

function serveStatic(dir: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
  const file = path.resolve(dir, rel)
  const target = file.startsWith(dir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dir, 'index.html')
  res.setHeader('Content-Type', TYPES[path.extname(target)] ?? 'application/octet-stream')
  if (target.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  fs.createReadStream(target).pipe(res)
}
