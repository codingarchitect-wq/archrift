import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { dumpGraph } from '../../src/core/dump.ts'
import type { Graph } from '../../src/core/model.ts'
import { attributeName, matchesSelector, parseSelector, pipesIn, scanTemplate } from '../../src/analyzer/plugins/angular-template.ts'
import { httpPath, linkCost, linkPath, templateLink } from '../../src/analyzer/plugins/angular.ts'
import { constantString, partialString } from '../../src/analyzer/plugins/evaluate.ts'
import type { HttpRequestFact } from '../../src/analyzer/plugins/http-facts.ts'
import { analyzeFixture, copyFixture, edge, node } from '../helpers/fixtures.ts'

const APP = 'src/app'
const s = (id: string) => `s:${APP}/${id}`
const f = (file: string) => `f:${APP}/${file}`
const tags = (g: Graph, id: string) => node(g, id).tags ?? []
const targets = (g: Graph, source: string, kind: string, subkind?: string) =>
  g.edges.filter(e => e.source === source && e.kind === kind && (subkind === undefined || e.subkind === subkind)).map(e => e.target).sort()

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-angular-cache-'))
afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

describe('angular fixture', async () => {
  const g = await analyzeFixture('angular', { cacheDir })
  // the facts the HTTP matcher reads (POLYGLOT P4) stay in the fragments
  const fragments = JSON.parse(fs.readFileSync(path.join(cacheDir, 'fragments.json'), 'utf8')).files as Record<string, { facts?: { http?: HttpRequestFact[] } }>
  const requests = Object.values(fragments)
    .flatMap(fr => fr.facts?.http ?? [])
    .map(r => `${r.owner.replace(`s:${APP}/`, '')} ${r.method} ${r.path}`)
    .sort()

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/angular.txt')
  })

  it('names Angular classes by their decorator, with selectors and pipe names as tags', () => {
    expect(node(g, s('app.component.ts#AppComponent')).subkind).toBe('component')
    // a component here is a class: its complexity is its methods' together, not one function's
    expect(node(g, s('app.component.ts#AppComponent')).tags).toContain('class')
    expect(node(g, s('shared/highlight.directive.ts#HighlightDirective')).subkind).toBe('directive')
    expect(node(g, s('shared/shout.pipe.ts#ShoutPipe')).subkind).toBe('pipe')
    expect(node(g, s('projects/project.service.ts#ProjectService')).subkind).toBe('service')
    expect(node(g, s('app.module.ts#AppModule')).subkind).toBe('module')
    expect(tags(g, s('shared/button.component.ts#ButtonComponent'))).toEqual(expect.arrayContaining(['selector:button[app-button]', 'selector:a[app-button]']))
    expect(tags(g, s('shared/highlight.directive.ts#HighlightDirective'))).toContain('selector:[appHighlight]')
    expect(tags(g, s('shared/shout.pipe.ts#ShoutPipe'))).toContain('pipe:shout')
  })

  it('adds template files, linked from their component', () => {
    expect(tags(g, f('app.component.html')).sort()).toEqual(['angular-template', 'asset'])
    expect(edge(g, s('app.component.ts#AppComponent'), 'references', f('app.component.html'))?.subkind).toBe('template')
    expect(g.nodes.filter(n => n.tags?.includes('angular-template'))).toHaveLength(3) // inline templates have no file
  })

  it('links a template to the components and directives its elements match by selector', () => {
    // an element, an element with an attribute (one of a comma list), a static and a bound attribute
    expect(targets(g, s('app.component.ts#AppComponent'), 'renders')).toEqual([s('shared/button.component.ts#ButtonComponent'), s('shared/header.component.ts#HeaderComponent')])
    expect(targets(g, s('admin/admin-users.component.ts#AdminUsersComponent'), 'renders')).toEqual([s('shared/button.component.ts#ButtonComponent')])
    expect(targets(g, s('shared/header.component.ts#HeaderComponent'), 'renders')).toEqual([s('shared/highlight.directive.ts#HighlightDirective')])
    expect(targets(g, s('projects/projects.component.ts#ProjectsComponent'), 'renders')).toEqual([s('shared/highlight.directive.ts#HighlightDirective')])
    // the site is the template property in the .ts file
    const i = g.edges.findIndex(e => e.source === s('app.component.ts#AppComponent') && e.kind === 'renders')
    expect(g.sites[i]).toEqual([3, 36])
  })

  it('picks the nearest of two declarations of a selector, and test stubs only for tests', () => {
    const card = edge(g, s('projects/project-list.component.ts#ProjectListComponent'), 'renders', s('projects/project-card.component.ts#ProjectCardComponent'))
    expect(card?.confidence).toBe('inferred')
    expect(targets(g, s('projects/project-list.component.spec.ts#TestHostComponent'), 'renders')).toEqual([
      s('projects/project-list.component.spec.ts#ProjectCardStubComponent'),
      s('projects/project-list.component.ts#ProjectListComponent'),
    ])
  })

  it('links the pipes a template uses, inline or in its file', () => {
    expect(edge(g, s('shared/header.component.ts#HeaderComponent'), 'references', s('shared/shout.pipe.ts#ShoutPipe'))?.subkind).toBe('pipe')
    expect(edge(g, s('projects/project-list.component.ts#ProjectListComponent'), 'references', s('shared/shout.pipe.ts#ShoutPipe'))?.subkind).toBe('pipe')
    expect(g.edges.filter(e => e.subkind === 'pipe')).toHaveLength(2) // `||` is no pipe
  })

  it('tags routed components with their full paths: nested, from constants, spread in, lazy, in an outlet', () => {
    const routes = (file: string) => tags(g, f(file)).filter(t => /^(route|not-found):/.test(t))
    expect(routes('projects/projects.component.ts')).toEqual(['route:/projects'])
    expect(routes('projects/project-list.component.ts')).toEqual(['route:/projects/list'])
    expect(routes('projects/project-detail.component.ts')).toEqual(['route:/projects/:projectId'])
    expect(routes('projects/task-list.component.ts')).toEqual(['route:/projects/:projectId/tasks'])
    expect(routes('admin/admin.component.ts')).toEqual(['route:/admin'])
    expect(routes('admin/admin-users.component.ts')).toEqual(['route:/admin/users'])
    expect(routes('shared/help.component.ts')).toEqual(['route:/(side:help)'])
    expect(routes('shared/not-found.component.ts')).toEqual(['not-found:/'])
    expect(routes('app.component.ts')).toEqual([])
  })

  it('links routerLink and router.navigate to the page that serves them', () => {
    const nav = (source: string) => g.edges.filter(e => e.source === s(source) && e.kind === 'navigates').map(e => `${e.subkind} → ${e.target}`)
    expect(nav('app.component.ts#AppComponent')).toEqual([`/projects/list → ${f('projects/project-list.component.ts')}`])
    expect(nav('shared/header.component.ts#HeaderComponent').sort()).toEqual([
      `/admin/users → ${f('admin/admin-users.component.ts')}`,
      `/projects/list → ${f('projects/project-list.component.ts')}`,
    ])
    // a run-time id takes the :projectId route, not /projects/list
    expect(nav('projects/project-card.component.ts#ProjectCardComponent')).toEqual([`/projects/{} → ${f('projects/project-detail.component.ts')}`])
    expect(nav('projects/project-detail.component.ts#ProjectDetailComponent.openTasks')).toEqual([`/projects/{}/tasks → ${f('projects/task-list.component.ts')}`])
    expect(nav('projects/project-detail.component.ts#ProjectDetailComponent.back')).toEqual([`/projects/list → ${f('projects/project-list.component.ts')}`])
    expect(g.edges.filter(e => e.kind === 'navigates').every(e => e.confidence === 'inferred')).toBe(true)
  })

  it('records HttpClient calls as requests with paths built from the URL', () => {
    expect(requests).toEqual([
      'admin/user.service.ts#UserService.findAll GET /v1/users', // the helper's default version
      'projects/project.service.ts#ProjectService.create POST /v5/projects',
      'projects/project.service.ts#ProjectService.download GET /{}', // nothing to read: still counted
      'projects/project.service.ts#ProjectService.findAll GET /v5/projects', // the query isn't the path
      'projects/project.service.ts#ProjectService.findOne GET /v5/projects/{}',
      'projects/project.service.ts#ProjectService.health GET /health', // the base URL is dropped
      'projects/project.service.ts#ProjectService.remove DELETE /v5/projects/{}',
    ])
  })
})

