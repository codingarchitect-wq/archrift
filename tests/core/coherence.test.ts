import { describe, expect, it } from 'vitest'
import { coherenceModel, fileLinks, folderBlocks, paradigmsOf, recentSince } from '../../src/core/coherence.ts'
import type { CoherenceInput } from '../../src/core/coherence.ts'
import type { ConcernMeta, Graph, GraphNode } from '../../src/core/model.ts'

const day = 86_400

/** A file in a block (its first folder) using `concern=way` pairs, first committed on `born` (days). */
function file(path: string, ways: string[], born?: number): GraphNode {
  return {
    id: `f:${path}`,
    kind: 'file',
    name: path.split('/').pop()!,
    path,
    tags: ways.map(w => `paradigm:${w}`),
    metrics: { loc: 10, ...(born !== undefined ? { firstCommit: born * day, lastCommit: born * day } : {}) },
  }
}

const DATES: ConcernMeta = {
  id: 'jvm.dates',
  label: 'Dates',
  stack: 'JVM',
  about: 'date and time values',
  paradigms: [
    { id: 'java-time', label: 'java.time' },
    { id: 'util-date', label: 'java.util.Date', legacy: true },
  ],
}
const WEB: ConcernMeta = {
  id: 'jvm.web',
  label: 'Web stack',
  stack: 'JVM',
  about: 'serving HTTP requests',
  paradigms: [
    { id: 'servlet', label: 'Spring MVC' },
    { id: 'webflux', label: 'WebFlux' },
  ],
}
const JSON_: ConcernMeta = { id: 'jvm.json', label: 'JSON', stack: 'JVM', about: 'JSON', paradigms: [{ id: 'jackson', label: 'Jackson' }] }
const STORE: ConcernMeta = {
  id: 'js.persistence',
  label: 'Database access',
  stack: 'JS',
  about: 'stored data',
  accepted: 'two tiers by design',
  paradigms: [
    { id: 'prisma', label: 'Prisma' },
    { id: 'dexie', label: 'Dexie' },
  ],
}

// two services: orders mixes date APIs (and one file uses both), billing keeps to java.time;
// orders serves with Spring MVC, gateway with WebFlux; everything uses Jackson
const FILES = [
  file('orders/A.kt', ['jvm.dates=java-time', 'jvm.web=servlet', 'jvm.json=jackson'], 10),
  file('orders/B.kt', ['jvm.dates=java-time', 'jvm.web=servlet'], 10),
  file('orders/C.kt', ['jvm.dates=util-date'], 10),
  file('orders/D.kt', ['jvm.dates=java-time', 'jvm.dates=util-date'], 90),
  file('billing/E.kt', ['jvm.dates=java-time', 'jvm.json=jackson'], 80),
  file('billing/F.kt', ['jvm.dates=java-time'], 95),
  file('gateway/G.kt', ['jvm.web=webflux'], 10),
  file('gateway/H.kt', ['jvm.web=webflux'], 10),
  file('web/db.ts', ['js.persistence=prisma'], 10),
  file('web/local.ts', ['js.persistence=dexie'], 10),
  file('web/plain.ts', [], 10),
]

const input = (over: Partial<CoherenceInput> = {}): CoherenceInput => ({
  files: FILES,
  concerns: [DATES, WEB, JSON_, STORE],
  links: [
    ['f:orders/A.kt', 'f:orders/C.kt'], // java.time → Date: a transition
    ['f:orders/B.kt', 'f:orders/D.kt'], // java.time → both: shares a way
    ['f:orders/A.kt', 'f:orders/C.kt'], // again: counted once
    ['f:billing/E.kt', 'f:billing/F.kt'],
    ['f:orders/A.kt', 'f:web/plain.ts'], // to a file doing none of it
  ],
  blockOf: f => f.path!.split('/')[0],
  since: 50 * day,
  ...over,
})

