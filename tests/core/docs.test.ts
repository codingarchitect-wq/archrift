import { describe, expect, it } from 'vitest'
import { DEFAULT_ID_PATTERN, citedIds, docsNaming, docsOfNode, findDoc, idsCitedBy, linkDocs, naturalCmp, normalize, parseDoc, staleDocs } from '../../src/core/docs.ts'
import type { DocsMeta, ParsedDoc } from '../../src/core/docs.ts'
import { GraphIndex } from '../../src/core/graph-index.ts'
import type { Graph, GraphNode } from '../../src/core/model.ts'

const IDS = new RegExp(DEFAULT_ID_PATTERN)

function graph(): Graph {
  const dir = (path: string, parent?: string): GraphNode => ({ id: `d:${path}`, kind: 'directory', name: path.split('/').pop()!, path, ...(parent ? { parent: `d:${parent}` } : {}) })
  const file = (path: string): GraphNode => ({ id: `f:${path}`, kind: 'file', name: path.split('/').pop()!, path, parent: `d:${path.slice(0, path.lastIndexOf('/'))}` })
  const nodes: GraphNode[] = [
    dir('src'),
    dir('src/lib', 'src'),
    dir('src/app', 'src'),
    dir('src/app/(dashboard)', 'src/app'),
    file('src/lib/db.ts'),
    file('src/lib/api.ts'),
    file('src/app/page.tsx'),
    file('src/app/(dashboard)/page.tsx'),
    { id: 's:src/lib/db.ts#openDb', kind: 'symbol', subkind: 'function', name: 'openDb', path: 'src/lib/db.ts', parent: 'f:src/lib/db.ts', exported: true, signature: '(): Db' },
    { id: 's:src/lib/api.ts#ApiClient', kind: 'symbol', subkind: 'class', name: 'ApiClient', path: 'src/lib/api.ts', parent: 'f:src/lib/api.ts', exported: true },
    { id: 's:src/lib/api.ts#ApiClient.fetchAll', kind: 'member', subkind: 'method', name: 'fetchAll', path: 'src/lib/api.ts', parent: 's:src/lib/api.ts#ApiClient' },
    { id: 's:src/lib/api.ts#config', kind: 'symbol', subkind: 'variable', name: 'config', path: 'src/lib/api.ts', parent: 'f:src/lib/api.ts', exported: true },
  ]
  return { meta: { name: 'app', generatedAt: '', tool: { name: 'archrift', version: '' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } }, nodes, edges: [], sites: [] }
}

const link = (docs: ParsedDoc[], citations = new Map(), current = (_: string) => true) => {
  const g = graph()
  return linkDocs({ graph: g, index: new GraphIndex(g), docs, citations, current })
}

describe('reading a markdown document', () => {
  const md = [
    '# Data layer',
    '',
    'The client lives in [the API](../app/src/lib/api.ts) and `src/lib/` holds the rest.',
    '## 4.10 Savings plans (D34)',
    'Call `openDb()` and `ApiClient.fetchAll`; set `config` once.',
    '| ID | Date | Decision |',
    '|---|---|---|',
    '| D26 | 2026-07-10 | Retirement on the scenario |',
    '**D45 — the children live on the AVD.**',
    '- [x] **R6 Zod-first entity schemas** (long-term)',
    '```',
    '# not a heading src/app/page.tsx',
    '```',
  ].join('\n')
  const doc = parseDoc('docs/data.md', md, IDS)

  it('takes the title from the first heading, and each place under the heading above it', () => {
    expect(doc.title).toBe('Data layer')
    expect(doc.paths.map(p => p.text)).toEqual(['../app/src/lib/api.ts', 'src/lib/', 'src/app/page.tsx'])
    expect(doc.paths[2]).toMatchObject({ line: 12, section: '4.10 Savings plans (D34)' })
  })

  it('reads names in code spans that look like code, not plain words', () => {
    expect(doc.symbols.map(s => s.text)).toEqual(['openDb', 'ApiClient.fetchAll'])
  })

  it('finds ids defined in a heading, a table row (its first telling cell), a bold lead and a checklist item', () => {
    expect(doc.definitions).toEqual([
      { id: 'D34', line: 4, label: '4.10 Savings plans (D34)' },
      { id: 'D26', line: 8, label: 'Retirement on the scenario' },
      { id: 'D45', line: 9, label: 'the children live on the AVD.' },
      { id: 'R6', line: 10, label: 'Zod-first entity schemas (long-term)' },
    ])
  })

  it('reads no ids without a pattern', () => {
    expect(parseDoc('docs/data.md', md).definitions).toEqual([])
  })
})

