import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../src/analyzer/config.ts'
import type { Graph, GraphEdge, GraphNode } from '../../src/core/model.ts'
import { evaluateRules, summarize } from '../../src/core/rules.ts'
import type { Rule } from '../../src/core/rules.ts'

const file = (path: string, ...tags: string[]): GraphNode => ({ id: `f:${path}`, kind: 'file', name: path.split('/').pop()!, path, tags })
const imports = (source: string, target: string, subkind = 'static', targets = ['web', 'desktop']): GraphEdge => ({
  source: source.includes(':') ? source : `f:${source}`,
  target: target.includes(':') ? target : `f:${target}`,
  kind: 'imports',
  subkind,
  count: 1,
  targets,
  confidence: 'exact',
})

// app > ui > lib layers; the platform module has a web and a desktop implementation
const nodes: GraphNode[] = [
  file('src/app/page.tsx', 'entrypoint', 'use-client', 'layer:app'),
  file('src/app/admin.tsx', 'entrypoint', 'layer:app'),
  file('src/ui/button.tsx', 'layer:ui'),
  file('src/lib/util.ts', 'layer:lib'),
  file('src/lib/a.ts', 'layer:lib'),
  file('src/lib/b.ts', 'layer:lib'),
  file('src/ui/x.ts', 'layer:ui'),
  file('src/ui/y.ts', 'layer:ui'),
  file('src/platform/web.ts'),
  file('src/platform/desktop.ts'),
  file('src/server/db.ts'),
  { id: 'x:npm:@tauri-apps/api', kind: 'external', name: '@tauri-apps/api' },
  { id: 'x:npm:react', kind: 'external', name: 'react' },
  { id: 'x:excluded:src/generated/client.ts', kind: 'external', name: 'src/generated/client.ts', tags: ['excluded'] },
]
const edges: GraphEdge[] = [
  imports('src/app/page.tsx', 'src/ui/button.tsx', 'static', ['web']),
  imports('src/app/page.tsx', 'src/ui/button.tsx', 'dynamic', ['desktop']),
  imports('src/app/page.tsx', 'src/platform/web.ts', 'static', ['web']),
  imports('src/app/page.tsx', 'src/platform/desktop.ts', 'static', ['desktop']),
  imports('src/platform/desktop.ts', 'x:npm:@tauri-apps/api', 'static', ['desktop']),
  imports('src/platform/web.ts', 'src/server/db.ts', 'type-only', ['web']),
  imports('src/app/admin.tsx', 'src/ui/button.tsx'),
  imports('src/app/admin.tsx', 'src/server/db.ts'),
  imports('src/ui/button.tsx', 'src/lib/util.ts'),
  imports('src/ui/button.tsx', 'x:npm:react'),
  imports('src/lib/util.ts', 'src/ui/button.tsx', 'type-only'),
  imports('src/lib/util.ts', 'x:excluded:src/generated/client.ts'),
  imports('src/lib/a.ts', 'src/lib/b.ts'),
  imports('src/lib/b.ts', 'src/lib/a.ts'),
  imports('src/ui/x.ts', 'src/ui/y.ts'),
  imports('src/ui/y.ts', 'src/ui/x.ts'),
  // not a dependency between files: ignored
  { ...imports('src/app/admin.tsx', 'src/lib/util.ts'), kind: 'calls' },
]
const graph: Graph = {
  meta: {
    name: 'rules',
    generatedAt: '',
    tool: { name: 'archrift', version: '0' },
    analyzers: [],
    targets: ['web', 'desktop'],
    layers: ['app', 'ui', 'lib'],
    counts: {},
    timings: {},
    cycles: [
      ['f:src/lib/a.ts', 'f:src/lib/b.ts'],
      ['f:src/ui/x.ts', 'f:src/ui/y.ts'],
    ],
    diagnostics: { unresolvedImports: [], unresolvedIdentifiers: 0, danglingEdges: 0 },
  },
  nodes,
  edges,
  sites: [],
}
const check = (rule: Rule) => evaluateRules(graph, [rule])
const pairs = (rule: Rule) => check(rule).map(v => `${v.from} -> ${v.to} [${v.targets.join(',')}]`)

