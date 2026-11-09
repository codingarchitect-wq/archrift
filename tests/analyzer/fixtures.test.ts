import { describe, expect, it } from 'vitest'
import { dumpGraph } from '../../src/core/dump.ts'
import { analyzeFixture, edge, node } from '../helpers/fixtures.ts'

describe('plain-ts fixture', async () => {
  const g = await analyzeFixture('plain-ts')

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/plain-ts.txt')
  })

  it('links class members to the interface members they implement and the base members they override', () => {
    expect(edge(g, 's:src/shapes.ts#Base', 'implements', 's:src/types.ts#Shape')).toBeDefined()
    expect(edge(g, 's:src/shapes.ts#Base.area', 'implements', 's:src/types.ts#Shape.area')).toBeDefined()
    expect(edge(g, 's:src/shapes.ts#Base.name', 'implements', 's:src/types.ts#Shape.name')).toBeDefined()
    expect(edge(g, 's:src/shapes.ts#Circle', 'extends', 's:src/shapes.ts#Base')).toBeDefined()
    expect(edge(g, 's:src/shapes.ts#Circle.area', 'overrides', 's:src/shapes.ts#Base.area')).toBeDefined()
  })

  it('resolves references through barrels, aliases and dynamic imports to the original declaration', () => {
    expect(edge(g, 's:src/app.ts#main', 'calls', 's:src/util.ts#round')).toBeDefined() // `roundTo` via index.ts
    expect(edge(g, 's:src/app.ts#main', 'calls', 's:src/shapes.ts#makeCircle')).toBeDefined()
    expect(edge(g, 's:src/app.ts#main', 'calls', 's:src/lazy.ts#load')).toBeDefined()
    expect(edge(g, 'f:src/app.ts', 'imports', 'f:src/lazy.ts')?.subkind).toBe('dynamic')
    expect(edge(g, 'f:src/app.ts', 'imports', 'f:src/setup.ts')?.subkind).toBe('side-effect')
  })

  it('keeps re-exports and type-only imports apart', () => {
    const reexports = g.edges.filter(e => e.source === 'f:src/index.ts').map(e => `${e.kind}/${e.subkind} ${e.target}`)
    expect(reexports.sort()).toEqual([
      're-exports/static f:src/shapes.ts',
      're-exports/static f:src/util.ts',
      're-exports/type-only f:src/types.ts',
    ])
    const toTypes = g.edges.filter(e => e.source === 'f:src/shapes.ts' && e.target === 'f:src/types.ts').map(e => e.subkind)
    expect(toTypes.sort()).toEqual(['static', 'type-only'])
  })

  it('merges a value and a type of the same name, and overload signatures, into one node', () => {
    expect(node(g, 's:src/types.ts#Color').tags).toContain('also-type')
    const parse = node(g, 's:src/util.ts#parse')
    expect(parse.range?.[0]).toBe(6)
    expect(parse.range?.[2]).toBe(10)
    expect(parse.metrics?.complexity).toBe(2)
  })

  it('computes complexity from branches and short-circuits', () => {
    expect(node(g, 's:src/shapes.ts#makeCircle').metrics?.complexity).toBe(3) // if + ||
    expect(node(g, 's:src/util.ts#clamp').metrics?.complexity).toBe(3) // two ternaries
  })

  it('finds the import cycle', () => {
    expect(g.meta.cycles).toEqual([['f:src/cycle-a.ts', 'f:src/cycle-b.ts']])
    expect(node(g, 'f:src/cycle-a.ts').tags).toContain('in-cycle')
  })

  it('tells dead exports from exports only tests use', () => {
    const tagged = (t: string) => g.nodes.filter(n => n.tags?.includes(t)).map(n => n.id)
    expect(tagged('dead-export')).toEqual(
      expect.arrayContaining(['s:src/util.ts#unused', 's:src/types.ts#Unit', 's:src/setup.ts#ready']),
    )
    expect(tagged('dead-export')).not.toContain('s:src/util.ts#round')
    expect(tagged('test-only')).toEqual(['s:src/util.ts#onlyTested'])
    expect(node(g, 'f:tests/shapes.test.ts').tags).toContain('test')
  })

  it('counts fan-in without tests', () => {
    expect(node(g, 's:src/util.ts#onlyTested').metrics?.fanIn).toBe(0)
    expect(node(g, 'f:src/util.ts').metrics?.fanIn).toBe(3) // app, index, shapes — not the test
  })
})

