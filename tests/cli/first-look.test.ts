import { describe, expect, it } from 'vitest'
import { firstLookMarkdown, firstLookText } from '../../src/cli/first-look.ts'
import { firstLookHtml } from '../../src/cli/first-look-html.ts'
import type { FirstLook } from '../../src/core/first-look.ts'

const commands = { cli: 'archrift', root: '~/src/app' }

/** A first look with nothing in it but what a test adds. */
const look = (more: Partial<FirstLook> = {}): FirstLook => ({
  project: 'app',
  root: '/src/app',
  generatedAt: '2026-11-02T10:00:00.000Z',
  stack: ['TypeScript'],
  notes: [],
  size: { files: 3, loc: 30, tests: 0, functions: 2, languages: [{ name: 'TypeScript', files: 3 }] },
  config: { path: '.archrift/config.json', status: 'dry-run' },
  excluded: [],
  vendored: [],
  layers: [],
  blocks: [],
  cycles: { count: 0, largest: [] },
  hotspots: [],
  bridges: [],
  questions: [],
  coherence: { mixed: [], one: [] },
  functions: { bands: [{ label: '1–4', count: 2 }], largest: [] },
  deadExports: { count: 0, folders: [] },
  rules: [],
  ...more,
})

const found = look({
  bridges: [
    { path: 'src/hooks/index.ts', block: 'src/hooks', score: 0.0702, fanIn: 206, fanOut: 17, above: [{ block: 'src/components', files: 187 }, { block: 'src/app', files: 17 }], below: [{ block: 'src/hooks', files: 16 }, { block: 'src/contexts', files: 1 }] },
    { path: 'src/lib/<odd>.ts', block: 'src/lib', score: 0.01, fanIn: 1, fanOut: 2, above: [{ block: 'src/app', files: 1 }], below: [{ block: 'src/server', files: 2 }] },
  ],
  questions: [
    { type: 'bridge', question: 'Why does `src/hooks/index.ts` connect `src/components` and `src/app` to `src/hooks`?', why: '7 % of the shortest dependency paths run through it', files: ['src/hooks/index.ts'] },
    { type: 'unused file', question: 'Is `src/lib/old.ts` still used? Nothing depends on it.', why: '40 lines; no production file imports or calls it', files: ['src/lib/old.ts'] },
  ],
})

describe('the first look’s bridges and questions', () => {
  it('as text: each bridge with its numbers and blocks, each question with its type and why', () => {
    const text = firstLookText(found, commands)
    expect(text).toContain('Bridges: the files the most shortest dependency paths between two other files run through')
    expect(text).toContain('   1. src/hooks/index.ts  (src/hooks)  betweenness 0.0702 · 206 files use it · it uses 17\n      used by src/components 187 · src/app 17; uses src/hooks 16 · src/contexts 1')
    expect(text).toContain('   2. src/lib/<odd>.ts  (src/lib)  betweenness 0.01 · 1 file uses it · it uses 2')
    expect(text).toContain('Questions worth asking: ')
    expect(text).toContain('   2. Is `src/lib/old.ts` still used? Nothing depends on it.  (unused file)\n      40 lines; no production file imports or calls it')
    // the questions come after the rules, before what to run next
    expect(text.indexOf('Questions worth asking')).toBeLessThan(text.indexOf('\nNext\n'))
  })

  it('as markdown: a table of bridges and a numbered list of questions', () => {
    const md = firstLookMarkdown(found, commands)
    expect(md).toContain('## Bridges')
    expect(md).toContain('| 1 | `src/hooks/index.ts` | `src/hooks` | 0.0702 | 206 | 17 | src/components 187 · src/app 17 | src/hooks 16 · src/contexts 1 |')
    expect(md).toContain('## Questions worth asking')
    expect(md).toContain('1. Why does `src/hooks/index.ts` connect `src/components` and `src/app` to `src/hooks`? _(bridge)_\n   - 7 % of the shortest dependency paths run through it')
  })

  it('as a page: a chart and table of the bridges, the questions with code set as code, all escaped', () => {
    const html = firstLookHtml(found, commands)
    expect(html).toContain('<h2>Bridges</h2>')
    expect(html).toContain('aria-label="Bridges"')
    expect(html).toContain('<td><code>src/hooks/index.ts</code></td><td><code>src/hooks</code></td><td class="num">0.0702</td>')
    expect(html).toContain('<code>src/lib/&lt;odd&gt;.ts</code>')
    expect(html).not.toContain('<odd>')
    expect(html).toContain('<h2>Questions worth asking</h2>')
    expect(html).toContain('<li><span class="q">Is <code>src/lib/old.ts</code> still used? Nothing depends on it.</span><span class="kind">unused file</span><p class="why">40 lines; no production file imports or calls it</p></li>')
  })

  it('leave both sections out when there is nothing to show', () => {
    const empty = look()
    for (const out of [firstLookText(empty, commands), firstLookMarkdown(empty, commands), firstLookHtml(empty, commands)]) {
      expect(out).toContain('Dead exports')
      expect(out).not.toContain('Bridges')
      expect(out).not.toContain('Questions worth asking')
    }
  })
})