describe('forbid', () => {
  it('flags each dependent/dependency pair once, with every target it exists in', () => {
    expect(pairs({ name: 'r', forbid: { from: 'src/app/page.tsx', to: 'src/ui/**' } })).toEqual(['f:src/app/page.tsx -> f:src/ui/button.tsx [web,desktop]'])
  })

  it('matches packages by id and skips the exceptions', () => {
    const rule = { name: 'seam', forbid: { from: 'src/**', to: 'x:npm:@tauri-apps/*' } }
    expect(pairs(rule)).toEqual(['f:src/platform/desktop.ts -> x:npm:@tauri-apps/api [desktop]'])
    expect(pairs({ ...rule, forbid: { ...rule.forbid, except: 'src/platform/**' } })).toEqual([])
  })

  it('matches files the config excludes by their path', () => {
    expect(pairs({ name: 'r', forbid: { from: 'src/**', to: 'src/generated/**' } })).toEqual(['f:src/lib/util.ts -> x:excluded:src/generated/client.ts [web,desktop]'])
  })

  it('counts type-only imports unless runtimeOnly', () => {
    const rule: Rule = { name: 'r', forbid: { from: 'src/platform/**', to: 'src/server/**' } }
    expect(pairs(rule)).toEqual(['f:src/platform/web.ts -> f:src/server/db.ts [web]'])
    expect(pairs({ ...rule, runtimeOnly: true })).toEqual([])
  })

  it('selects by tag and by layer, and keeps to one target when asked', () => {
    expect(pairs({ name: 'r', forbid: { from: 'tag:use-client', to: 'layer:ui' } })).toEqual(['f:src/app/page.tsx -> f:src/ui/button.tsx [web,desktop]'])
    expect(pairs({ name: 'r', target: 'web', forbid: { from: 'tag:entrypoint', to: 'src/platform/*' } })).toEqual(['f:src/app/page.tsx -> f:src/platform/web.ts [web]'])
  })

  it('reports errors by default and warnings when asked', () => {
    const rule: Rule = { name: 'r', forbid: { from: 'src/app/admin.tsx', to: 'src/server/**' } }
    expect(check(rule)[0]).toMatchObject({ rule: 'r', severity: 'error', message: 'src/app/admin.tsx must not depend on src/server/db.ts' })
    expect(check({ ...rule, severity: 'warn' })[0].severity).toBe('warn')
  })
})

describe('allow', () => {
  it('flags dependencies outside what is allowed', () => {
    expect(pairs({ name: 'r', allow: { from: 'src/app/**', to: ['src/ui/**', 'src/platform/**'] } })).toEqual(['f:src/app/admin.tsx -> f:src/server/db.ts [web,desktop]'])
  })
})

describe('layers', () => {
  it('flags imports that point up the configured layers, type-only ones unless runtimeOnly', () => {
    expect(check({ name: 'r', layers: 'down' }).map(v => v.message)).toEqual(['lib → ui points up: src/lib/util.ts depends on src/ui/button.tsx'])
    expect(check({ name: 'r', layers: 'down', runtimeOnly: true })).toEqual([])
  })
})

describe('cycles', () => {
  it('reports the import cycles in scope, as a path back to the start', () => {
    const [v, ...rest] = check({ name: 'r', cycles: 'forbid', scope: 'src/lib/**' })
    expect(rest).toEqual([])
    expect(v.path).toEqual(['f:src/lib/a.ts', 'f:src/lib/b.ts', 'f:src/lib/a.ts'])
    expect(check({ name: 'r', cycles: 'forbid' })).toHaveLength(2)
  })
})