describe('coherence model', () => {
  const m = coherenceModel(input())
  const dates = m.byId.get('jvm.dates')!
  const web = m.byId.get('jvm.web')!

  it('reads the ways a file takes from its tags', () => {
    expect(paradigmsOf(FILES[3])).toEqual(new Map([['jvm.dates', ['java-time', 'util-date']]]))
    expect(m.ways.has('f:web/plain.ts')).toBe(false)
  })

  it('measures a concern: its ways, main way, coherence, stragglers and files on several ways', () => {
    expect(dates.kind).toBe('mixed')
    expect(dates.paradigms.map(p => [p.id, p.files.length])).toEqual([
      ['java-time', 5],
      ['util-date', 2],
    ])
    expect(dates.main.id).toBe('java-time')
    expect(dates.users).toBe(6)
    // A, B, E, F alone on java.time
    expect(dates.coherence).toBeCloseTo(4 / 6)
    expect(dates.stragglers).toEqual(['f:orders/C.kt'])
    expect(dates.mixed).toEqual(['f:orders/D.kt'])
    expect(dates.strays).toEqual(['f:orders/C.kt', 'f:orders/D.kt'])
    expect(dates.local).toBeCloseTo(4 / 6)
    expect(dates.effective).toBeGreaterThan(1)
    expect(dates.effective).toBeLessThan(2)
  })

  it('counts dependencies between two of its files with no way in common as transitions', () => {
    expect(dates.links).toBe(3)
    expect(dates.transitions).toEqual([['f:orders/A.kt', 'f:orders/C.kt']])
  })

  it('tells blocks mixing ways from blocks each keeping to their own', () => {
    expect(dates.blocks).toEqual([
      { block: 'orders', files: 4, paradigms: ['java-time', 'util-date'] },
      { block: 'billing', files: 2, paradigms: ['java-time'] },
    ])
    expect(dates.mixedBlocks).toBe(1)
    // gateway on WebFlux, orders on Spring MVC: several ways, none mixed in a block
    expect(web.kind).toBe('per-block')
    expect(web.coherence).toBeCloseTo(0.5)
    expect(web.local).toBe(1)
    expect(web.strays).toEqual([])
  })

  it('follows a migration from a legacy way, and whether recent files keep to their block’s way', () => {
    expect(dates.migration).toMatchObject({ from: ['util-date'], to: 'java-time', left: ['f:orders/C.kt', 'f:orders/D.kt'] })
    expect(dates.migration!.done).toBeCloseTo(4 / 6)
    // D (day 90, both ways) and E, F (java.time) are recent: D strays, so it still spreads
    expect(dates.fresh).toEqual(['f:billing/E.kt', 'f:billing/F.kt', 'f:orders/D.kt'])
    expect(dates.freshStrays).toEqual(['f:orders/D.kt'])
    expect(dates.trend).toBe('spreading')
    expect(dates.paradigms[0].added).toEqual(['f:billing/E.kt', 'f:billing/F.kt', 'f:orders/D.kt'])
    // nothing new on the web stack; with recent files all on their way, it converges
    expect(web.trend).toBe('quiet')
    const later = coherenceModel(input({ files: FILES.filter(f => f.id !== 'f:orders/D.kt') })).byId.get('jvm.dates')!
    expect(later.trend).toBe('converging')
    // no history: no trend
    expect(coherenceModel(input({ since: undefined })).byId.get('jvm.dates')!.trend).toBe('none')
  })

  it('names the youngest way when no way is marked legacy', () => {
    const files = [file('a/x.kt', ['jvm.web=servlet'], 10), file('a/y.kt', ['jvm.web=servlet'], 12), file('a/z.kt', ['jvm.web=webflux'], 40)]
    const c = coherenceModel(input({ files })).byId.get('jvm.web')!
    expect(c.migration).toBeUndefined()
    expect(c.newest).toBe('webflux')
  })

  it('ranks mixed concerns first, then per-block, accepted and single-way ones', () => {
    expect(m.concerns.map(c => `${c.concern.id}:${c.kind}`)).toEqual(['jvm.dates:mixed', 'jvm.web:per-block', 'js.persistence:mixed', 'jvm.json:one'])
    expect(m.totals).toEqual({ concerns: 4, coherent: 1, perBlock: 1, decoherent: 1, accepted: 1, strays: 2, users: 10 })
  })

  it('collects files off their block’s way and each block’s load, leaving accepted concerns out', () => {
    expect(m.strays).toEqual(
      new Map([
        ['f:orders/C.kt', ['jvm.dates']],
        ['f:orders/D.kt', ['jvm.dates']],
      ]),
    )
    expect(m.blocks.map(b => [b.block, b.load])).toEqual([
      ['orders', 1],
      ['billing', 0],
      ['gateway', 0],
      ['web', 0],
    ])
    expect(m.blocks[0].concerns).toEqual([{ id: 'jvm.dates', ways: 2 }])
  })

  it('treats all files as one block without a block function', () => {
    const one = coherenceModel(input({ blockOf: undefined }))
    expect(one.byId.get('jvm.web')!.kind).toBe('mixed')
    expect(one.blocks).toEqual([])
  })
})