describe('NgRx in the angular fixture', async () => {
  const g = await analyzeFixture('angular')
  const actions = 'store/project.actions.ts'

  it('makes action types topics: constants, enum members (as members of the enum) and creators', () => {
    expect(g.nodes.filter(n => n.tags?.includes('ngrx-action')).map(n => n.id).sort()).toEqual([
      s(`${actions}#ProjectActionEnum.Clear`),
      s(`${actions}#ProjectActionEnum.Select`),
      s(`${actions}#REQUEST_PROJECTS`),
      s(`${actions}#REQUEST_PROJECTS_FULFILLED`),
      s('store/ui.actions.ts#toggleSidebar'),
    ])
    const member = node(g, s(`${actions}#ProjectActionEnum.Select`))
    expect(member).toMatchObject({ kind: 'member', subkind: 'enum-member', parent: s(`${actions}#ProjectActionEnum`), range: [8, 3, 8, 31] })
    expect(g.nodes.find(n => n.id === s(`${actions}#ProjectActionEnum.Unused`))).toBeUndefined()
  })

  it('publishes what is dispatched, or created by an effect', () => {
    const list = s('projects/project-list.component.ts#ProjectListComponent')
    expect(edge(g, `${list}.load`, 'publishes', s(`${actions}#REQUEST_PROJECTS`))?.subkind).toBe('dispatch')
    expect(edge(g, `${list}.select`, 'publishes', s(`${actions}#ProjectActionEnum.Select`))?.subkind).toBe('dispatch') // through a variable
    expect(edge(g, `${list}.toggle`, 'publishes', s('store/ui.actions.ts#toggleSidebar'))?.subkind).toBe('dispatch')
    expect(edge(g, `${list}.clear`, 'publishes', s(`${actions}#ProjectActionEnum.Clear`))?.subkind).toBe('dispatch') // no `implements Action`
    const effects = s('store/project.effects.ts#ProjectEffects')
    expect(edge(g, `${effects}.requestAll$`, 'publishes', s(`${actions}#REQUEST_PROJECTS_FULFILLED`))?.subkind).toBe('effect')
    expect(edge(g, `${effects}.select$`, 'publishes', s('store/ui.actions.ts#toggleSidebar'))?.subkind).toBe('effect')
    expect(node(g, `${effects}.requestAll$`).subkind).toBe('effect')
  })

  it('subscribes effects through ofType, and reducers through case labels and on()', () => {
    const effects = s('store/project.effects.ts#ProjectEffects')
    expect(edge(g, `${effects}.requestAll$`, 'subscribes', s(`${actions}#REQUEST_PROJECTS`))?.subkind).toBe('ofType')
    expect(edge(g, `${effects}.select$`, 'subscribes', s(`${actions}#ProjectActionEnum.Select`))?.subkind).toBe('ofType')
    expect(targets(g, s('store/project.reducer.ts#projectReducer'), 'subscribes', 'reducer')).toEqual([
      s(`${actions}#ProjectActionEnum.Clear`),
      s(`${actions}#ProjectActionEnum.Select`),
      s(`${actions}#REQUEST_PROJECTS`),
      s(`${actions}#REQUEST_PROJECTS_FULFILLED`),
    ])
    expect(edge(g, s('store/ui.reducer.ts#uiReducer'), 'subscribes', s('store/ui.actions.ts#toggleSidebar'))?.subkind).toBe('reducer')
    expect(targets(g, s('store/project.reducer.ts#label'), 'subscribes')).toEqual([]) // a switch on another `type`
  })
})