describe('forbidReach', () => {
  it('follows runtime imports per target', () => {
    const rule: Rule = { name: 'r', forbidReach: { from: 'tag:entrypoint', to: 'x:npm:@tauri-apps/*' } }
    const [v, ...rest] = check(rule)
    expect(rest).toEqual([])
    expect(v).toMatchObject({
      to: 'x:npm:@tauri-apps/api',
      targets: ['desktop'],
      path: ['f:src/app/page.tsx', 'f:src/platform/desktop.ts', 'x:npm:@tauri-apps/api'],
      sources: ['f:src/app/page.tsx'],
    })
    expect(check({ ...rule, target: 'web' })).toEqual([])
  })

  it('lists every source that reaches the file, with the shortest way from one of them', () => {
    const vs = check({ name: 'r', forbidReach: { from: 'tag:entrypoint', to: 'src/lib/util.ts' } })
    expect(vs.map(v => v.targets[0])).toEqual(['web', 'desktop'])
    for (const v of vs) {
      expect(v.sources).toEqual(['f:src/app/admin.tsx', 'f:src/app/page.tsx'])
      expect(v.path).toHaveLength(3)
      expect(v.message).toMatch(/reachable in (web|desktop) from 2 places/)
    }
  })

  it('ignores type-only imports and exceptions', () => {
    const vs = check({ name: 'r', forbidReach: { from: 'src/app/page.tsx', to: 'src/server/**' } })
    expect(vs).toEqual([]) // page → platform/web.ts → db is type-only
    expect(check({ name: 'r', forbidReach: { from: 'tag:entrypoint', to: 'src/server/**', except: 'src/server/db.ts' } })).toEqual([])
  })

  it("doesn't count a source that is itself what's forbidden", () => {
    expect(check({ name: 'r', forbidReach: { from: 'tag:entrypoint', to: 'src/app/**' } })).toEqual([])
  })
})

// lib files with their measures: a big one, a small one, a generated one; functions, a class and an interface in them
const symbol = (file: string, name: string, subkind: string, metrics: Record<string, number>): GraphNode => ({
  id: `s:${file}#${name}`,
  kind: subkind === 'method' ? 'member' : 'symbol',
  subkind,
  name: name.split('.').pop()!,
  parent: `f:${file}`,
  path: file,
  metrics,
})
const measured: Graph = {
  ...graph,
  nodes: [
    { ...file('src/lib/big.ts', 'layer:lib'), metrics: { loc: 400, complexity: 60, testReach: 0 } },
    { ...file('src/lib/small.ts', 'layer:lib'), metrics: { loc: 40, complexity: 5, testReach: 3 } },
    { ...file('src/lib/generated.ts', 'layer:lib'), metrics: { loc: 900, complexity: 1, testReach: 0 } },
    symbol('src/lib/big.ts', 'parse', 'function', { loc: 120, complexity: 31 }),
    symbol('src/lib/big.ts', 'Parser', 'class', { loc: 200, complexity: 40 }),
    symbol('src/lib/big.ts', 'Parser.run', 'method', { loc: 30, complexity: 12 }),
    // an Angular component: a class, its complexity its methods' together
    { ...symbol('src/lib/big.ts', 'ParserComponent', 'component', { loc: 150, complexity: 25 }), tags: ['class'] },
    symbol('src/lib/small.ts', 'Options', 'interface', { loc: 10, complexity: 1 }),
  ],
  edges: [],
}
const limits = (rule: Rule) => evaluateRules(measured, [rule])

