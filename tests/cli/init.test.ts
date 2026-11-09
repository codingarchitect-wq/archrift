import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/analyzer/config.ts'
import { HOME_DIR } from '../../src/cli/projects.ts'
import { copyFixture } from '../helpers/fixtures.ts'

const CLI = path.resolve(import.meta.dirname, '../../src/cli/main.ts')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}
const app = () => {
  const root = copyFixture('vite-app')
  dirs.push(root)
  return root
}
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

describe('archrift init', () => {
  it('writes a starter config into the project, its results beside it, adds it to the list and reports', () => {
    const root = app()
    const projects = path.join(tmp('archrift-init-'), 'projects.json')
    const r = cli('init', root, '--projects', projects, '--no-history')
    expect(r.status).toBe(0)
    expect(r.stdout.split('\n')[0]).toBe(`archrift init ${path.basename(root)}`)
    expect(r.stdout).toContain('wrote .archrift/config.json')
    expect(r.stdout).toContain('Layers, top to bottom')
    // every starter rule is an error, the ones the code breaks today too; init itself reports, it doesn't fail
    expect(r.stdout).toContain('✓ no-cycles (error): held')
    expect(r.stdout).toContain('✗ functions-small-logic (error): 1 broken')
    // the files between the blocks, and why they tie them together
    expect(r.stdout).toContain('   1. src/pages/Home.tsx  (src/pages)  betweenness')
    expect(r.stdout).toContain('Why does `src/pages/Home.tsx` connect `src` to `src/components` and `src/hooks`?  (bridge)')
    expect(r.stdout).toContain('## Architecture checks (archrift)')

    const dir = path.join(root, '.archrift')
    const config = loadConfig(root)
    expect(config.exclude).toEqual(['src/generated/**', 'public/**'])
    expect(config.layers?.map(l => l.name)).toEqual(['src (top files)', 'pages', 'scripts + components + hooks', 'lib'])
    expect(config.rules.map(r => [r.name, r.severity ?? 'error'])).toEqual([
      ['no-cycles', 'error'],
      ['layers-point-down', 'error'],
      ['functions-small-logic', 'error'],
      ['functions-small-ui', 'error'],
    ])
    // git keeps the config and the descriptions written for the code, nothing else archrift writes there
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toMatch(/^\*\n!\.gitignore\n!config\.json\n!descriptions\.json\n$/m)
    expect(fs.existsSync(path.join(dir, 'graph.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'cache'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'first-look.md'), 'utf8').split('\n')[0]).toBe(`# ${path.basename(root)}: first look`)
    const html = fs.readFileSync(path.join(dir, 'first-look.html'), 'utf8')
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('aria-label="Functions by complexity band"')
    expect(html).toContain('aria-label="Bridges"')
    expect(JSON.parse(fs.readFileSync(projects, 'utf8')).projects).toEqual([{ name: path.basename(root), root }])

    // from then on the project's results stay in the project, and check fails until formatAmount is split
    const check = cli('check', root, '--no-history')
    expect(check.stdout).toMatch(/1 errors · 0 warnings · 4 rules/)
    expect(check.status).toBe(1)
    expect(fs.existsSync(path.join(HOME_DIR, 'projects', path.basename(root)))).toBe(false)
  })

  it('keeps a config the project has, and analyzes and reports again; --force writes a new one', () => {
    const root = app()
    const projects = path.join(tmp('archrift-init-'), 'projects.json')
    cli('init', root, '--projects', projects, '--no-history')
    const file = path.join(root, '.archrift', 'config.json')
    const edited = { ...JSON.parse(fs.readFileSync(file, 'utf8')), name: 'mine', rules: [] }
    fs.writeFileSync(file, JSON.stringify(edited))
    const again = cli('init', root, '--projects', projects, '--no-history')
    expect(again.status).toBe(0)
    expect(again.stdout).toMatch(/^archrift init mine\n/)
    expect(again.stdout).toContain('kept .archrift/config.json as it is')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(edited)
    expect(JSON.parse(fs.readFileSync(projects, 'utf8')).projects).toHaveLength(1)

    expect(cli('init', root, '--projects', projects, '--no-history', '--force').status).toBe(0)
    expect(loadConfig(root).rules).toHaveLength(4)
  })

  it('on a dry run prints the config it would write, and writes nothing', () => {
    const root = app()
    const projects = path.join(tmp('archrift-init-'), 'projects.json')
    const r = cli('init', root, '--projects', projects, '--no-history', '--dry-run', '--format', 'json')
    expect(r.status).toBe(0)
    const look = JSON.parse(r.stdout)
    expect(look.config).toEqual({ path: '.archrift/config.json', status: 'dry-run' })
    expect(look.proposedConfig.rules.map((x: { name: string }) => x.name)).toEqual(['no-cycles', 'layers-point-down', 'functions-small-logic', 'functions-small-ui'])
    expect(fs.existsSync(path.join(root, '.archrift'))).toBe(false)
    expect(fs.existsSync(projects)).toBe(false)
  })

  it('says so when the folder is not one', () => {
    const r = cli('init', path.join(os.tmpdir(), 'archrift-no-such-folder'), '--projects', '/dev/null')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/^archrift: Error: init: not a folder/)
  })
})
