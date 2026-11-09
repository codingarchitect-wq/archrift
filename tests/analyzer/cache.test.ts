import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dumpGraph } from '../../src/core/dump.ts'
import { analyzeFixture, copyFixture, edge } from '../helpers/fixtures.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function workspace() {
  const root = copyFixture('plain-ts')
  dirs.push(root)
  const cacheDir = path.join(root, '.archrift', 'cache')
  const run = () => analyzeFixture('plain-ts', { root, cacheDir })
  const cold = () => analyzeFixture('plain-ts', { root, cacheDir: false })
  const write = (file: string, text: string) => fs.writeFileSync(path.join(root, file), text)
  const append = (file: string, text: string) => fs.appendFileSync(path.join(root, file), text)
  return { root, run, cold, write, append }
}

describe('fragment cache', () => {
  it('reuses every fragment when nothing changed, with an identical graph', async () => {
    const w = workspace()
    const first = await w.run()
    const second = await w.run()
    expect(first.meta.cache).toEqual({ hits: 0, misses: 10 })
    expect(second.meta.cache).toEqual({ hits: 10, misses: 0 })
    expect(dumpGraph(second)).toBe(dumpGraph(first))
  })

  it('re-analyzes a changed file and the files that referenced into it', async () => {
    const w = workspace()
    await w.run()
    w.append('src/util.ts', '\nexport const added = 1\n')
    const warm = await w.run()
    // util.ts itself, plus app.ts and shapes.ts whose references resolved into it
    expect(warm.meta.cache?.misses).toBeGreaterThanOrEqual(3)
    expect(warm.meta.cache?.hits).toBeGreaterThan(0)
    expect(dumpGraph(warm)).toBe(dumpGraph(await w.cold()))
  })

  it('invalidates dependents when a referenced declaration disappears', async () => {
    const w = workspace()
    await w.run()
    w.write('src/lazy.ts', 'export function loadRenamed(message: string) {\n  return message.length\n}\n')
    const warm = await w.run()
    expect(edge(warm, 's:src/app.ts#main', 'calls', 's:src/lazy.ts#load')).toBeUndefined()
    expect(dumpGraph(warm)).toBe(dumpGraph(await w.cold()))
  })

  it('re-analyzes a file when one of its imports starts resolving somewhere else', async () => {
    const w = workspace()
    w.append('src/app.ts', "\nimport { later } from './later'\nexport const useLater = () => later()\n")
    const before = await w.run()
    expect(before.meta.diagnostics.unresolvedImports.map(u => u.spec)).toEqual(['./later'])
    w.write('src/later.ts', 'export function later() {\n  return 1\n}\n')
    const after = await w.run()
    expect(edge(after, 's:src/app.ts#useLater', 'calls', 's:src/later.ts#later')).toBeDefined()
    expect(dumpGraph(after)).toBe(dumpGraph(await w.cold()))
  })
})
