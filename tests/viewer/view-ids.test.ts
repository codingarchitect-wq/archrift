// The view ids the command line knows (export html --view) are the viewer's own:
// the three built in, and every folder of src/viewer/views with an index.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { VIEW_IDS } from '../../src/viewer/url-state.ts'

describe('the view ids', () => {
  it('are the built-in views and every view plug-in', () => {
    const dir = path.resolve(import.meta.dirname, '../../src/viewer/views')
    const plugins = fs.readdirSync(dir).filter(d => ['index.ts', 'index.tsx'].some(f => fs.existsSync(path.join(dir, d, f))))
    expect([...VIEW_IDS].sort()).toEqual(['city', 'galaxy', 'layers', ...plugins].sort())
  })
})