describe('reading an HTML document', () => {
  const html = [
    '<html><head><title>5. Building blocks</title></head><body>',
    '<h2 id="l1">5.1 Level 1 &amp; more</h2>',
    '<p>See <a href="../app/src/lib/db.ts">the database</a> and <code>ApiClient</code>.</p>',
    '<table>',
    '<tr><td class="id">G12</td><td>2026-08-29</td><td>No token issuer offline</td></tr>',
    '<li><strong>Q43</strong> a session token carries the nonce</li>',
  ].join('\n')
  const doc = parseDoc('../architecture/05.html', html, IDS)

  it('takes the title, the sections, links and code spans', () => {
    expect(doc.title).toBe('5. Building blocks')
    expect(doc.paths).toEqual([{ text: '../app/src/lib/db.ts', line: 3, section: '5.1 Level 1 & more' }])
    expect(doc.symbols.map(s => s.text)).toEqual(['ApiClient'])
  })

  it('finds ids in a table row and a bold lead', () => {
    expect(doc.definitions).toEqual([
      { id: 'G12', line: 5, label: 'No token issuer offline' },
      { id: 'Q43', line: 6, label: 'a session token carries the nonce' },
    ])
  })
})

describe('matching documents to the code', () => {
  const doc = (paths: string[], symbols: string[] = []): ParsedDoc => ({ path: 'docs/a.md', title: 'A', paths: paths.map((text, i) => ({ text, line: i + 1 })), symbols: symbols.map((text, i) => ({ text, line: 100 + i })), definitions: [] })

  it('finds a file by its path, a longer one, or a name only one file has; a folder by its path', () => {
    const m = link([doc(['src/lib/db.ts', '../app/src/lib/api.ts', 'api.ts', 'src/app/(dashboard)/page.tsx', 'src/lib/'])])
    expect(m.docs[0].mentions.map(x => x.node)).toEqual(['f:src/lib/db.ts', 'f:src/lib/api.ts', 'f:src/app/(dashboard)/page.tsx', 'd:src/lib'])
    expect(m.docs[0].mentions[1].count).toBe(2)
  })

  it('leaves a name several files have, a one-segment folder and another project’s paths unmatched, and keeps the paths with a slash', () => {
    const m = link([doc(['page.tsx', 'lib/', 'other/src/cli/main.ts', '(src/gone.ts'])])
    expect(m.docs[0].mentions).toEqual([])
    expect(m.docs[0].dangling?.map(d => d.text)).toEqual(['other/src/cli/main.ts', 'src/gone.ts'])
  })

  it('finds exported declarations by a name only one file has, and members', () => {
    const m = link([doc([], ['openDb', 'ApiClient.fetchAll', 'ApiClient.missing', 'Nothing'])])
    expect(m.docs[0].mentions.map(x => x.node)).toEqual(['s:src/lib/db.ts#openDb', 's:src/lib/api.ts#ApiClient.fetchAll', 's:src/lib/api.ts#ApiClient'])
  })

  it('normalizes link targets and brackets', () => {
    expect(normalize('[x](../../src/lib/db.ts')).toBe('src/lib/db.ts')
    expect(normalize('(src/lib/db.ts')).toBe('src/lib/db.ts')
    expect(normalize('(dashboard)/page.tsx')).toBe('(dashboard)/page.tsx')
  })
})

describe('decision ids', () => {
  const defs = (path: string, definitions: ParsedDoc['definitions'], paths: string[] = []): ParsedDoc => ({ path, title: path, paths: paths.map(text => ({ text, line: 1 })), symbols: [], definitions })

  it('finds where code cites them, first line and count', () => {
    const cited = citedIds('// D34: plans\nconst x = 1 // D34, D2\n// D99', IDS, id => id !== 'D99')
    expect([...cited]).toEqual([
      ['D34', { line: 1, count: 2, text: '// D34: plans' }],
      ['D2', { line: 2, count: 1, text: 'const x = 1 // D34, D2' }],
    ])
  })

  it('count only where a document defines them, in natural order', () => {
    const m = link([defs('docs/plan.md', [{ id: 'D10', line: 3, label: 'ten' }, { id: 'D2', line: 2, label: 'two' }])], new Map([['src/lib/db.ts', new Map([['D10', { line: 4, count: 1, text: '' }], ['D2', { line: 1, count: 1, text: '' }], ['D7', { line: 9, count: 1, text: '' }]])]]))
    expect(m.ids.map(i => i.id)).toEqual(['D2', 'D10'])
    expect(m.ids[0].cited).toEqual([{ file: 'src/lib/db.ts', line: 1, count: 1, docs: ['docs/plan.md'] }])
    expect(['D10', 'D2', 'ADR-12', 'ADR-3'].sort(naturalCmp)).toEqual(['ADR-3', 'ADR-12', 'D2', 'D10'])
  })

  it('meant from the definition sharing words with the citing line, else the document naming files beside it', () => {
    const docs = [defs('docs/desktop.md', [{ id: 'G12', line: 4, label: 'No token issuer offline' }]), defs('docs/guide.md', [{ id: 'G12', line: 9, label: 'Animation and interactivity policy' }], ['src/app/page.tsx'])]
    const citations = new Map([
      ['src/lib/db.ts', new Map([['G12', { line: 2, count: 1, text: '// G12: animations are finite' }]])],
      ['src/app/layout.tsx', new Map([['G12', { line: 2, count: 1, text: '// G12' }]])],
      ['src/lib/api.ts', new Map([['G12', { line: 2, count: 1, text: '// G12' }]])],
    ])
    const m = link(docs, citations)
    const meant = Object.fromEntries(m.ids[0].cited.map(c => [c.file, c.docs]))
    expect(meant['src/lib/db.ts']).toEqual(['docs/guide.md'])
    expect(meant['src/app/layout.tsx']).toEqual(['docs/guide.md'])
    expect(meant['src/lib/api.ts']).toEqual(['docs/desktop.md', 'docs/guide.md'])
  })
})