describe('react-tsx fixture', async () => {
  const g = await analyzeFixture('react-tsx')

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/react-tsx.txt')
  })

  it('recognizes components, hooks and render edges', () => {
    expect(node(g, 's:src/Button.tsx#Button').subkind).toBe('component')
    expect(node(g, 's:src/Panel.tsx#Panel').subkind).toBe('component') // arrow function
    expect(node(g, 's:src/useCounter.ts#useCounter').subkind).toBe('hook')
    expect(edge(g, 's:src/Panel.tsx#Panel', 'renders', 's:src/Button.tsx#Button')).toBeDefined()
    expect(edge(g, 's:src/Panel.tsx#Page', 'renders', 's:src/Panel.tsx#Panel')).toBeDefined()
    expect(edge(g, 's:src/Panel.tsx#Panel', 'calls', 's:src/useCounter.ts#useCounter')).toBeDefined()
  })

  it('tags client components and default exports', () => {
    expect(node(g, 'f:src/Button.tsx').tags).toContain('use-client')
    expect(node(g, 's:src/Panel.tsx#Page').tags).toContain('default-export')
  })
})

describe('js-only fixture (no tsconfig)', async () => {
  const g = await analyzeFixture('js-only')

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/js-only.txt')
  })

  it('follows ESM imports and CommonJS require aliases', () => {
    expect(edge(g, 'f:main.mjs', 'calls', 's:lib/math.js#add')).toBeDefined()
    expect(edge(g, 'f:lib/legacy.cjs', 'calls', 's:lib/math.js#add')).toBeDefined()
    expect(edge(g, 'f:lib/legacy.cjs', 'imports', 'f:lib/math.js')?.subkind).toBe('require')
  })

  it('turns packages and builtins into external nodes, installed or not', () => {
    expect(node(g, 'x:node:fs').tags).toEqual(['node'])
    expect(node(g, 'x:npm:chalk').tags).toEqual(['npm'])
    expect(g.meta.diagnostics.unresolvedImports).toEqual([])
  })
})

describe('suffix-targets fixture', async () => {
  const g = await analyzeFixture('suffix-targets')

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/suffix-targets.txt')
  })

  it('resolves a specifier per build target', () => {
    expect(g.meta.targets).toEqual(['web', 'desktop'])
    expect(edge(g, 'f:src/platform/index.ts', 're-exports', 'f:src/platform/impl.ts')?.targets).toEqual(['web'])
    expect(edge(g, 'f:src/platform/index.ts', 're-exports', 'f:src/platform/impl.desktop.ts')?.targets).toEqual(['desktop'])
  })

  it('redirects symbol references into the file a target replaces', () => {
    expect(edge(g, 's:src/main.ts#start', 'calls', 's:src/platform/impl.ts#platform')?.targets).toEqual(['web'])
    expect(edge(g, 's:src/main.ts#start', 'calls', 's:src/platform/impl.desktop.ts#platform')?.targets).toEqual(['desktop'])
    expect(node(g, 's:src/platform/impl.desktop.ts#platform').tags ?? []).not.toContain('dead-export')
  })

  it('links assets, workers, mocks and excluded files', () => {
    expect(node(g, 'f:src/styles.css')).toMatchObject({ tags: ['asset'], metrics: { loc: 3 } })
    expect(node(g, 'f:src/data.json').tags).toEqual(['asset'])
    expect(edge(g, 'f:src/main.ts', 'spawns-worker', 'f:src/compute.worker.ts')).toBeDefined()
    expect(edge(g, 'f:tests/main.test.ts', 'mocks', 'f:src/platform/index.ts')).toBeDefined()
    expect(node(g, 'x:excluded:src/generated/client.ts').kind).toBe('external')
    expect(g.nodes.some(n => n.path?.startsWith('src/generated/'))).toBe(false)
  })

  it('never calls an entrypoint export dead', () => {
    expect(node(g, 'f:src/compute.worker.ts').tags).toContain('entrypoint')
    expect(node(g, 's:src/compute.worker.ts#compute').tags ?? []).not.toContain('dead-export')
  })
})

