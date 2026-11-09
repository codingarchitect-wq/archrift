import path from 'node:path'
import { defineConfig } from '@playwright/test'

// End-to-end tests of the viewer against `archrift serve` on a fixture (and of
// pages from `archrift export html`, opened from disk). WebGL
// needs a real GPU: full Chromium in new headless mode, ANGLE on Metal (macOS;
// other platforms fall back to their default backend).
// ARCHRIFT_E2E_PORT moves every server (tests/e2e/ports.ts), so checkouts can run side by side
const PORT = Number(process.env.ARCHRIFT_E2E_PORT ?? 4301)
// the servers' home folder (tests/helpers write their own project lists), never the user's ~/.config/archrift
process.env.ARCHRIFT_HOME ??= path.resolve(import.meta.dirname, 'out/e2e/home')

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1400, height: 880 },
    channel: 'chromium',
    // real WebGL: Metal on a Mac, SwiftShader (software) on a Linux CI runner
    launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])] },
    // the first-visit hint has been seen (help.spec.ts checks it with a fresh browser)
    storageState: {
      cookies: [],
      origins: [0, 4, 5, 6, 7, 8, 12].map(offset => PORT + offset).map(port => ({
        origin: `http://127.0.0.1:${port}`,
        localStorage: [{ name: 'archrift.hint.seen', value: '1' }],
      })),
    },
  },
  // the fixtures live in this repo, so their git history changes with every commit: left out
  webServer: [
    {
      command: `npm run build && rm -rf out/e2e/plain-ts/views && node src/cli/main.ts serve fixtures/plain-ts --port ${PORT} --out out/e2e/plain-ts/graph.json --views out/e2e/plain-ts/views --projects out/e2e/plain-ts/projects.json --no-history --quiet`,
      url: `http://127.0.0.1:${PORT}/api/info`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // the plugins' fixture; waits for the first server's build
      command: `sleep 8 && node src/cli/main.ts serve fixtures/fullstack --port ${PORT + 4} --out out/e2e/fullstack/graph.json --views out/e2e/fullstack/views --projects out/e2e/fullstack/projects.json --no-history --quiet`,
      url: `http://127.0.0.1:${PORT + 4}/api/info`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // a git repository with a history (tests/helpers/history-repo.ts) and three snapshots of it
      command: [
        'sleep 8',
        'node tests/helpers/history-repo.ts out/e2e/history/repo',
        'rm -rf out/e2e/history/snapshots',
        'node src/cli/main.ts snapshot out/e2e/history/repo --count 3 --out out/e2e/history/graph.json --quiet',
        `node src/cli/main.ts serve out/e2e/history/repo --port ${PORT + 5} --out out/e2e/history/graph.json --projects out/e2e/history/projects.json --quiet`,
      ].join(' && '),
      url: `http://127.0.0.1:${PORT + 5}/api/info`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // watch mode, on a copy of plain-ts the tests edit
      command: [
        'sleep 8',
        'rm -rf out/e2e/watch',
        'mkdir -p out/e2e/watch',
        'cp -R fixtures/plain-ts out/e2e/watch/repo',
        `node src/cli/main.ts serve out/e2e/watch/repo --port ${PORT + 6} --out out/e2e/watch/graph.json --projects out/e2e/watch/projects.json --no-history --watch --quiet`,
      ].join(' && '),
      url: `http://127.0.0.1:${PORT + 6}/api/info`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // the project switcher: plain-ts and fullstack in one list
      command: [
        'sleep 8',
        'rm -rf out/e2e/projects',
        `node src/cli/main.ts serve fixtures/plain-ts fixtures/fullstack --projects out/e2e/projects/projects.json --out out/e2e/projects/plain-ts/graph.json --port ${PORT + 7} --no-history --quiet`,
      ].join(' && '),
      url: `http://127.0.0.1:${PORT + 7}/api/info`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // a Kotlin/Spring system: a controller, a repository, an entity, Kafka topics and a database
      command: `sleep 8 && node src/cli/main.ts serve fixtures/kotlin-spring --port ${PORT + 8} --out out/e2e/kotlin-spring/graph.json --views out/e2e/kotlin-spring/views --projects out/e2e/kotlin-spring/projects.json --no-history --quiet`,
      url: `http://127.0.0.1:${PORT + 8}/api/info`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // plain-ts with descriptions, a change in progress and the agent's notes; Ask answered by a stand-in claude
      command: [
        'sleep 8',
        'node tests/helpers/change-repo.ts out/e2e/ask/repo',
        `node src/cli/main.ts serve out/e2e/ask/repo --port ${PORT + 12} --projects out/e2e/ask/projects.json --no-history --claude tests/fixtures/fake-claude.mjs --quiet`,
      ].join(' && '),
      url: `http://127.0.0.1:${PORT + 12}/api/info`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