describe('requireReach', () => {
  const sym = (id: string, subkind = 'function', parent?: string): GraphNode => {
    const path = id.slice(2, id.indexOf('#'))
    return { id, kind: parent ? 'member' : 'symbol', name: id.slice(id.lastIndexOf('#') + 1).split('.').pop()!, subkind, path, parent: parent ?? `f:${path}` }
  }
  const run = (source: string, target: string, kind = 'calls', targets = ['web', 'desktop']): GraphEdge => ({ source, target, kind: kind as GraphEdge['kind'], count: 1, targets, confidence: 'exact' })
  // four API routes: one checks the session itself, one through a wrapper, one through an interface, one never
  const reach: Graph = {
    ...graph,
    nodes: [
      file('src/app/api/a/route.ts', 'api:/api/a'),
      file('src/app/api/b/route.ts', 'api:/api/b'),
      file('src/app/api/c/route.ts', 'api:/api/c'),
      file('src/app/api/open/route.ts', 'api:/api/open'),
      file('src/lib/auth.ts'),
      file('src/lib/wrap.ts'),
      file('src/lib/service.ts'),
      sym('s:src/app/api/a/route.ts#GET'),
      sym('s:src/app/api/a/route.ts#POST'),
      sym('s:src/app/api/b/route.ts#POST', 'variable'),
      sym('s:src/app/api/c/route.ts#GET'),
      sym('s:src/app/api/open/route.ts#GET'),
      sym('s:src/lib/auth.ts#requireAuth'),
      sym('s:src/lib/wrap.ts#withAuth'),
      sym('s:src/lib/service.ts#Service', 'interface'),
      sym('s:src/lib/service.ts#Service.run', 'method', 's:src/lib/service.ts#Service'),
      sym('s:src/lib/service.ts#Impl', 'class'),
      sym('s:src/lib/service.ts#Impl.constructor', 'constructor', 's:src/lib/service.ts#Impl'),
      sym('s:src/lib/service.ts#Impl.run', 'method', 's:src/lib/service.ts#Impl'),
    ],
    edges: [
      run('s:src/app/api/a/route.ts#POST', 's:src/lib/auth.ts#requireAuth'),
      run('s:src/app/api/b/route.ts#POST', 's:src/lib/wrap.ts#withAuth'),
      run('s:src/lib/wrap.ts#withAuth', 's:src/lib/auth.ts#requireAuth'),
      run('s:src/app/api/c/route.ts#GET', 's:src/lib/service.ts#Service.run'),
      { ...run('s:src/lib/service.ts#Impl.run', 's:src/lib/service.ts#Service.run'), kind: 'implements' },
      run('s:src/lib/service.ts#Impl.run', 's:src/lib/auth.ts#requireAuth', 'calls', ['web']),
      // an import alone runs nothing
      imports('src/app/api/open/route.ts', 'src/lib/auth.ts'),
    ],
  }
  const failing = (rule: Rule) => evaluateRules(reach, [rule]).map(v => `${v.expects?.symbol ?? v.from} [${v.targets.join(',')}]`)

  it('flags each file that never runs the target, through calls, wrappers and interfaces, per build target', () => {
    const vs = evaluateRules(reach, [{ name: 'auth', requireReach: { from: 'tag:api:*', to: 's:src/lib/auth.ts#requireAuth' } }])
    expect(vs.map(v => `${v.from} [${v.targets.join(',')}]`)).toEqual(['f:src/app/api/c/route.ts [desktop]', 'f:src/app/api/open/route.ts [web,desktop]'])
    expect(vs[1]).toMatchObject({
      rule: 'auth',
      severity: 'error',
      to: 'f:src/app/api/open/route.ts',
      message: 'src/app/api/open/route.ts never reaches requireAuth (src/lib/auth.ts)',
      expects: { to: 'requireAuth (src/lib/auth.ts)' },
    })
    expect(vs[1].expects!.symbol).toBeUndefined()
  })

  it('holds each function to it when the selector names symbols, and spares the excepted files', () => {
    expect(failing({ name: 'auth', target: 'web', requireReach: { from: 's:src/app/api/**#{GET,POST}', to: 's:src/lib/auth.ts#requireAuth', except: 'src/app/api/open/**' } })).toEqual([
      's:src/app/api/a/route.ts#GET [web]',
    ])
    const [v] = evaluateRules(reach, [{ name: 'auth', target: 'web', requireReach: { from: 's:src/app/api/a/**#GET', to: 's:src/lib/auth.ts#requireAuth' } }])
    expect(v).toMatchObject({ from: 'f:src/app/api/a/route.ts', message: 'src/app/api/a/route.ts › GET never reaches requireAuth (src/lib/auth.ts)' })
  })

  it('counts any code of a target file, and a class through its constructor', () => {
    expect(failing({ name: 'r', target: 'web', requireReach: { from: 'tag:api:*', to: 'src/lib/{auth,service}.ts' } })).toEqual(['f:src/app/api/open/route.ts [web]'])
    const withNew: Graph = { ...reach, edges: [...reach.edges, run('s:src/app/api/open/route.ts#GET', 's:src/lib/service.ts#Impl', 'instantiates'), run('s:src/lib/service.ts#Impl.constructor', 's:src/lib/auth.ts#requireAuth')] }
    expect(evaluateRules(withNew, [{ name: 'r', target: 'web', requireReach: { from: 'tag:api:/api/open', to: 's:src/lib/auth.ts#requireAuth' } }])).toEqual([])
  })

  it('names a symbol or tag pattern that matches nothing', () => {
    expect(summarize({ name: 'r', requireReach: { from: 'tag:api:*', to: 's:src/lib/auth.ts#requireAuthh' } }, reach).unmatched).toEqual(['to s:src/lib/auth.ts#requireAuthh matches no symbol'])
    expect(summarize({ name: 'r', requireReach: { from: 'tag:route:*', to: 's:src/lib/auth.ts#requireAuth' } }, reach).unmatched).toEqual(['from tag:route:* matches no file'])
    expect(summarize({ name: 'r', requireReach: { from: 'tag:api:*', to: 's:src/lib/auth.ts#requireAuth' } }, reach)).toMatchObject({ kind: 'requireReach' })
  })
})

