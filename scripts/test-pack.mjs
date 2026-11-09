// The package as npm would install it: builds, packs, installs the tarball into a
// scratch project, and runs the installed command there (built lib/, no src/):
// --version, init, check, query, export html, and serve's viewer and API.
//
//   npm run test:pack            (needs the npm cache or the network for the dependencies)
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-pack-'))
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const step = msg => process.stdout.write(`· ${msg}\n`)
const fail = msg => {
  process.stderr.write(`✗ ${msg}\n  (left in ${work})\n`)
  process.exit(1)
}
const expect = (ok, msg) => (ok ? step(msg) : fail(msg))

step('build')
run('npm', ['run', 'build'], { cwd: ROOT })
step('pack')
const tarball = path.join(work, JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], { cwd: ROOT }))[0].filename)
const listed = run('tar', ['-tzf', tarball]).split('\n')
expect(!listed.some(f => f.startsWith('package/src/') || f.startsWith('package/tests/') || f.startsWith('package/fixtures/')), 'the tarball carries no src/, tests/ or fixtures/')
expect(['package/bin/archrift.js', 'package/lib/cli/main.js', 'package/dist/viewer/index.html', 'package/dist/static/index.html', 'package/dist/static/views.json', 'package/LICENSE'].every(f => listed.includes(f)), 'the tarball carries bin, lib, both viewers and the license')

step('install into a scratch project')
const app = path.join(work, 'app')
fs.cpSync(path.join(ROOT, 'fixtures', 'plain-ts'), app, { recursive: true })
fs.rmSync(path.join(app, '.archrift'), { recursive: true, force: true })
fs.writeFileSync(path.join(app, 'package.json'), '{ "name": "app", "private": true }\n')
run('npm', ['install', '--no-save', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', tarball], { cwd: app })
const bin = path.join(app, 'node_modules', '.bin', 'archrift')
const env = { ...process.env, ARCHRIFT_HOME: path.join(work, 'home') }
const archrift = (...args) => {
  try {
    return { out: run(bin, args, { cwd: app, env }), code: 0 }
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
expect(archrift('--version').out.trim() === version, `--version prints ${version}`)
const init = archrift('init', '.', '--no-history', '--quiet')
expect(fs.existsSync(path.join(app, '.archrift', 'config.json')), 'init writes .archrift/config.json')
expect(init.out.includes('npx archrift query ways'), 'init tells agents to run `npx archrift …`, as it was started')
const check = archrift('check', '.', '--no-history', '--format', 'json')
expect(JSON.parse(check.out).schemaVersion === 1, 'check --format json carries schemaVersion 1')
const overview = archrift('query', 'overview', '--root', '.')
expect(overview.code === 0 && overview.out.length > 0, 'query overview answers')
const exported = archrift('export', 'html', '.', '--no-history', '--view', 'wheel')
expect(exported.code === 0 && fs.readdirSync(path.join(app, '.archrift')).some(f => f.endsWith('.html')), 'export html writes the page')

step('serve')
const port = 4390 + Math.floor(Math.random() * 9)
const server = spawn(bin, ['serve', '.', '--port', String(port), '--no-history', '--projects', path.join(work, 'projects.json')], { cwd: app, env, stdio: 'ignore' })
try {
  const base = `http://127.0.0.1:${port}`
  let page = ''
  for (let i = 0; i < 120 && !page; i++) {
    await new Promise(r => setTimeout(r, 500))
    page = await fetch(base).then(r => (r.ok ? r.text() : ''), () => '')
  }
  expect(page.includes('<div id="scene">'), 'serve serves the viewer')
  const projects = await fetch(`${base}/api/projects`).then(r => r.json())
  expect(JSON.stringify(projects).includes('"app"'), 'serve answers the API')
} finally {
  server.kill()
}
fs.rmSync(work, { recursive: true, force: true })
step('the package works as installed')