describe('angular routes and the cache', () => {
  it('re-reads a route path when a constant it is built from changes, two files away', async () => {
    const root = copyFixture('angular')
    try {
      const dir = path.join(root, '.archrift', 'cache')
      const run = () => analyzeFixture('angular', { root, cacheDir: dir })
      expect(tags(await run(), f('projects/task-list.component.ts'))).toContain('route:/projects/:projectId/tasks')
      fs.writeFileSync(path.join(root, APP, 'projects/route-params.ts'), "export const ROUTE_PARAM_PROJECT_ID = 'id'\n")
      expect(tags(await run(), f('projects/task-list.component.ts'))).toContain('route:/projects/:id/tasks')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('template scanner', () => {
  it('strips binding syntax from attribute names, and drops references and variables', () => {
    expect(attributeName('[title]')).toEqual({ name: 'title', binding: 'property' })
    expect(attributeName('(click)')).toEqual({ name: 'click', binding: 'event' })
    expect(attributeName('[(ngModel)]')).toEqual({ name: 'ngModel', binding: 'two-way' })
    expect(attributeName('*ngIf')).toEqual({ name: 'ngIf', binding: 'structural' })
    expect(attributeName('bind-title')).toEqual({ name: 'title', binding: 'property' })
    expect(attributeName('#ref')).toBeUndefined()
    expect(attributeName('let-item')).toBeUndefined()
  })

  it('finds pipes, not `||` and not inside strings', () => {
    expect(pipesIn("a | date:'short' | translate")).toEqual(['date', 'translate'])
    expect(pipesIn("a || b")).toEqual([])
    expect(pipesIn("'x | y' | upper")).toEqual(['upper'])
  })

  it('reads elements with their attributes and classes, and pipes from interpolations and bound values', () => {
    const t = scanTemplate(`<!-- <hidden-el> -->
      <ss-card class="big  wide" *ngIf="items | async as list" [title]="name | upper" (click)="go()" #card title="{{ x | lower }}" disabled/>
      <p>{{ y | shout }} a < b</p>`)
    expect(t.elements.map(e => e.name)).toEqual(['ss-card', 'p'])
    expect(t.elements[0].attrs.map(a => `${a.binding}:${a.name}`)).toEqual(['static:class', 'structural:ngIf', 'property:title', 'event:click', 'static:title', 'static:disabled'])
    expect(t.elements[0].classes).toEqual(['big', 'wide'])
    expect(t.pipes.sort()).toEqual(['async', 'lower', 'shout', 'upper'])
  })

  it('parses selectors and matches elements as Angular does', () => {
    expect(parseSelector('ss-x, button[ss-button]:not(.plain), [ssY], .z')).toEqual([
      { element: 'ss-x', attrs: [], classes: [] },
      { element: 'button', attrs: ['ss-button'], classes: [] },
      { attrs: ['ssY'], classes: [] },
      { attrs: [], classes: ['z'] },
    ])
    const [el] = scanTemplate('<button ss-button [ssY]="1" class="z">').elements
    for (const sel of parseSelector('button[ss-button], [ssY], .z')) expect(matchesSelector(sel, el)).toBe(true)
    expect(matchesSelector(parseSelector('a[ss-button]')[0], el)).toBe(false)
  })
})

describe('paths and links', () => {
  it('builds request paths: joined parts, no scheme, host, base URL or query; run-time parts as {}', () => {
    expect(httpPath(['v5', 'projects/{}'])).toBe('/v5/projects/{}')
    expect(httpPath(['https://api.example.com/v1', 'users?page=2'])).toBe('/v1/users')
    expect(httpPath(['\u0000/health'])).toBe('/health')
    expect(httpPath(['v5', 'files/report-{}.pdf'])).toBe('/v5/files/{}')
    expect(httpPath([])).toBe('/{}')
  })

  it('matches links to routes: parameters before guesses, outlets and unknowns left out', () => {
    expect(linkPath('http://localhost:4200/projects/1?tab=2')).toBe('/projects/1')
    expect(linkPath('/a(side:help)')).toBeUndefined()
    expect(linkPath('/{}/{}')).toBeUndefined()
    expect(linkCost('/projects/:id', '/projects/{}')).toBe(1)
    expect(linkCost('/projects/list', '/projects/{}')).toBe(100)
    expect(linkCost('/projects/list', '/projects/list')).toBe(0)
    expect(linkCost('/projects/list', '/projects/list/x')).toBeUndefined()
  })

  it('reads absolute routerLinks from a template', () => {
    const link = (html: string) => templateLink(scanTemplate(html).elements[0])
    expect(link('<a routerLink="/x/y">')).toBe('/x/y')
    expect(link(`<a [routerLink]="'/x'">`)).toBe('/x')
    expect(link(`<a [routerLink]="['/x', item.id, 'edit']">`)).toBe('/x/{}/edit')
    expect(link('<a routerLink="/x/{{ id }}">')).toBe('/x/{}')
    expect(link('<a routerLink="relative">')).toBeUndefined()
  })
})

describe('string evaluation through the checker', () => {
  const files: Record<string, string> = {
    '/p/paths.ts': "import { ID } from './ids'\nexport const PATHS: any = { list: 'list', item: `:${ID}` }\n",
    '/p/ids.ts': "export const ID = 'id'\nexport enum Version { Current = 'v5' }\n",
    '/p/use.ts': [
      "import { PATHS } from './paths'",
      "import { Version } from './ids'",
      'const join = (a: string) => `/${PATHS.list}/${a}`',
      'export function f(id: string, flag: boolean) {',
      '  const a = `${Version.Current}/${PATHS.item}`',
      "  const b = 'x/' + id",
      '  const c = join(id)',
      "  const d = flag ? `t/${id}/up` : `t/${id}/down`",
      '  return [a, b, c, d]',
      '}',
    ].join('\n'),
  }
  const host = ts.createCompilerHost({})
  host.readFile = name => files[name]
  host.fileExists = name => name in files
  host.directoryExists = dir => dir === '/' || dir === '/p'
  host.getSourceFile = (name, v) => (files[name] !== undefined ? ts.createSourceFile(name, files[name], v, true) : undefined)
  const options = { noLib: true, types: [], module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
  const program = ts.createProgram({ rootNames: Object.keys(files), options, host })
  const env = { checker: program.getTypeChecker() }
  const init = (name: string) => {
    let found: ts.Expression | undefined
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n.initializer
      ts.forEachChild(n, visit)
    }
    visit(program.getSourceFile('/p/use.ts')!)
    return found!
  }

  it('follows constants, enum members and `any`-typed literals into other files', () => {
    expect(constantString(init('a'), env)).toBe('v5/:id')
  })

  it('marks run-time parts, and builds through functions that return one expression', () => {
    expect(constantString(init('b'), env)).toBeUndefined()
    expect(partialString(init('b'), env)).toBe('x/{}')
    expect(partialString(init('c'), env)).toBe('/list/{}')
  })

  it('keeps the segments a conditional’s two paths share', () => {
    expect(partialString(init('d'), env)).toBe('t/{}/{}')
  })
})