describe('limit', () => {
  it('flags each file over a maximum or under a minimum, the furthest out first', () => {
    const vs = limits({ name: 'r', limit: { files: 'src/lib/**', except: 'src/lib/generated.ts', max: { complexity: 50, loc: 300 }, min: { testReach: 1 } } })
    expect(vs.map(v => v.message)).toEqual(['src/lib/big.ts: testReach 0, less than 1', 'src/lib/big.ts: loc 400, more than 300', 'src/lib/big.ts: complexity 60, more than 50'])
    expect(vs[1]).toMatchObject({ rule: 'r', severity: 'error', from: 'f:src/lib/big.ts', to: 'f:src/lib/big.ts', targets: ['web', 'desktop'], measure: { metric: 'loc', value: 400, bound: 'max', limit: 300 } })
    expect(vs[1].measure!.symbol).toBeUndefined()
  })

  it('limits functions, methods, components and hooks, not classes or types, each pinned to its file', () => {
    const vs = limits({ name: 'r', severity: 'warn', limit: { functions: 'src/lib/**', max: { complexity: 10 } } })
    expect(vs.map(v => v.message)).toEqual(['src/lib/big.ts › parse: complexity 31, more than 10', 'src/lib/big.ts › run: complexity 12, more than 10'])
    expect(vs[0]).toMatchObject({ severity: 'warn', from: 'f:src/lib/big.ts', to: 'f:src/lib/big.ts', measure: { metric: 'complexity', value: 31, symbol: 's:src/lib/big.ts#parse' } })
  })

  it('passes at the bound itself', () => {
    expect(limits({ name: 'r', limit: { files: 'src/lib/small.ts', max: { loc: 40 }, min: { testReach: 3 } } })).toEqual([])
  })
})

