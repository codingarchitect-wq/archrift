import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/analyzer/config.ts'
import { analyzeIsolated } from '../../src/analyzer/isolated.ts'
import { copyFixture } from '../helpers/fixtures.ts'

// `serve` keeps running while archrift's code changes: its process loads a project's config with the
// schema it started with, and each analysis worker loads the code on disk. A config block added since
// (docs, 2026-11-02) was missing from the config the server handed the worker, which crashed on it.
describe('the analysis worker', () => {
  let root = ''
  beforeAll(() => {
    root = copyFixture('plain-ts')
    fs.writeFileSync(path.join(root, 'README.md'), '# Plain\n\nThe app starts in `src/app.ts`.\n')
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it("fills in the config's defaults itself, for a config parsed before a block existed", async () => {
    const { docs: _, ...older } = loadConfig(root)
    const graph = await analyzeIsolated({ root, config: older as ReturnType<typeof loadConfig>, cacheDir: false, history: false })
    expect(graph.meta.docs?.docs.map(d => d.path)).toEqual(['README.md'])
  })
})
