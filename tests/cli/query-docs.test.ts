// `archrift query docs` and the documents in `query file` and `query overview`:
// which documents name the code, and the decision ids it cites (config docs).
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/analyzer/config.ts'
import { answer, queryFor } from '../../src/cli/query.ts'
import type { Question } from '../../src/cli/query.ts'
import type { Graph } from '../../src/core/model.ts'
import { FIXTURES, analyzeFixture } from '../helpers/fixtures.ts'

const root = path.join(FIXTURES, 'plain-ts')
let graph: Graph
beforeAll(async () => {
  graph = await analyzeFixture('plain-ts')
  graph.meta.docs = {
    docs: [
      {
        path: 'docs/shapes.md',
        title: 'Shapes',
        current: true,
        mentions: [
          { node: 'f:src/shapes.ts', line: 3, section: 'Drawing', count: 2 },
          { node: 's:src/shapes.ts#makeCircle', line: 5, section: 'Drawing', count: 1 },
        ],
        dangling: [{ text: 'src/gone.ts', line: 8 }],
      },
      { path: '../decisions/ADR.md', title: 'Decisions', mentions: [{ node: 'd:src', line: 2, count: 1 }] },
    ],
    ids: [
      {
        id: 'D7',
        defined: [
          { doc: '../decisions/ADR.md', line: 4, label: 'Circles are drawn from their centre' },
          { doc: 'docs/shapes.md', line: 1, label: 'Circles' },
        ],
        cited: [{ file: 'src/shapes.ts', line: 2, count: 1, docs: ['../decisions/ADR.md'] }],
      },
    ],
  }
})

const ask = (question: Question, paths: string[] = [], format: 'text' | 'json' = 'text') => answer(queryFor(graph, loadConfig(root)), { question, paths, format })

describe('query docs', () => {
  it('lists the documents naming a file (not those naming only its folder), and the ids it cites with where they are defined', () => {
    const r = ask('docs', ['src/shapes.ts'])
    expect(r.code).toBe(0)
    expect(r.text).toBe(
      [
        'src/shapes.ts: named in 1 document, cites 1 decision id',
        '',
        'Cites:',
        '  D7 (line 2): Circles are drawn from their centre — ../decisions/ADR.md:4; also defined in 1 other document',
        '',
        'Named in (kept current first):',
        '  docs/shapes.md (kept current)',
        '    § Drawing, line 3: src/shapes.ts (2×)',
        '    § Drawing, line 5: src/shapes.ts › makeCircle',
        '',
      ].join('\n'),
    )
  })

  it('lists the documents naming a folder or anything in it, kept current first', () => {
    const r = ask('docs', ['src'])
    expect(r.text).toMatch(/^src\/: named in 2 documents, cites 1 decision id\n/)
    expect(r.text).toMatch(/Named in \(kept current first\):\n {2}docs\/shapes\.md \(kept current\)\n[^]*\n {2}\.\.\/decisions\/ADR\.md\n {4}line 2: src\/\n/)
  })

  it('narrows to one function, as `path#name`', () => {
    const r = ask('docs', ['src/shapes.ts#makeCircle'])
    expect(r.text.split('\n')[0]).toBe('src/shapes.ts#makeCircle: named in 1 document')
  })

  it('tells where an id is defined and who cites it', () => {
    const r = ask('docs', ['D7'])
    expect(r.text).toBe(
      [
        'D7: defined in 2 documents',
        '  ../decisions/ADR.md:4  Circles are drawn from their centre',
        '  docs/shapes.md:1 (kept current)  Circles',
        '',
        'Cited by 1 file:',
        '  src/shapes.ts:2  → ../decisions/ADR.md',
        '',
      ].join('\n'),
    )
  })

  it('tells what a document names, by section, the ids it defines and the paths no file has', () => {
    const r = ask('docs', ['shapes.md'])
    expect(r.text).toContain('docs/shapes.md: Shapes (kept current)')
    expect(r.text).toContain('  § Drawing: src/shapes.ts, src/shapes.ts › makeCircle')
    expect(r.text).toContain('  D7 (line 1): Circles  — cited by 1 file, 0 meaning this document')
    expect(r.text).toContain('Paths it names that no file has (1): src/gone.ts')
  })

  it('answers in JSON, and says when nothing has that name', () => {
    expect(JSON.parse(ask('docs', ['D7'], 'json').text)).toMatchObject({ kind: 'id', id: { id: 'D7' }, current: ['docs/shapes.md'] })
    expect(ask('docs', ['Z9'])).toEqual({ text: 'Z9: no file, folder, function, decision id or document by that name\n', code: 4 })
    expect(ask('docs', []).code).toBe(2)
  })
})

describe('documents in query file and query overview', () => {
  it('query file lists the ids it cites and the documents naming it', () => {
    const r = ask('file', ['src/shapes.ts'])
    expect(r.text).toContain('Docs (query docs <path> for all):\n  cites D7 (line 2): Circles are drawn from their centre — ../decisions/ADR.md:4; also defined in 1 other document\n  named in docs/shapes.md (kept current)  § Drawing, line 3 (+1 more)')
  })

  it('query overview counts the documents', () => {
    expect(ask('overview').text).toContain('  documents: 2 (1 kept current), 2 of them naming code; the code cites 1 decision id (query docs <path | id>)')
  })
})
