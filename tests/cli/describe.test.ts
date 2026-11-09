import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { contentFingerprint, runDescribe } from '../../src/cli/describe.ts'
import type { DescribeInput } from '../../src/cli/describe.ts'
import { descriptionsPath } from '../../src/cli/projects.ts'
import type { Graph } from '../../src/core/model.ts'
import { analyzeFixture, copyFixture } from '../helpers/fixtures.ts'

let root = ''
let graph: Graph
const file = () => path.join(root, '.archrift', 'descriptions.json')
const read = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as { project?: string; entries: Record<string, { name?: string; summary: string; surface?: string; content?: string }> }
const run = (command: DescribeInput['command'], args: string[] = [], more: Partial<DescribeInput> = {}) => runDescribe({ command, args, graph, root, file: file(), format: 'text', ...more })

beforeAll(async () => {
  root = copyFixture('plain-ts')
  graph = await analyzeFixture('plain-ts', { root })
})

afterEach(() => fs.rmSync(path.join(root, '.archrift'), { recursive: true, force: true }))

describe('archrift describe', () => {
  it('keeps the descriptions beside the config, committed with it', () => {
    expect(descriptionsPath('/p')).toBe('/p/.archrift/descriptions.json')
    expect(descriptionsPath('/p', '/p/.archrift/config.json')).toBe('/p/.archrift/descriptions.json')
    expect(descriptionsPath('/p', '/tools/configs/app.json')).toBe('/tools/configs/app.descriptions.json')
  })

  it('writes one entry, stamped with the surface and content of its code, and marks a stale one checked', () => {
    const r = run('set', ['src/shapes.ts'], { name: 'Shapes', summary: 'The shapes the app draws.' })
    expect(r).toEqual({ text: expect.stringContaining('f:src/shapes.ts written'), code: 0 })
    const e = read().entries['f:src/shapes.ts']
    expect(e).toMatchObject({ name: 'Shapes', summary: 'The shapes the app draws.', surface: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(e.content).toBe(contentFingerprint(fs.readFileSync(path.join(root, 'src/shapes.ts'), 'utf8')))
    // gone stale (its surface moved on), then checked: the words stay, the stamp is today's
    fs.writeFileSync(file(), JSON.stringify({ entries: { 'f:src/shapes.ts': { ...e, surface: 'old' } } }))
    expect(run('set', ['src/shapes.ts']).text).toContain('checked')
    expect(read().entries['f:src/shapes.ts']).toEqual(e)
  })

  it('refuses what the code lacks, and a first entry without a summary', () => {
    expect(run('set', ['src/nope.ts'], { summary: 'x' })).toMatchObject({ code: 4, text: expect.stringContaining('nothing named src/nope.ts') })
    expect(run('set', ['src/util.ts'])).toMatchObject({ code: 2, text: expect.stringContaining('--summary') })
    expect(fs.existsSync(file())).toBe(false)
  })

  it('applies many at once, the project and folders too, and names what it left out', () => {
    const json = path.join(root, 'words.json')
    fs.writeFileSync(json, JSON.stringify({ project: 'A drawing app.', src: 'All the code.', 'src/app.ts': { name: 'Start', summary: 'Starts the app.' }, 's:src/shapes.ts#Circle': 'A round shape.', 'src/gone.ts': 'x', 'src/util.ts': { name: 'no summary' } }))
    const r = run('apply', [json])
    expect(r.code).toBe(4)
    expect(r.text).toContain('3 written, 0 rewritten')
    expect(r.text).toContain('no summary, left out: src/util.ts')
    expect(r.text).toContain('left out: src/gone.ts')
    const d = read()
    expect(d.project).toBe('A drawing app.')
    expect(Object.keys(d.entries)).toEqual(['d:src', 'f:src/app.ts', 's:src/shapes.ts#Circle'])
    expect(d.entries['d:src'].surface).toBeUndefined() // a folder never goes stale
    expect(run('apply', ['-'], { stdin: () => '{"src/app.ts": "Starts it."}' }).text).toContain('0 written, 1 rewritten')
  })

  it('reports coverage, stale entries and orphans, and lists what to describe next with digests', () => {
    run('set', ['src/util.ts'], { summary: 'Helpers.' })
    const d = read()
    fs.writeFileSync(file(), JSON.stringify({ entries: { ...d.entries, 'f:src/util.ts': { ...d.entries['f:src/util.ts'], surface: 'old' }, 'f:src/moved.ts': { summary: 'Moved away.' } } }))
    const status = run('status').text
    expect(status).toMatch(/files\s+1 of \d+ described \(1 stale\)/)
    expect(status).toContain('Stale')
    expect(status).toContain('f:src/moved.ts')
    const json = JSON.parse(run('status', [], { format: 'json' }).text)
    expect(json).toMatchObject({ stale: ['f:src/util.ts'], orphans: ['f:src/moved.ts'] })
    const todo = run('todo', ['src'], { max: 3 }).text
    expect(todo).toContain('## file f:src/util.ts  (stale)')
    expect(todo).toContain('now: Helpers.')
    expect(todo).toMatch(/exports: /)
    expect(todo).toContain('archrift describe apply')
  })

  it('syncs: an entry follows its file to a new name, the rest of the orphans go', () => {
    run('set', ['src/util.ts'], { summary: 'Helpers.' })
    const d = read()
    // as if src/util.ts had been src/helpers.ts when it was described
    fs.writeFileSync(file(), JSON.stringify({ entries: { 'f:src/helpers.ts': d.entries['f:src/util.ts'], 'f:src/deleted.ts': { summary: 'Gone.' } } }))
    const r = run('sync')
    expect(r.text).toContain('1 carried over, 1 dropped')
    expect(r.text).toContain('src/helpers.ts  is now  src/util.ts')
    expect(Object.keys(read().entries)).toEqual(['f:src/util.ts'])
  })
})