describe('apart', () => {
  // two services and a library; a service's chart sits beside its code
  const apartGraph: Graph = {
    ...graph,
    meta: { ...graph.meta, cycles: [] },
    nodes: [
      file('services/orders/src/Order.kt'),
      file('services/orders/src/OrderService.kt'),
      file('services/billing/src/Invoice.kt'),
      file('services/billing/src/InvoiceDto.kt'),
      file('libraries/common/src/Id.kt'),
      file('scripts/seed.kt'),
    ],
    edges: [
      imports('services/orders/src/OrderService.kt', 'services/orders/src/Order.kt'),
      imports('services/orders/src/OrderService.kt', 'libraries/common/src/Id.kt'),
      imports('services/billing/src/Invoice.kt', 'libraries/common/src/Id.kt'),
      imports('services/billing/src/Invoice.kt', 'services/orders/src/Order.kt'),
      imports('services/orders/src/Order.kt', 'services/billing/src/InvoiceDto.kt', 'type-only'),
      imports('scripts/seed.kt', 'services/orders/src/Order.kt'),
    ],
  }
  const apartPairs = (rule: Rule) => evaluateRules(apartGraph, [rule]).map(v => `${v.from} -> ${v.to}`).sort()

  it('flags a dependency from one matched folder into another, not within one or from outside them', () => {
    expect(apartPairs({ name: 'r', apart: 'services/*' })).toEqual([
      'f:services/billing/src/Invoice.kt -> f:services/orders/src/Order.kt',
      'f:services/orders/src/Order.kt -> f:services/billing/src/InvoiceDto.kt',
    ])
    expect(evaluateRules(apartGraph, [{ name: 'r', apart: 'services/*' }])[0].message).toBe(
      'services/billing/src/Invoice.kt must not depend on services/orders/src/Order.kt: services/billing and services/orders are kept apart',
    )
  })

  it('counts type-only imports unless runtimeOnly, and keeps the outermost folder when patterns nest', () => {
    expect(apartPairs({ name: 'r', apart: 'services/*', runtimeOnly: true })).toEqual(['f:services/billing/src/Invoice.kt -> f:services/orders/src/Order.kt'])
    // services/orders/src is inside services/orders: one part, not two
    expect(apartPairs({ name: 'r', apart: ['services/*', 'services/*/src'] })).toHaveLength(2)
    expect(apartPairs({ name: 'r', apart: ['services/*', 'libraries/*'] })).toEqual([
      'f:services/billing/src/Invoice.kt -> f:libraries/common/src/Id.kt',
      'f:services/billing/src/Invoice.kt -> f:services/orders/src/Order.kt',
      'f:services/orders/src/Order.kt -> f:services/billing/src/InvoiceDto.kt',
      'f:services/orders/src/OrderService.kt -> f:libraries/common/src/Id.kt',
    ])
  })

  it('names a pattern that matches no folder, and a rule with fewer than two folders to keep apart', () => {
    expect(summarize({ name: 'r', apart: ['services/*', 'servics/*'] }, apartGraph).unmatched).toEqual(['apart servics/* matches no folder'])
    expect(summarize({ name: 'r', apart: 'libraries/*' }, apartGraph).unmatched).toEqual(['apart libraries/* matches one folder: nothing to keep it apart from'])
    expect(summarize({ name: 'r', apart: 'services/*' }, apartGraph)).toMatchObject({ kind: 'apart' })
  })
})

describe('rules that match nothing', () => {
  const unmatched = (rule: Rule, g = graph) => summarize(rule, g).unmatched

  it('name each pattern no file matches: a folder renamed or misspelled, a tag nothing has', () => {
    expect(unmatched({ name: 'r', forbid: { from: 'src/lbi/**', to: ['src/server/**', 'src/servr/**'] } })).toEqual(['from src/lbi/** matches no file', 'to src/servr/** matches no file'])
    expect(unmatched({ name: 'r', forbidReach: { from: 'tag:entry', to: 'src/server/**' } })).toEqual(['from tag:entry matches no file'])
    expect(unmatched({ name: 'r', allow: { from: 'layer:domain', to: 'src/lib/**' } })).toEqual(['from layer:domain matches no file'])
    expect(unmatched({ name: 'r', cycles: 'forbid', scope: 'lib/**' })).toEqual(['scope lib/** matches no file'])
  })

  it("let a package nobody uses go, and don't look at exceptions", () => {
    expect(unmatched({ name: 'r', forbid: { from: 'src/**', to: 'x:npm:lodash', except: 'src/gone/**' } })).toBeUndefined()
    expect(unmatched({ name: 'r', forbid: { from: 'src/**', to: 'src/generated/**' } })).toBeUndefined() // excluded files count
  })

  it('name a build target or layer the project lacks', () => {
    expect(unmatched({ name: 'r', target: 'mobile', cycles: 'forbid' })).toEqual(['target mobile is not a build target (web, desktop)'])
    expect(unmatched({ name: 'r', layers: 'down' })).toBeUndefined()
    expect(unmatched({ name: 'r', layers: 'down' }, { ...graph, meta: { ...graph.meta, layers: ['app', 'ui', 'domain', 'lib'] } })).toEqual(['layer domain holds no file'])
    expect(unmatched({ name: 'r', layers: 'down' }, { ...graph, meta: { ...graph.meta, layers: undefined } })).toEqual(['no layers are configured'])
  })

  it('name a limit with nothing to measure', () => {
    expect(unmatched({ name: 'r', limit: { files: 'src/lib/**', max: { fanIn: 3, loc: 500 } } }, measured)).toEqual(['no file it limits has fanIn'])
    expect(unmatched({ name: 'r', limit: { files: 'src/lib/big.ts', except: 'src/lib/*.ts', max: { loc: 500 } } }, measured)).toEqual(['it limits no file: except takes them all'])
    expect(unmatched({ name: 'r', limit: { functions: 'src/lib/small.ts', max: { loc: 50 } } }, measured)).toEqual(['it limits no function: its files hold none, or except takes them'])
    expect(unmatched({ name: 'r', limit: { functions: 'src/core/**', max: { loc: 50 } } }, measured)).toEqual(['functions src/core/** matches no file'])
  })
})

