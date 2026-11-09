import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../src/analyzer/config.ts'
import { currentDocs, docFiles, readDocs } from '../../src/analyzer/docs.ts'
import type { Graph } from '../../src/core/model.ts'

// a project in app/, its documents in app/docs, app/README.md and, beside it, ../decisions
const top = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-docs-'))
const root = path.join(top, 'app')
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(top, rel)), { recursive: true })
  fs.writeFileSync(path.join(top, rel), text)
}
write('app/README.md', '# App\n\nStart at `src/lib/db.ts`.\n')
write('app/docs/data.md', '# Data\n\n## Storage\n\n`openDb` opens [the database](../src/lib/db.ts).\n')
write('app/docs/historical/2025.md', '# Old\n\nsrc/lib/db.ts was in src/lib/legacy.ts\n')
write('app/docs/node_modules/x.md', '# ignored\n')
write('app/docs/image.png', 'not a document')
write('decisions/ADR.html', '<title>Decisions</title>\n<table>\n<tr><td>D7</td><td>The database opens once</td></tr>\n</table>\n')
write('app/src/lib/db.ts', '// D7: opened once\nexport function openDb() {}\n// D8 is no decision anyone wrote down\n')
afterAll(() => fs.rmSync(top, { recursive: true, force: true }))

function graph(): Graph {
  return {
    meta: { name: 'app', generatedAt: '', tool: { name: 'archrift', version: '' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } },
    nodes: [
      { id: 'd:src', kind: 'directory', name: 'src', path: 'src' },
      { id: 'd:src/lib', kind: 'directory', name: 'lib', path: 'src/lib', parent: 'd:src' },
      { id: 'f:src/lib/db.ts', kind: 'file', name: 'db.ts', path: 'src/lib/db.ts', parent: 'd:src/lib' },
      { id: 's:src/lib/db.ts#openDb', kind: 'symbol', subkind: 'function', name: 'openDb', path: 'src/lib/db.ts', parent: 'f:src/lib/db.ts', exported: true },
    ],
    edges: [],
    sites: [],
  }
}

const readCode = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('reading the documents', () => {
  it('lists the documents of folders, files and globs, outside the root too, skipping dependencies and other files', () => {
    expect(docFiles(root, ['README.md', 'docs', '../decisions', 'missing', '*.md'])).toEqual(['../decisions/ADR.html', 'README.md', 'docs/data.md', 'docs/historical/2025.md'])
  })

  it('keeps current what the entries say, never a records folder', () => {
    const current = currentDocs(['docs', 'README.md', '../decisions/*.html'])
    expect(['docs/data.md', 'docs/historical/2025.md', 'README.md', '../decisions/ADR.html', 'notes.md'].map(current)).toEqual([true, false, true, true, false])
  })

  it('links the documents to the code, and the ids the code cites to where they are defined', () => {
    const g = graph()
    const config = ConfigSchema.parse({ docs: { include: ['README.md', 'docs', '../decisions'], current: ['README.md', 'docs'] } })
    readDocs(g, { root, config, readCode })
    const docs = g.meta.docs!
    expect(docs.docs.map(d => [d.path, d.title, !!d.current, d.mentions.map(m => m.node)])).toEqual([
      ['../decisions/ADR.html', 'Decisions', false, []],
      ['README.md', 'App', true, ['f:src/lib/db.ts']],
      ['docs/data.md', 'Data', true, ['f:src/lib/db.ts', 's:src/lib/db.ts#openDb']],
      ['docs/historical/2025.md', 'Old', false, ['f:src/lib/db.ts']],
    ])
    expect(docs.docs[3].dangling).toEqual([{ text: 'src/lib/legacy.ts', line: 3, section: 'Old' }])
    expect(docs.ids).toEqual([{ id: 'D7', defined: [{ doc: '../decisions/ADR.html', line: 3, label: 'The database opens once' }], cited: [{ file: 'src/lib/db.ts', line: 1, count: 1, docs: ['../decisions/ADR.html'] }] }])
    expect(g.meta.counts).toMatchObject({ docs: 4, docMentions: 4, decisionIds: 1 })
  })

  it('reads ids by the configured pattern, or none', () => {
    const g = graph()
    readDocs(g, { root, config: ConfigSchema.parse({ docs: { include: ['../decisions'], ids: false } }), readCode })
    expect(g.meta.docs!.ids).toEqual([])
    expect(() => readDocs(graph(), { root, config: ConfigSchema.parse({ docs: { include: ['../decisions'], ids: '(' } }), readCode })).toThrow(/docs.ids/)
  })

  it('sets nothing when there are no documents', () => {
    const g = graph()
    readDocs(g, { root, config: ConfigSchema.parse({ docs: { include: ['nothing-here'] } }), readCode })
    expect(g.meta.docs).toBeUndefined()
  })

  it('parses a document again in watch mode only when it changed', () => {
    const session = new Map<string, unknown>()
    const config = ConfigSchema.parse({ docs: { include: ['docs/data.md'] } })
    readDocs(graph(), { root, config, readCode, session })
    const memo = session.get('docs') as Map<string, { doc: unknown }>
    const first = memo.get('docs/data.md')!.doc
    readDocs(graph(), { root, config, readCode, session })
    expect(memo.get('docs/data.md')!.doc).toBe(first)
  })
})
