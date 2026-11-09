import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyzer/analyze.ts'
import { ConfigSchema } from '../../src/analyzer/config.ts'
import { coherenceOf } from '../../src/cli/coherence.ts'
import { firstLook, shapeOf, starterRules } from '../../src/core/first-look.ts'
import { matcher } from '../../src/core/glob.ts'
import type { Graph, GraphEdge, GraphNode } from '../../src/core/model.ts'
import { FIXTURES } from '../helpers/fixtures.ts'

/** The fixture as init's first analysis sees it: generated code and static files left out. */
const viteApp = () =>
  analyze({
    root: path.join(FIXTURES, 'vite-app'),
    config: ConfigSchema.parse({ exclude: ['src/generated/**', 'public/**'], entrypoints: ['src/main.tsx', 'scripts/seed.ts', '*.config.{ts,mts,cts,js,mjs,cjs}'] }),
    cacheDir: false,
    history: false,
  })

const file = (p: string): GraphNode => ({ id: `f:${p}`, kind: 'file', name: path.basename(p), path: p })
const imports = (a: string, b: string): GraphEdge => ({ source: `f:${a}`, target: `f:${b}`, kind: 'imports', subkind: 'static', count: 1, targets: ['default'], confidence: 'exact' })
const graphOf = (nodes: GraphNode[], edges: GraphEdge[]) => ({ meta: { layers: [], cycles: [] }, nodes, edges }) as unknown as Graph

describe('a new project’s shape', () => {
  it('finds the blocks its code splits into, which are UI, and the layers they keep', async () => {
    const shape = shapeOf(await viteApp())
    expect(shape.blocks.map(b => [b.path, b.match, b.files, b.ui])).toEqual([
      ['scripts', 'scripts/**', 1, false],
      ['src', 'src/*.*', 2, true],
      ['src/components', 'src/components/**', 2, true],
      ['src/hooks', 'src/hooks/**', 1, false],
      ['src/lib', 'src/lib/**', 2, false],
      ['src/pages', 'src/pages/**', 1, true],
    ])
    // main.tsx → App → pages → components and hooks → lib; the seed script uses lib too
    expect(shape.layers).toEqual([
      { name: 'src (top files)', blocks: ['src'], match: ['src/*.*'] },
      { name: 'pages', blocks: ['src/pages'], match: ['src/pages/**'] },
      { name: 'scripts + components + hooks', blocks: ['scripts', 'src/components', 'src/hooks'], match: ['scripts/**', 'src/components/**', 'src/hooks/**'] },
      { name: 'lib', blocks: ['src/lib'], match: ['src/lib/**'] },
    ])
  })

  it('in a monorepo, makes each folder beside the way down a block of its own, not one lump', () => {
    const app: GraphNode = { id: 's:apps/web/App.tsx#App', kind: 'symbol', subkind: 'component', name: 'App', parent: 'f:apps/web/App.tsx', path: 'apps/web/App.tsx' }
    const paths = ['apps/api/src/a/1.ts', 'apps/api/src/a/2.ts', 'apps/api/src/b/3.ts', 'apps/api/src/b/4.ts', 'apps/web/App.tsx']
    const shape = shapeOf(graphOf([...paths.map(file), app], [imports('apps/api/src/a/1.ts', 'apps/api/src/b/3.ts')]))
    expect(shape.blocks.map(b => [b.path, b.match, b.ui])).toEqual([
      ['apps/api/src/a', 'apps/api/src/a/**', false],
      ['apps/api/src/b', 'apps/api/src/b/**', false],
      ['apps/web', 'apps/web/**', true],
    ])
  })

  it('finds no layering when the blocks import each other in a circle', () => {
    const g = graphOf([file('src/a/x.ts'), file('src/b/y.ts')], [imports('src/a/x.ts', 'src/b/y.ts'), imports('src/b/y.ts', 'src/a/x.ts')])
    expect(shapeOf(g).layers).toEqual([])
    expect(starterRules(shapeOf(g), []).map(r => r.name)).toEqual(['no-cycles', 'functions-small-logic'])
  })
})