describe('recent work', () => {
  it('starts at the newest fifth of the files by first commit', () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`a/${i}.ts`, [], i * 10))
    expect(recentSince(files)).toBe(70 * day)
  })

  it('keeps a bulk import old', () => {
    // nine files imported at once, one written later: only that one is recent
    const files = [...Array.from({ length: 9 }, (_, i) => file(`a/${i}.ts`, [], 5)), file('a/new.ts', [], 30)]
    const since = recentSince(files)!
    expect(files.filter(f => f.metrics!.firstCommit! > since).map(f => f.id)).toEqual(['f:a/new.ts'])
  })

  it('is unknown without history', () => {
    expect(recentSince([file('a/x.ts', [])])).toBeUndefined()
  })
})

describe('blocks by folder', () => {
  it('goes down through folders holding nearly all files to where the code splits', () => {
    const paths = ['src/app/a.ts', 'src/app/b.ts', 'src/lib/c.ts', 'src/lib/d.ts', 'src/e.ts', 'src/ui/f.ts', 'src/ui/g.ts', 'src/ui/h.ts', 'src/ui/i.ts', 'prisma/schema.prisma']
    const of = folderBlocks(paths)
    expect(paths.map(of)).toEqual(['src/app', 'src/app', 'src/lib', 'src/lib', 'src', 'src/ui', 'src/ui', 'src/ui', 'src/ui', 'prisma'])
    expect(of('tests/x.test.ts')).toBe('tests')
    expect(of('README.md')).toBe('(root)')
  })
})

describe('file links', () => {
  it('lifts dependencies to the files at both ends, without co-change, mocks or links within a file', () => {
    const g: Graph = {
      meta: { name: 'x', generatedAt: '', tool: { name: 'archrift', version: '0' }, analyzers: [], targets: ['default'], counts: {}, timings: {}, cycles: [], diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 } },
      nodes: [
        { id: 'd:.', kind: 'directory', name: 'x', path: '' },
        { id: 'f:a.ts', kind: 'file', name: 'a.ts', path: 'a.ts', parent: 'd:.' },
        { id: 'f:b.ts', kind: 'file', name: 'b.ts', path: 'b.ts', parent: 'd:.' },
        { id: 's:a.ts#f', kind: 'symbol', name: 'f', path: 'a.ts', parent: 'f:a.ts' },
        { id: 's:a.ts#g', kind: 'symbol', name: 'g', path: 'a.ts', parent: 'f:a.ts' },
        { id: 's:b.ts#h', kind: 'symbol', name: 'h', path: 'b.ts', parent: 'f:b.ts' },
      ],
      edges: [
        { source: 's:a.ts#f', target: 's:b.ts#h', kind: 'calls', count: 1, targets: ['default'], confidence: 'exact' },
        { source: 'f:a.ts', target: 'f:b.ts', kind: 'imports', count: 1, targets: ['default'], confidence: 'exact' },
        { source: 's:a.ts#f', target: 's:a.ts#g', kind: 'calls', count: 1, targets: ['default'], confidence: 'exact' },
        { source: 'f:b.ts', target: 'f:a.ts', kind: 'co-changes', count: 3, targets: ['default'], confidence: 'inferred' },
        { source: 'f:b.ts', target: 'f:a.ts', kind: 'mocks', count: 1, targets: ['default'], confidence: 'exact' },
      ],
      sites: [],
    }
    expect(fileLinks(g)).toEqual([['f:a.ts', 'f:b.ts']])
  })
})
