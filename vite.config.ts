// The viewer's build (dist/viewer, served by `archrift serve`) and its dev
// server, which mounts the same API over a freshly analyzed codebase:
//
//   ARCHRIFT_ROOT=../my-app npm run dev   (ARCHRIFT_CONFIG: a config elsewhere than <root>/.archrift/config.json)
//
// ARCHRIFT_VIEWS and ARCHRIFT_SNAPSHOTS point at saved views and at snapshots
// taken with `archrift snapshot` (e.g. ../my-app/.archrift/snapshots).
//
// `--mode static` and `--mode highlighter` build the exported page's template
// instead (vite.static.ts).
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { highlighterConfig, staticConfig } from './vite.static.ts'

function archriftApi(): Plugin {
  return {
    name: 'archrift-api',
    apply: 'serve',
    async configureServer(server) {
      const { analyze } = await import('./src/analyzer/analyze.ts')
      const { createApi } = await import('./src/server/api.ts')
      const root = path.resolve(process.env.ARCHRIFT_ROOT ?? 'fixtures/plain-ts')
      const graph = await analyze({
        root,
        configPath: process.env.ARCHRIFT_CONFIG,
        cacheDir: path.resolve('out/dev', path.basename(root), 'cache'),
        log: msg => server.config.logger.info(`archrift: ${msg}`),
      })
      const viewsDir = path.resolve(process.env.ARCHRIFT_VIEWS ?? path.join('out/dev', path.basename(root), 'views'))
      const snapshotsDir = process.env.ARCHRIFT_SNAPSHOTS ? path.resolve(process.env.ARCHRIFT_SNAPSHOTS) : undefined
      const api = createApi({ root, graph, viewsDir, snapshotsDir })
      server.middlewares.use((req, res, next) => void api(req, res, next))
    },
  }
}

export default defineConfig(({ mode }) => {
  if (mode === 'static') return staticConfig()
  if (mode === 'highlighter') return highlighterConfig()
  return {
    root: 'src/viewer',
    build: { outDir: '../../dist/viewer', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
    server: { host: '127.0.0.1', port: 4310, strictPort: true },
    plugins: [react(), archriftApi()],
  }
})