describe('the starter rules', () => {
  it('limit functions to 10 outside the UI blocks and 20 in them, copied-in kits and tests held to neither', async () => {
    const rules = starterRules(shapeOf(await viteApp()), ['src/components/ui/**', 'vendor/**'])
    expect(rules.map(r => r.name)).toEqual(['no-cycles', 'layers-point-down', 'functions-small-logic', 'functions-small-ui'])
    expect(rules[2]).toMatchObject({ limit: { functions: '**', except: ['src/*.*', 'src/components/**', 'src/pages/**', 'vendor/**', 'tag:test'], max: { complexity: 9 } } })
    expect(rules[3]).toMatchObject({ limit: { functions: ['src/*.*', 'src/components/**', 'src/pages/**'], except: ['src/components/ui/**', 'vendor/**', 'tag:test'], max: { complexity: 19 } } })
  })
})

describe('the first look', () => {
  it('reports sizes, layers, functions by band, the largest outside copied-in code, and dead exports by folder', async () => {
    const graph = await viteApp()
    const isVendored = matcher(['src/components/ui/**'])
    const look = firstLook({
      graph,
      coherence: coherenceOf(graph),
      root: '/x/vite-app',
      stack: ['TypeScript'],
      notes: [],
      config: { path: '.archrift/config.json', status: 'dry-run' },
      excluded: [],
      vendored: [{ glob: 'src/components/ui/**', what: 'shadcn/ui components, copied in' }],
      ui: ['src/components/**'],
      isUi: matcher(['src/components/**']),
      isVendored,
      now: new Date('2026-11-01T12:00:00Z'),
    })
    expect(look.size).toMatchObject({ files: 9, tests: 1, functions: 8, languages: [{ name: 'TypeScript', files: 9 }] })
    expect(look.generatedAt).toBe('2026-11-01T12:00:00.000Z')
    expect(look.functions.bands.map(b => b.count)).toEqual([7, 0, 1, 0, 0])
    expect(look.functions.largest[0]).toEqual({ name: 'formatAmount', path: 'src/lib/format.ts', line: 2, complexity: 12, ui: false })
    expect(look.functions.largest.map(f => f.name)).not.toContain('Button')
    expect(look.deadExports).toEqual({ count: 1, folders: [{ folder: 'src/components/ui', count: 1, vendored: true }] })
    expect(look.cycles).toEqual({ count: 0, largest: [] })
    // no layers configured yet: every block is listed without one
    expect(look.layers).toEqual([])
    expect(look.blocks.map(b => b.path)).toEqual(['scripts', 'src', 'src/components', 'src/hooks', 'src/lib', 'src/pages'])
    // main.tsx → App → Home → ItemList and useItems → lib: the files between the blocks
    expect(look.bridges.map(b => [b.path, b.block, b.above.map(a => a.block), b.below.map(a => a.block)])).toEqual([
      ['src/pages/Home.tsx', 'src/pages', ['src'], ['src/components', 'src/hooks']],
      ['src/components/ItemList.tsx', 'src/components', ['src/pages'], ['src/components', 'src/lib']],
      ['src/hooks/useItems.ts', 'src/hooks', ['src/pages'], ['src/lib']],
    ])
    // the page's main.tsx, the seed script, the config and the test are no unused files
    expect(look.questions.map(q => q.type)).toEqual(['bridge', 'bridge', 'bridge'])
  })

  it('never asks whether a Next.js page, layout or route handler is used, nor a test: only the code nothing loads', async () => {
    // no entrypoints configured: the routes are known by the files' tags alone
    const graph = await analyze({ root: path.join(FIXTURES, 'fullstack'), config: ConfigSchema.parse({}), cacheDir: false, history: false })
    const look = firstLook({
      graph,
      coherence: coherenceOf(graph),
      root: '/x/fullstack',
      stack: [],
      notes: [],
      config: { path: '.archrift/config.json', status: 'dry-run' },
      excluded: [],
      vendored: [],
      ui: [],
      isUi: () => false,
      isVendored: () => false,
    })
    expect(look.questions.filter(q => q.type === 'unused file')).toEqual([
      {
        type: 'unused file',
        question: 'Is `src/local/service.ts` still used? Only tests depend on it.',
        why: '7 lines; no production file imports or calls it (only 1 test file), and no framework, page or script loads it',
        files: ['src/local/service.ts'],
      },
    ])
  })
})
