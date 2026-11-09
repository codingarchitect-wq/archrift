// A project's own folder (`.archrift/`, or `.archviz/` from archrift's former name) and the
// config's `requires`: the lowest archrift version it needs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { VERSION, loadConfig, projectDir, satisfies } from '../../src/analyzer/config.ts'

const dirs: string[] = []
afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })))

function project(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-config-'))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), JSON.stringify(content))
  }
  return root
}

describe("a project's own folder", () => {
  it('is .archrift/, also before it exists', () => {
    const root = project({})
    expect(projectDir(root)).toBe(path.join(root, '.archrift'))
  })

  it('is .archviz/ where only the former name is set up, and its config is read', () => {
    const root = project({ '.archviz/config.json': { name: 'older' } })
    expect(projectDir(root)).toBe(path.join(root, '.archviz'))
    expect(loadConfig(root).name).toBe('older')
  })

  it('is .archrift/ when both are there', () => {
    const root = project({ '.archviz/config.json': { name: 'older' }, '.archrift/config.json': { name: 'newer' } })
    expect(projectDir(root)).toBe(path.join(root, '.archrift'))
    expect(loadConfig(root).name).toBe('newer')
  })
})

describe('requires', () => {
  it('compares versions part by part, missing parts as 0', () => {
    expect(satisfies('0.4.2', '>=0.4')).toBe(true)
    expect(satisfies('0.4.0', '>=0.4.1')).toBe(false)
    expect(satisfies('0.10.0', '>=0.9')).toBe(true)
    expect(satisfies('1.0.0', '>= 0.9.9')).toBe(true)
    expect(satisfies('0.3.9', '>=1')).toBe(false)
    expect(satisfies('1.2.3-beta.1', '>=1.2.3')).toBe(true)
  })

  it('lets a config through that this archrift satisfies', () => {
    const root = project({ '.archrift/config.json': { name: 'app', requires: `>=${VERSION}` } })
    expect(loadConfig(root).requires).toBe(`>=${VERSION}`)
  })

  it('stops with how to update when this archrift is older than the config needs', () => {
    const root = project({ '.archrift/config.json': { requires: '>=999.0' } })
    expect(() => loadConfig(root)).toThrow(`needs archrift >=999.0, this one is ${VERSION}: npm i -g archrift@latest`)
  })

  it('rejects a requires that is not ">=<version>"', () => {
    const root = project({ '.archrift/config.json': { requires: '^1.2' } })
    expect(() => loadConfig(root)).toThrow('the lowest archrift version this config needs')
  })
})