describe('fullstack fixture (plugins)', async () => {
  const g = await analyzeFixture('fullstack')
  const tagged = (id: string) => node(g, id).tags ?? []

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/fullstack.txt')
  })

  it('tRPC: procedures are router members with their full path, client calls are rpc-calls', () => {
    const list = node(g, 's:src/server/routers/accounts.ts#accountsRouter.list')
    expect(list).toMatchObject({ kind: 'member', subkind: 'procedure' })
    expect(list.tags).toEqual(expect.arrayContaining(['rpc:accounts.list', 'trpc:query']))
    expect(node(g, 's:src/server/routers/index.ts#appRouter.accounts').subkind).toBe('router')
    expect(edge(g, 's:src/client/service.ts#CloudService.getAccounts', 'rpc-call', 's:src/server/routers/accounts.ts#accountsRouter.list')?.subkind).toBe('query')
    expect(edge(g, 's:src/client/service.ts#CloudService.createAccount', 'rpc-call', 's:src/server/routers/accounts.ts#accountsRouter.create')?.subkind).toBe('mutate')
  })

  it('Prisma: models, fields and relations from the schema; queries from procedures, read or write', () => {
    expect(node(g, 's:prisma/schema.prisma#Account')).toMatchObject({ kind: 'symbol', subkind: 'model', parent: 'f:prisma/schema.prisma' })
    expect(node(g, 's:prisma/schema.prisma#User.accounts')).toMatchObject({ subkind: 'relation', signature: 'accounts Account[]' })
    expect(edge(g, 's:prisma/schema.prisma#Account.user', 'type-ref', 's:prisma/schema.prisma#User')).toBeDefined()
    expect(edge(g, 's:src/server/routers/accounts.ts#accountsRouter.list', 'queries', 's:prisma/schema.prisma#Account')).toMatchObject({
      subkind: 'read',
      confidence: 'inferred',
    })
    expect(edge(g, 's:src/server/routers/accounts.ts#accountsRouter.create', 'queries', 's:prisma/schema.prisma#Account')?.subkind).toBe('write')
    expect(tagged('s:prisma/schema.prisma#User')).not.toContain('dead-export')
  })

  it('Dexie: tables and the code that reads or writes them', () => {
    expect(node(g, 's:src/local/db.ts#AppDB.accounts').subkind).toBe('table')
    expect(edge(g, 's:src/local/service.ts#localAccounts', 'queries', 's:src/local/db.ts#AppDB.accounts')?.subkind).toBe('read')
    expect(edge(g, 's:src/local/service.ts#saveAccount', 'queries', 's:src/local/db.ts#AppDB.accounts')?.subkind).toBe('write')
  })

  it('React context: who provides it and who reads it', () => {
    expect(node(g, 's:src/ui/ThemeContext.tsx#ThemeContext').subkind).toBe('context')
    expect(edge(g, 's:src/ui/ThemeContext.tsx#ThemeProvider', 'provides', 's:src/ui/ThemeContext.tsx#ThemeContext')).toBeDefined()
    expect(edge(g, 's:src/ui/ThemeContext.tsx#useTheme', 'consumes', 's:src/ui/ThemeContext.tsx#ThemeContext')).toBeDefined()
  })

  it('Next.js: routes on pages and handlers, links to the page that serves them', () => {
    expect(tagged('f:src/app/(shop)/accounts/page.tsx')).toContain('route:/accounts')
    expect(tagged('f:src/app/page.tsx')).toContain('route:/')
    expect(tagged('f:src/app/api/health/route.ts')).toContain('api:/api/health')
    expect(edge(g, 's:src/app/page.tsx#Home', 'navigates', 'f:src/app/(shop)/accounts/page.tsx')?.confidence).toBe('inferred')
    expect(edge(g, 's:src/app/(shop)/accounts/page.tsx#Accounts', 'navigates', 'f:src/app/(shop)/accounts/[id]/page.tsx')?.subkind).toBe('/accounts/42')
    expect(g.edges.filter(e => e.kind === 'navigates')).toHaveLength(2) // "/nowhere" serves nothing
  })

  it('test reach: how many tests reach a file, directly or not', () => {
    expect(node(g, 'f:src/client/service.ts').metrics).toMatchObject({ testReach: 1, testedDirectly: 1 })
    expect(node(g, 'f:src/lib/fake-libs.ts').metrics).toMatchObject({ testReach: 1, testedDirectly: 0 })
    expect(node(g, 'f:src/server/routers/accounts.ts').metrics?.testReach).toBe(0) // type-only import from the client
  })
})