describe('asking', () => {
  const meta: DocsMeta = {
    docs: [
      { path: 'docs/old/a.md', title: 'Old', mentions: [{ node: 'f:src/lib/db.ts', line: 1, count: 5 }] },
      { path: 'docs/b.md', title: 'B', current: true, mentions: [{ node: 's:src/lib/db.ts#openDb', line: 7, section: 'Opening', count: 1 }, { node: 'd:src/lib', line: 9, count: 1 }] },
    ],
    ids: [{ id: 'D34', defined: [{ doc: 'docs/b.md', line: 2, label: 'Plans' }, { doc: 'docs/old/a.md', line: 3, label: 'Plans, first' }], cited: [{ file: 'src/lib/db.ts', line: 4, count: 1, docs: ['docs/b.md'] }] }],
  }

  it('lists the documents naming code, kept current first', () => {
    expect(docsNaming(meta, new Set(['f:src/lib/db.ts', 's:src/lib/db.ts#openDb'])).map(r => r.doc)).toEqual(['docs/b.md', 'docs/old/a.md'])
  })

  it('gives a viewer node its documents and ids: a file with its functions, a folder with everything below', () => {
    const file = docsOfNode(meta, { id: 'f:src/lib/db.ts', kind: 'file', path: 'src/lib/db.ts' })
    expect(file.named.map(r => r.doc)).toEqual(['docs/b.md', 'docs/old/a.md'])
    expect(file.cites).toEqual([{ id: 'D34', file: 'src/lib/db.ts', line: 4, meant: [meta.ids[0].defined[0]], also: [meta.ids[0].defined[1]] }])
    const folder = docsOfNode(meta, { id: 'd:src/lib', kind: 'directory', path: 'src/lib' })
    expect(folder.named[0].places.map(p => p.node)).toEqual(['s:src/lib/db.ts#openDb', 'd:src/lib'])
    expect(folder.cites.map(c => c.id)).toEqual(['D34'])
    expect(docsOfNode(meta, { id: 's:src/lib/db.ts#openDb', kind: 'symbol', path: 'src/lib/db.ts' }).named.map(r => r.doc)).toEqual(['docs/b.md'])
  })

  it('finds a document by its path or the end of it', () => {
    expect(findDoc(meta, 'b.md')?.path).toBe('docs/b.md')
    expect(findDoc(meta, './docs/b.md')?.path).toBe('docs/b.md')
    expect(findDoc(meta, 'c.md')).toBeUndefined()
    expect(idsCitedBy(meta, new Set(['src/other.ts']))).toEqual([])
  })
})

describe('after a change', () => {
  const doc = (path: string, nodes: string[], dangling: string[] = [], current = true) => ({ path, title: path, ...(current ? { current: true as const } : {}), mentions: nodes.map((node, i) => ({ node, line: i + 1, count: 1 })), ...(dangling.length ? { dangling: dangling.map((text, i) => ({ text, line: 50 + i })) } : {}) })

  it('names the places in current documents naming what is gone or reshaped, and paths naming removed files', () => {
    const base: DocsMeta = { docs: [doc('docs/a.md', ['f:src/old.ts', 's:src/lib/db.ts#openDb']), doc('docs/history/x.md', ['f:src/old.ts'], [], false)], ids: [] }
    const head: DocsMeta = { docs: [doc('docs/a.md', ['s:src/lib/db.ts#openDb'], ['src/old.ts']), doc('docs/b.md', ['f:src/lib/api.ts'], ['app/src/gone.ts'])], ids: [] }
    const stale = staleDocs(base, head, { removed: ['src/old.ts', 'src/gone.ts'], gone: n => n === 'f:src/old.ts', reshaped: n => n === 's:src/lib/db.ts#openDb' })
    expect(stale.map(s => [s.doc, s.line, s.names, s.path, s.why])).toEqual([
      ['docs/a.md', 1, 'src/old.ts', 'src/old.ts', 'removed'],
      ['docs/a.md', 1, 'src/lib/db.ts › openDb', 'src/lib/db.ts', 'reshaped'],
      ['docs/b.md', 50, 'src/gone.ts', 'src/gone.ts', 'removed'],
    ])
  })

  it('finds nothing without documents', () => {
    expect(staleDocs(undefined, undefined, { removed: ['a.ts'], gone: () => true, reshaped: () => true })).toEqual([])
  })
})