describe('rule config', () => {
  it('summarizes a rule for the viewer', () => {
    expect(summarize({ name: 'r', target: 'web', forbidReach: { from: 'a', to: 'b' } })).toEqual({ name: 'r', kind: 'forbidReach', severity: 'error', description: undefined, target: 'web' })
    expect(summarize({ name: 'r', limit: { files: 'src/**', max: { loc: 1 } } }, measured)).toEqual({ name: 'r', kind: 'limit', severity: 'error', description: undefined, target: undefined })
  })

  it('accepts each kind of rule and rejects mixed or misspelled ones', () => {
    const ok = ConfigSchema.safeParse({
      rules: [
        { name: 'a', forbid: { from: 'src/**', to: ['x:npm:pg'], except: 'src/server/**' }, runtimeOnly: true },
        { name: 'b', allow: { from: 'src/lib/**', to: 'src/lib/**' } },
        { name: 'c', target: 'desktop', severity: 'warn', forbidReach: { from: 'tag:entrypoint', to: 'src/trpc/client.ts' } },
        { name: 'd', cycles: 'forbid', scope: 'src/lib/**' },
        { name: 'e', layers: 'down' },
        { name: 'f', severity: 'warn', limit: { files: 'src/lib/**', except: 'tag:test', max: { complexity: 80, loc: 600 }, min: { testReach: 1 } } },
        { name: 'g', limit: { functions: ['src/**'], max: { complexity: 25 } } },
        { name: 'h', requireReach: { from: 'tag:api:*', to: 's:src/lib/auth.ts#requireSession', except: ['src/app/api/health/**'] } },
        { name: 'i', apart: ['services/*', 'frontend/*'], runtimeOnly: true },
      ],
    })
    expect(ok.success).toBe(true)
    // a measure that isn't one (or is git history), a limit on nothing, on both, without bounds, or for one build target
    for (const limit of [
      { files: 'src/**', max: { complexty: 10 } },
      { files: 'src/**', max: { churn: 10 } },
      { functions: 'src/**', max: { testReach: 1 } },
      { files: 'src/**', functions: 'src/**', max: { loc: 1 } },
      { files: 'src/**' },
      { files: 'src/**', max: {} },
    ])
      expect(ConfigSchema.safeParse({ rules: [{ name: 'x', limit }] }).success, JSON.stringify(limit)).toBe(false)
    expect(ConfigSchema.safeParse({ rules: [{ name: 'x', target: 'web', limit: { files: 'src/**', max: { loc: 1 } } }] }).success).toBe(false)
    expect(ConfigSchema.safeParse({ rules: [{ name: 'x', layers: 'down', cycles: 'forbid' }] }).success).toBe(false)
    expect(ConfigSchema.safeParse({ rules: [{ name: 'x', forbid: { from: 'a', too: 'b' } }] }).success).toBe(false)
    expect(ConfigSchema.safeParse({ rules: [{ name: 'x', severity: 'fatal', layers: 'down' }] }).success).toBe(false)
  })
})
