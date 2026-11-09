// archrift where it may not write into the project (a sandboxed agent, a read-only
// checkout): a cache it can't write is a warning, and ARCHRIFT_CACHE moves every
// result out of the project.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeCache } from '../../src/analyzer/cache-write.ts'
import { defaultOut } from '../../src/cli/projects.ts'
import { FIXTURES } from '../helpers/fixtures.ts'

const CLI = path.resolve(import.meta.dirname, '../../src/cli/main.ts')
const dirs: string[] = []
const locked: string[] = []
afterEach(() => {
  for (const d of locked.splice(0)) fs.chmodSync(d, 0o755)
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = (name: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `archrift-${name}-`))
  dirs.push(d)
  return d
}
const readOnly = (dir: string) => {
  fs.chmodSync(dir, 0o555)
  locked.push(dir)
}
/** plain-ts with a config of its own, as init leaves a project. */
function project(): string {
  const root = path.join(tmp('ro'), 'app')
  fs.cpSync(path.join(FIXTURES, 'plain-ts'), root, { recursive: true })
  fs.mkdirSync(path.join(root, '.archrift'))
  fs.writeFileSync(path.join(root, '.archrift', 'config.json'), '{ "name": "app" }\n')
  return root
}
const cli = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
const files = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()
// root ignores file permissions: there a folder is never read-only
const asRoot = process.getuid?.() === 0

describe('a cache archrift may not write', () => {
  it.skipIf(asRoot)('is a warning, once per folder, and the write says it did not happen', () => {
    const dir = tmp('cache')
    readOnly(dir)
    const warnings: string[] = []
    expect(writeCache(path.join(dir, 'cache', 'fragments.json'), '{}', m => warnings.push(m))).toBe(false)
    expect(writeCache(path.join(dir, 'cache', 'fragments.json'), '{}', m => warnings.push(m))).toBe(false)
    expect(warnings).toEqual([`archrift: can't write its cache in ${path.join(dir, 'cache')} (EACCES); going on without it. ARCHRIFT_CACHE or --out moves it to a folder it may write.`])
    expect(writeCache(path.join(tmp('cache'), 'cache', 'fragments.json'), '{"ok":1}')).toBe(true)
  })

  it('still throws for anything else', () => {
    const file = path.join(tmp('cache'), 'taken')
    fs.mkdirSync(file) // a folder where the file should go
    expect(() => writeCache(file, '{}', () => {})).toThrow(/EISDIR/)
  })

  it.skipIf(asRoot)("doesn't stop query: a project whose .archrift/ is read-only gets its answer, uncached", () => {
    const root = project()
    readOnly(path.join(root, '.archrift'))
    const before = files(path.join(root, '.archrift'))
    const r = cli({ ARCHRIFT_HOME: tmp('home') }, 'query', 'overview', '--root', root, '--no-history')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^app: /)
    expect(r.stderr).toContain(`archrift: can't write its cache in ${path.join(root, '.archrift', 'cache')} (EACCES)`)
    expect(files(path.join(root, '.archrift'))).toEqual(before)
  })
})

describe('ARCHRIFT_CACHE', () => {
  it("puts every project's results in <ARCHRIFT_CACHE>/<name>/, its own .archrift/ or not", () => {
    expect(defaultOut('app', '/work/app', { ARCHRIFT_CACHE: '/runs/42' })).toBe('/runs/42/app/graph.json')
    expect(defaultOut('My App', undefined, { ARCHRIFT_CACHE: '/runs/42' })).toBe('/runs/42/My-App/graph.json')
    const root = project()
    expect(defaultOut('app', root, {})).toBe(path.join(root, '.archrift', 'graph.json'))
  })

  it('takes the cache of query out of the project: nothing is written into it', () => {
    const root = project()
    const cache = tmp('runs')
    const before = files(root)
    const r = cli({ ARCHRIFT_CACHE: cache, ARCHRIFT_HOME: tmp('home') }, 'query', 'overview', '--root', root, '--no-history')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(files(root)).toEqual(before)
    expect(fs.existsSync(path.join(cache, 'app', 'cache', 'fragments.json'))).toBe(true)
  })
})
