import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportArchify, exportArchifyText } from '../../src/cli/export-archify.ts'
import type { DatabaseMeta, Graph } from '../../src/core/model.ts'
import { copyFixture } from '../helpers/fixtures.ts'

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts')
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-archify-'))
  dirs.push(d)
  return d
}

const database = (name: string, engine: string): DatabaseMeta => ({
  id: `db:test:${name}`,
  name,
  engine,
  sources: ['sql'],
  module: '',
  tables: [{ name: 'item', kind: 'table', nodes: [], columns: [{ name: 'id', type: 'bigint', pk: true }], references: [], indexes: [] }],
})
const graphWith = (databases?: DatabaseMeta[]) => ({ meta: { name: 'shop', layers: [], cycles: [], ...(databases ? { databases } : {}) }, nodes: [], edges: [], sites: [] }) as unknown as Graph

describe('archrift export archify', () => {
  it('writes an ERD per database, named after the HTML archify will write, and tells how to render each', () => {
    const dir = tmp()
    const written = exportArchify({ graph: graphWith([database('orders', 'mysql'), database('cache', 'mongodb')]), kind: 'erd', project: 'shop', dir })
    expect(written.map(w => path.basename(w.file))).toEqual(['shop.orders.erd.json', 'shop.cache.erd.json'])
    const doc = JSON.parse(fs.readFileSync(written[0].file, 'utf8'))
    expect(doc).toMatchObject({ diagram_type: 'erd', meta: { title: 'orders · MySQL', output: 'shop.orders.erd.html' } })
    expect(exportArchifyText(written, dir).split('\n')).toEqual([
      'wrote shop.orders.erd.json (1 table, 0 relationships)',
      'wrote shop.cache.erd.json (1 table, 0 relationships)',
      '',
      'render with archify (github.com/tt-a1i/archify), from its checkout or install:',
      '  node <archify>/bin/archify.mjs finalize erd shop.orders.erd.json shop.orders.erd.html --quality showcase',
      '  node <archify>/bin/archify.mjs finalize erd shop.cache.erd.json shop.cache.erd.html --quality showcase',
      '',
    ])
  })

  it('writes one database when asked, and names the others when the one asked for is not there', () => {
    const graph = graphWith([database('orders', 'mysql'), database('cache', 'mongodb')])
    expect(exportArchify({ graph, kind: 'erd', project: 'shop', dir: tmp(), database: 'cache' }).map(w => path.basename(w.file))).toEqual(['shop.cache.erd.json'])
    expect(() => exportArchify({ graph, kind: 'erd', project: 'shop', dir: tmp(), database: 'users' })).toThrow('no database users; there are: orders, cache')
    expect(() => exportArchify({ graph: graphWith(), kind: 'erd', project: 'shop', dir: tmp() })).toThrow(/no database schema found/)
  })
})

describe('archrift export archify on the command line', () => {
  it('analyzes the project and writes the architecture, with the command that renders it', () => {
    const root = copyFixture('vite-app')
    dirs.push(root)
    const out = tmp()
    const r = cli('export', 'archify', 'architecture', root, '--out', out, '--no-history', '--no-cache')
    expect(r.status).toBe(0)
    const name = path.basename(root)
    const file = path.join(out, `${name}.architecture.json`)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ diagram_type: 'architecture', meta: { output: `${name}.architecture.html` } })
    expect(r.stdout).toContain(`node <archify>/bin/archify.mjs finalize architecture ${file} ${file.replace(/json$/, 'html')} --quality`)
  })

  it('writes a type family as a class diagram, the biggest with classes unless one is named', () => {
    const root = copyFixture('plain-ts')
    dirs.push(root)
    const out = tmp()
    const r = cli('export', 'archify', 'class', root, '--out', out, '--no-history', '--no-cache')
    expect(r.status).toBe(0)
    const doc = JSON.parse(fs.readFileSync(path.join(out, `${path.basename(root)}.Shape.class.json`), 'utf8'))
    // interface Shape ← abstract class Base ← class Circle
    expect(doc.types.map((t: { label: string; kind: string; row: number }) => [t.label, t.kind, t.row])).toEqual([
      ['Shape', 'interface', 0],
      ['Base', 'abstract', 1],
      ['Circle', 'class', 2],
    ])
    expect(doc.relationships.map((x: { kind: string }) => x.kind)).toEqual(['realization', 'inheritance'])
    const none = cli('export', 'archify', 'class', root, '--family', 'Nope', '--out', out, '--no-history', '--no-cache')
    expect(none.status).toBe(1)
    expect(none.stderr).toContain('no type family Nope; the biggest are: Shape')
  })

  it('names the kinds it writes when asked for another', () => {
    const r = cli('export', 'archify', 'sequence')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('archrift export archify: architecture, erd or class')
  })
})
