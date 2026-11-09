// Angular (docs/POLYGLOT.md, P2): what an Angular app wires together outside
// its imports. NgRx has a plugin of its own (ngrx.ts).
// - Kinds: classes decorated @Component, @Directive, @Pipe, @Injectable and
//   @NgModule are components, directives, pipes, services and modules, tagged
//   with their selectors (`selector:ss-button`) and pipe names (`pipe:ssDate`).
// - Templates: a component's template file joins the graph, and the elements
//   in it become `renders` edges to the components and directives whose
//   selector they match; the pipes it uses become `references` edges.
// - Routes: route arrays registered with RouterModule.forRoot/forChild or
//   provideRouter, nested through `children`, spreads and lazy `loadChildren`,
//   tag each routed component's file with its full path, as Next.js pages are
//   tagged (`route:/projects/:projectId/tasks`; a catch-all `not-found:/`).
//   `routerLink` and `router.navigate` become `navigates` edges, inferred.
// - HTTP: HttpClient calls are requests on the shared `http` channel
//   (http-facts.ts), with their paths built from the URL expression.
import path from 'node:path'
import ts from 'typescript'
import { fileId, fileIdOf } from '../../core/ids.ts'
import { matchesSelector, parseSelector, scanTemplate, selectorKey } from './angular-template.ts'
import type { SimpleSelector, TemplateElement } from './angular-template.ts'
import { UNKNOWN, constantString, declarationOf, partialString } from './evaluate.ts'
import type { EvalEnv } from './evaluate.ts'
import type { HttpRequestFact } from './http-facts.ts'
import type { AssembleApi, ExtractApi, Plugin } from './types.ts'
import { calleeName, propertyName, unwrap } from './syntax.ts'

const KINDS: Record<string, string> = { Component: 'component', Directive: 'directive', Pipe: 'pipe', Injectable: 'service', NgModule: 'module' }
const HTTP_CALL = /^(get|post|put|patch|delete|head|options|jsonp|request)$/
/** Builder calls whose arguments are part of a URL's path (`withPath`, `withBasePath`, `url` …); query and header builders aren't. */
const PATH_CALL = /path|url|uri|segment|endpoint|resource/i
/** The last name of an expression standing for a server's base URL (`environment.apiUrl`, `this.getApiUrl()`). */
const BASE_URL = /(url|uri|host|origin|base|endpoint|server|domain|api)$/i
/** Marks a base URL only known at run time while a request's path is built: dropped at the start, `{}` elsewhere. */
const HOST = '\u0000'

type Site = [number, number]

/** A component, directive or pipe class, with what its template needs. */
interface DeclarationFact {
  type: 'declaration'
  id: string
  kind: 'component' | 'directive' | 'pipe'
  selector?: string
  pipe?: string
  /** The template file's graph path, or the inline template. */
  templateUrl?: string
  template?: string
  site: Site
}

/** A route as written; `path` is missing when it can't be read. */
export interface RouteFact {
  path?: string
  component?: string
  outlet?: string
  children?: RouteEntry[]
  /** loadChildren: an NgModule (the routes it registers with forChild) or a routes array. */
  lazy?: string
}

/** A route, or a routes array another file records (`children: OTHER_ROUTES`, `...OTHER_ROUTES`). */
export type RouteEntry = RouteFact | { ref: string }

type AngularFact =
  | DeclarationFact
  | { type: 'routes'; id: string; routes: RouteEntry[] }
  /** forRoot and provideRouter are roots; forChild routes are too, unless their module is loaded lazily. */
  | { type: 'register'; root: boolean; module: string; routes: RouteEntry[] }
  | { type: 'link'; owner: string; href: string; site: Site }

type Facts = { file: string; fact: AngularFact }[]

// ── shared ─────────────────────────────────────────────────────────────────

/** The Angular decorator of a class (`@Component({…})` → component, and its config). */
function angularDecorator(decl: ts.Node): { kind: string; config?: ts.ObjectLiteralExpression } | undefined {
  if (!ts.isClassDeclaration(decl)) return undefined
  for (const d of ts.getDecorators(decl) ?? []) {
    if (!ts.isCallExpression(d.expression)) continue
    const kind = KINDS[calleeName(d.expression.expression) ?? '']
    const arg = d.expression.arguments[0] && unwrap(d.expression.arguments[0])
    if (kind) return { kind, config: arg && ts.isObjectLiteralExpression(arg) ? arg : undefined }
  }
  return undefined
}

const property = (obj: ts.ObjectLiteralExpression | undefined, name: string) =>
  obj?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyName(p) === name)

const env = (api: ExtractApi, unknown?: EvalEnv['unknown']): EvalEnv => ({ checker: api.checker, follow: d => void api.idOf(d), unknown })

/** Name of the class a value is an instance of (`HttpClient`, `Router`). */
function typeName(e: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const t = checker.getTypeAtLocation(e)
  return (t.aliasSymbol ?? t.getSymbol())?.name
}

const pathOfId = (id: string) => fileIdOf(id)?.slice(2) ?? ''

/** Of several declarations, the one nearest a path: the same file, else the longest shared folder prefix (the same app), then the id. */
function nearest<T extends { id: string; path: string }>(candidates: T[], from: string): T | undefined {
  const shared = (p: string) => {
    const a = p.split('/')
    const b = from.split('/')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }
  return [...candidates].sort((a, b) => shared(b.path) - shared(a.path) || (a.id < b.id ? -1 : 1))[0]
}

// ── templates ──────────────────────────────────────────────────────────────

function visitDeclaration(node: ts.ClassDeclaration, api: ExtractApi) {
  const dec = angularDecorator(node)
  if (!dec || !ts.isSourceFile(node.parent) || !(dec.kind === 'component' || dec.kind === 'directive' || dec.kind === 'pipe')) return
  const id = api.idOf(node)
  if (!id) return
  const e = env(api)
  const fact: DeclarationFact = { type: 'declaration', id, kind: dec.kind, site: api.site(node.name ?? node) }
  const selector = constantString(property(dec.config, 'selector')?.initializer, e)
  if (selector) fact.selector = selector
  const name = constantString(property(dec.config, 'name')?.initializer, e)
  if (dec.kind === 'pipe' && name) fact.pipe = name
  const url = property(dec.config, 'templateUrl')
  const inline = property(dec.config, 'template')
  const urlValue = constantString(url?.initializer, e)
  if (url && urlValue) {
    fact.templateUrl = path.posix.join(path.posix.dirname(pathOfId(id)), urlValue)
    fact.site = api.site(url)
  } else if (inline) {
    const text = constantString(inline.initializer, e)
    if (text !== undefined) fact.template = text
    fact.site = api.site(inline)
  }
  api.emit(fact)
}

interface Declared {
  id: string
  path: string
  test: boolean
}

/** A selector or pipe declared more than once: test stubs only count for tests, then the declaration nearest the template wins. */
function declarationFor(candidates: Declared[], user: Declared): Declared | undefined {
  const pool = user.test ? candidates : candidates.filter(c => !c.test)
  return nearest(pool.length ? pool : candidates, user.path)
}

interface Scanned {
  owner: string
  elements: TemplateElement[]
  site: Site
}

function assembleTemplates(api: AssembleApi, facts: Facts, isTest: (file: string) => boolean): Scanned[] {
  const decls = facts.flatMap(({ file, fact }) => (fact.type === 'declaration' && api.nodes.has(fact.id) ? [{ fact, declared: { id: fact.id, path: file, test: isTest(file) } }] : []))
  const bySelector = new Map<string, { sel: SimpleSelector; decls: Declared[] }>()
  const pipes = new Map<string, Declared[]>()
  for (const { fact, declared } of decls) {
    const n = api.nodes.get(fact.id)!
    const tags = [...(fact.selector?.split(',').map(s => `selector:${s.trim()}`) ?? []), ...(fact.pipe ? [`pipe:${fact.pipe}`] : [])]
    if (tags.length) n.tags = [...(n.tags ?? []), ...tags]
    for (const sel of fact.selector ? parseSelector(fact.selector) : []) {
      const entry = bySelector.get(selectorKey(sel)) ?? { sel, decls: [] }
      entry.decls.push(declared)
      bySelector.set(selectorKey(sel), entry)
    }
    if (fact.pipe) pipes.set(fact.pipe, [...(pipes.get(fact.pipe) ?? []), declared])
  }
  // the selectors an element could match: by its name, an attribute or a class
  const index = new Map<string, { key: string; sel: SimpleSelector; decls: Declared[] }[]>()
  for (const [key, entry] of bySelector) {
    const at = entry.sel.element ? `e:${entry.sel.element}` : entry.sel.attrs.length ? `a:${entry.sel.attrs[0]}` : `c:${entry.sel.classes[0]}`
    index.set(at, [...(index.get(at) ?? []), { key, ...entry }])
  }

  const scanned: Scanned[] = []
  for (const { fact, declared } of decls) {
    if (fact.kind !== 'component') continue
    let text = fact.template
    if (fact.templateUrl && !fact.templateUrl.startsWith('..')) {
      text = api.readText(fact.templateUrl)
      if (text === undefined) continue
      const file = api.addFile(fact.templateUrl, ['asset', 'angular-template'], { loc: text.split('\n').filter(l => l.trim()).length })
      api.addEdge({ source: fact.id, target: file, kind: 'references', subkind: 'template', count: 1, targets: api.targets }, fact.site)
    }
    if (text === undefined) continue
    const template = scanTemplate(text)
    scanned.push({ owner: fact.id, elements: template.elements, site: fact.site })
    const rendered = new Map<string, { count: number; exact: boolean }>()
    for (const el of template.elements) {
      const candidates = [`e:${el.name}`, ...el.attrs.map(a => `a:${a.name}`), ...el.classes.map(c => `c:${c}`)].flatMap(k => index.get(k) ?? [])
      const matched = new Map(candidates.filter(c => matchesSelector(c.sel, el)).map(c => [c.key, c]))
      for (const entry of matched.values()) {
        const target = declarationFor(entry.decls, declared)
        if (!target || target.id === fact.id) continue
        const r = rendered.get(target.id) ?? { count: 0, exact: true }
        r.count++
        r.exact &&= entry.decls.length === 1
        rendered.set(target.id, r)
      }
    }
    for (const [target, r] of rendered)
      api.addEdge({ source: fact.id, target, kind: 'renders', count: r.count, targets: api.targets, confidence: r.exact ? 'exact' : 'inferred' }, fact.site)
    for (const name of template.pipes) {
      const candidates = pipes.get(name)
      const target = candidates && declarationFor(candidates, declared)
      if (target)
        api.addEdge({ source: fact.id, target: target.id, kind: 'references', subkind: 'pipe', count: 1, targets: api.targets, confidence: candidates.length === 1 ? 'exact' : 'inferred' }, fact.site)
    }
  }
  return scanned
}

// ── routes ─────────────────────────────────────────────────────────────────

/** A top-level array of routes, by type (`Routes`, `Route[]`) or by shape: its file records it, the others refer to it by id. */
function isRoutesArray(decl: ts.Node): decl is ts.VariableDeclaration & { initializer: ts.Expression } {
  if (!ts.isVariableDeclaration(decl) || !ts.isVariableStatement(decl.parent.parent) || !ts.isSourceFile(decl.parent.parent.parent)) return false
  const init = decl.initializer && unwrap(decl.initializer)
  if (!init || !ts.isArrayLiteralExpression(init)) return false
  if (decl.type && /^(Routes|Route\[\])$/.test(decl.type.getText())) return true
  const objects = init.elements.filter(ts.isObjectLiteralExpression)
  return objects.length > 0 && objects.length === init.elements.length && objects.every(o => !!property(o, 'path') || !!property(o, 'redirectTo'))
}

/** The declaration a lazy load resolves to: `() => import('./x.module').then(m => m.XModule)` → XModule. */
function lazyTarget(init: ts.Expression, api: ExtractApi): string | undefined {
  let e = unwrap(init)
  for (let i = 0; i < 4 && (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isCallExpression(e)); i++) {
    if (ts.isCallExpression(e)) {
      const then = calleeName(e.expression) === 'then' ? e.arguments[0] : undefined
      if (!then) return undefined
      e = unwrap(then)
    } else {
      const body = ts.isBlock(e.body) ? e.body.statements.find(ts.isReturnStatement)?.expression : e.body
      if (!body) return undefined
      e = unwrap(body)
    }
  }
  const decl = ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) ? declarationOf(e, api.checker) : undefined
  return decl && api.idOf(decl)
}

/** Routes as written: route objects, and references to the route arrays other files record; whatever else holds routes is read in place. */
export function readRoutes(expr: ts.Expression, api: ExtractApi, depth = 0): RouteEntry[] {
  const e = unwrap(expr)
  if (depth > 12) return []
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const decl = declarationOf(e, api.checker)
    const id = decl && api.idOf(decl)
    if (!decl || !id) return []
    if (isRoutesArray(decl)) return [{ ref: id }]
    const init = (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer
    return init ? readRoutes(init, api, depth + 1) : []
  }
  if (ts.isObjectLiteralExpression(e)) {
    const route = readRoute(e, api, depth)
    return route ? [route] : []
  }
  if (!ts.isArrayLiteralExpression(e)) return []
  return e.elements.flatMap(el => readRoutes(ts.isSpreadElement(el) ? el.expression : el, api, depth + 1))
}

function readRoute(obj: ts.ObjectLiteralExpression, api: ExtractApi, depth: number): RouteFact | undefined {
  if (property(obj, 'redirectTo')) return undefined
  const route: RouteFact = {}
  const e = env(api)
  const p = property(obj, 'path')
  const path = p ? constantString(p.initializer, e) : property(obj, 'matcher') ? undefined : ''
  if (path !== undefined) route.path = path
  const component = property(obj, 'component')
  const decl = component && declarationOf(component.initializer, api.checker)
  const lazyComponent = property(obj, 'loadComponent')
  const id = decl ? api.idOf(decl) : lazyComponent && lazyTarget(lazyComponent.initializer, api)
  if (id) route.component = id
  const outlet = constantString(property(obj, 'outlet')?.initializer, e)
  if (outlet && outlet !== 'primary') route.outlet = outlet
  const children = property(obj, 'children')
  if (children) route.children = readRoutes(children.initializer, api, depth + 1)
  const lazy = property(obj, 'loadChildren')
  const target = lazy && lazyTarget(lazy.initializer, api)
  if (target) route.lazy = target
  return route
}

/** Where a route sits: the primary path, and the named outlet it opened, if any. */
interface Place {
  primary: string[]
  outlet?: { name: string; segments: string[] }
}

const descend = (at: Place, path: string, outlet?: string): Place => {
  const segments = path.split('/').filter(Boolean)
  if (at.outlet) return { ...at, outlet: { ...at.outlet, segments: [...at.outlet.segments, ...segments] } }
  if (outlet) return { primary: at.primary, outlet: { name: outlet, segments } }
  return { primary: [...at.primary, ...segments] }
}

/** A route's URL in Angular's own syntax: `/projects/:projectId`, a named outlet's route as `/a/(outlet:b)`. */
const routeUrl = (at: Place) => {
  const primary = `/${at.primary.join('/')}`
  if (!at.outlet) return primary
  return `${primary === '/' ? '' : primary}/(${at.outlet.name}:${at.outlet.segments.join('/')})`
}

interface Page {
  /** The routed component's file. */
  file: string
  route: string
  /** The folder of the root registration (`RouterModule.forRoot`) whose app the page is in. */
  app?: string
}

/** Every routed component's full paths, in route order: the root registrations walked through children, spreads and lazy modules. */
function assembleRoutes(api: AssembleApi, facts: Facts, isTest: (file: string) => boolean): { pages: Page[]; appOf: (path: string) => string | undefined } {
  const arrays = new Map<string, RouteEntry[]>()
  const registrations: { file: string; fact: Extract<AngularFact, { type: 'register' }> }[] = []
  for (const { file, fact } of facts) {
    if (fact.type === 'routes') arrays.set(fact.id, fact.routes)
    if (fact.type === 'register' && !isTest(file)) registrations.push({ file, fact })
  }
  // an app is a root registration's folder, and its routes are in the app whose folder holds them
  const apps = [...new Set(registrations.filter(r => r.fact.root).map(r => path.posix.dirname(r.file)))].sort((a, b) => b.length - a.length)
  const appOf = (p: string) => apps.find(a => p.startsWith(`${a}/`))

  const lazyTargets = new Set<string>()
  const collect = (entries: RouteEntry[], seen: Set<string>) => {
    for (const e of entries) {
      if ('ref' in e) {
        if (!seen.has(e.ref)) collect(arrays.get(e.ref) ?? [], new Set(seen).add(e.ref))
        continue
      }
      if (e.lazy) lazyTargets.add(e.lazy)
      if (e.children) collect(e.children, seen)
    }
  }
  for (const r of registrations) collect(r.fact.routes, new Set())
  for (const routes of arrays.values()) collect(routes, new Set())

  const pages: Page[] = []
  const walk = (entries: RouteEntry[], at: Place, seen: Set<string>) => {
    for (const e of entries) {
      if ('ref' in e) {
        if (!seen.has(e.ref)) walk(arrays.get(e.ref) ?? [], at, new Set(seen).add(e.ref))
        continue
      }
      const here = descend(at, e.path ?? UNKNOWN, e.outlet)
      const file = e.component && fileIdOf(e.component)
      if (file && api.nodes.has(file)) pages.push({ file, route: routeUrl(here), app: appOf(file.slice(2)) })
      if (e.children) walk(e.children, here, seen)
      if (e.lazy && !seen.has(e.lazy)) {
        const inner = new Set(seen).add(e.lazy)
        for (const r of registrations) if (r.fact.module === e.lazy) walk(r.fact.routes, here, inner)
        walk(arrays.get(e.lazy) ?? [], here, inner)
      }
    }
  }
  for (const r of registrations) if (r.fact.root || !lazyTargets.has(r.fact.module)) walk(r.fact.routes, { primary: [] }, new Set([r.fact.module]))

  // a catch-all (`**`) shows what isn't found, as a Next.js not-found file does: `not-found:/projects`
  const byFile = new Map<string, Set<string>>()
  for (const p of pages) {
    const tag = p.route.endsWith('/**') ? `not-found:${p.route.slice(0, -3) || '/'}` : `route:${p.route}`
    byFile.set(p.file, (byFile.get(p.file) ?? new Set()).add(tag))
  }
  for (const [file, tags] of byFile) {
    const n = api.nodes.get(file)!
    n.tags = [...(n.tags ?? []), ...[...tags].sort()]
  }
  return { pages, appOf }
}

// ── navigation ─────────────────────────────────────────────────────────────

/** A link's path: scheme, host, query and fragment dropped; undefined for an outlet link or one whose every segment is only known at run time. */
export function linkPath(href: string): string | undefined {
  const p = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#;]/)[0]
  const segments = p.split('/').filter(Boolean)
  if (p.includes('(') || (segments.length && segments.every(s => s === UNKNOWN))) return undefined
  return `/${segments.join('/')}`
}

/**
 * How well a link matches a route (lower is better), undefined when it
 * doesn't: a `:param` takes any segment (1), and a segment only known at run
 * time is guessed to be a route's literal segment only as a last resort (100).
 */
export function linkCost(route: string, href: string): number | undefined {
  const r = route.split('/').filter(Boolean)
  const h = href.split('/').filter(Boolean)
  if (r.length !== h.length) return undefined
  let cost = 0
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith(':')) cost += 1
    else if (h[i] === UNKNOWN || r[i] === UNKNOWN) cost += 100
    else if (r[i] !== h[i]) return undefined
  }
  return cost
}

/** An absolute link in a template: `routerLink="/x"`, `[routerLink]="'/x'"`, `[routerLink]="['/x', id]"`. */
export function templateLink(el: TemplateElement): string | undefined {
  const attr = el.attrs.find(a => a.name === 'routerLink' && a.value !== undefined)
  if (!attr?.value) return undefined
  const literal = (s: string) => (/^'[^']*'$|^"[^"]*"$/.test(s.trim()) ? s.trim().slice(1, -1) : UNKNOWN)
  const v = attr.value.trim()
  const href = attr.binding === 'static' ? v.replace(/\{\{[\s\S]*?\}\}/g, UNKNOWN) : (v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(literal) : [literal(v)]).join('/').replace(/\/+/g, '/')
  return href.startsWith('/') ? href : undefined
}

/** A link in code, from the root: `router.navigate(['/x', id])` (without relativeTo) or `router.navigateByUrl('/x')`. */
function codeLink(call: ts.CallExpression, api: ExtractApi): string | undefined {
  const name = calleeName(call.expression)
  const callee = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || typeName(callee.expression, api.checker) !== 'Router') return undefined
  const e = env(api)
  const [first, extras] = call.arguments
  if (!first) return undefined
  let href: string | undefined
  if (name === 'navigateByUrl') href = partialString(first, e)
  else {
    const commands = unwrap(first)
    const options = extras && unwrap(extras)
    if (!ts.isArrayLiteralExpression(commands) || !commands.elements.length) return undefined
    if (options && ts.isObjectLiteralExpression(options) && property(options, 'relativeTo')) return undefined
    if (commands.elements.some(c => ts.isObjectLiteralExpression(unwrap(c)))) return undefined // outlets
    href = commands.elements.map(c => partialString(c, e) ?? UNKNOWN).join('/')
  }
  return href === undefined || href.startsWith('.') ? undefined : `/${href}`.replace(/\/+/g, '/')
}

/** Links lead to the best-matching page of the linking code's own app; catch-all (`**`) and outlet routes are never a link's target. */
function assembleLinks(api: AssembleApi, facts: Facts, routes: ReturnType<typeof assembleRoutes>, templates: Scanned[]) {
  const pages = routes.pages.filter(p => !p.route.includes('(') && !p.route.split('/').includes('**'))
  const link = (owner: string, raw: string, site: Site) => {
    const href = linkPath(raw)
    if (href === undefined || !api.nodes.has(owner)) return
    const app = routes.appOf(pathOfId(owner))
    let best: { page: Page; cost: number } | undefined
    for (const page of pages) {
      const cost = app === undefined || page.app === app ? linkCost(page.route, href) : undefined
      if (cost !== undefined && (!best || cost < best.cost)) best = { page, cost }
    }
    if (!best || fileIdOf(owner) === best.page.file) return
    api.addEdge({ source: owner, target: best.page.file, kind: 'navigates', subkind: href, count: 1, targets: api.targets, confidence: 'inferred' }, site)
  }
  for (const { fact } of facts) if (fact.type === 'link') link(fact.owner, fact.href, fact.site)
  for (const t of templates)
    for (const el of t.elements) {
      const href = templateLink(el)
      if (href) link(t.owner, href, t.site)
    }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/** A local variable's initializer, when it is declared in the same function as the use. */
function localInitializer(id: ts.Identifier, api: ExtractApi): ts.Expression | undefined {
  const decl = declarationOf(id, api.checker)
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined
  const fn = (n: ts.Node) => ts.findAncestor(n.parent, ts.isFunctionLike)
  return fn(decl) && fn(decl) === fn(id) ? decl.initializer : undefined
}

/** The constant arguments of the object a builder chain starts from: `new ApiUrlHelper(ApiVersionsEnum.Project)` → v5. */
function receiverParts(e: ts.Expression, api: ExtractApi, depth = 0): string[] {
  const x = unwrap(e)
  if (depth > 4) return []
  if (ts.isNewExpression(x)) {
    // a missing argument is the parameter's default: `new ApiUrlHelper()` with `_apiVersion = 'v1'`
    const ctor = api.checker.getResolvedSignature(x)?.getDeclaration()
    const params = ctor && ts.isConstructorDeclaration(ctor) ? ctor.parameters : undefined
    if (params) api.idOf(ctor!)
    const count = Math.max(x.arguments?.length ?? 0, params?.length ?? 0)
    const args = Array.from({ length: count }, (_, i) => x.arguments?.[i] ?? params?.[i]?.initializer)
    return args.map(a => constantString(a, env(api))).filter((s): s is string => s !== undefined)
  }
  if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
    const decl = declarationOf(x, api.checker)
    if (decl && (ts.isPropertyDeclaration(decl) || ts.isVariableDeclaration(decl)) && decl.initializer) {
      api.idOf(decl)
      return receiverParts(decl.initializer, api, depth + 1)
    }
  }
  return []
}

const lastName = (e: ts.Expression): string => {
  const x = unwrap(e)
  if (ts.isCallExpression(x)) return lastName(x.expression)
  if (ts.isPropertyAccessExpression(x)) return x.name.text
  return ts.isIdentifier(x) ? x.text : ''
}

/** A URL expression as parts joined by `/`: one built string, or a builder chain's receiver arguments and the arguments of its path calls. */
function urlParts(expr: ts.Expression, api: ExtractApi): string[] {
  const unknown = (x: ts.Expression) => (BASE_URL.test(lastName(x)) ? HOST : UNKNOWN)
  const e = env(api, unknown)
  const whole = partialString(expr, e)
  if (whole !== undefined) return [whole]
  const calls: ts.CallExpression[] = []
  let r = unwrap(expr)
  while (ts.isCallExpression(r) && ts.isPropertyAccessExpression(unwrap(r.expression))) {
    calls.unshift(r)
    r = unwrap((unwrap(r.expression) as ts.PropertyAccessExpression).expression)
  }
  if (!calls.length) return []
  const paths = calls.filter(c => PATH_CALL.test(calleeName(c.expression) ?? '')).flatMap(c => c.arguments.map(a => partialString(a, e) ?? unknown(a)))
  return [...receiverParts(r, api), ...paths]
}

/**
 * The path of a request from its URL's parts, for matching against the
 * handlers that serve it (POLYGLOT P4): the parts joined by `/` in source
 * order; a scheme and host dropped, and so is a base URL only known at run
 * time at the start; the query string and empty segments dropped; a segment
 * with a run-time part in it is `{}`. A URL nothing can be read of is `/{}`.
 */
export function httpPath(parts: string[]): string {
  let text = parts.filter(Boolean).join('/')
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\/\/[^/]*/, '')
  text = text.replace(new RegExp(`^(${HOST}|/)+`), '').replaceAll(HOST, UNKNOWN)
  const segments = text.split(/[?#]/)[0].split('/').filter(Boolean).map(s => (s.includes(UNKNOWN) ? UNKNOWN : s))
  return segments.length ? `/${segments.join('/')}` : parts.length ? '/' : `/${UNKNOWN}`
}

/** The path a URL expression requests; a local variable is followed to its initializer first. */
function requestPath(url: ts.Expression | undefined, api: ExtractApi): string {
  let e = url && unwrap(url)
  for (let i = 0; e && ts.isIdentifier(e) && i < 4; i++) {
    const init = localInitializer(e, api)
    if (!init) break
    e = unwrap(init)
  }
  return httpPath(e ? urlParts(e, api) : [])
}

function visitHttp(node: ts.CallExpression, api: ExtractApi) {
  const callee = unwrap(node.expression)
  if (!ts.isPropertyAccessExpression(callee) || typeName(callee.expression, api.checker) !== 'HttpClient') return
  const name = callee.name.text
  let method = name === 'jsonp' ? 'GET' : name.toUpperCase()
  let url = node.arguments[0]
  if (name === 'request') {
    // request(method, url, …) or request(new HttpRequest(method, url, …))
    const first = node.arguments[0] && unwrap(node.arguments[0])
    const args = first && ts.isNewExpression(first) ? [...(first.arguments ?? [])] : [...node.arguments]
    method = constantString(args[0], env(api))?.toUpperCase() ?? '*'
    url = args[1]
  }
  const fact: HttpRequestFact = { type: 'request', owner: api.ownerOf(node), method, path: requestPath(url, api), site: api.site(callee.name) }
  api.emit(fact, 'http')
}

// ── the plugin ─────────────────────────────────────────────────────────────

export const angular: Plugin = {
  name: 'angular',
  version: 2,

  symbolKind(decl) {
    const dec = angularDecorator(decl)
    // still a class: a component's complexity is its methods' together, no one function's
    return dec && { subkind: dec.kind, tags: ['class'] }
  },

  visit(node, api) {
    if (ts.isClassDeclaration(node)) visitDeclaration(node, api)
    else if (isRoutesArray(node)) {
      const id = api.idOf(node)
      if (id) api.emit({ type: 'routes', id, routes: readRoutes(node.initializer, api) } satisfies AngularFact)
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      const callee = unwrap(node.expression)
      const routerModule = ts.isPropertyAccessExpression(callee) && /(^|\.)RouterModule$/.test(callee.expression.getText(api.sf))
      if (node.arguments[0] && ((routerModule && (name === 'forRoot' || name === 'forChild')) || name === 'provideRouter' || name === 'provideRoutes')) {
        const root = name === 'forRoot' || name === 'provideRouter'
        api.emit({ type: 'register', root, module: api.ownerOf(node), routes: readRoutes(node.arguments[0], api) } satisfies AngularFact)
      } else if (name && HTTP_CALL.test(name)) visitHttp(node, api)
      else if (name === 'navigate' || name === 'navigateByUrl') {
        const href = codeLink(node, api)
        if (href) api.emit({ type: 'link', owner: api.ownerOf(node), href, site: api.site(node) } satisfies AngularFact)
      }
    }
  },

  assemble(api) {
    const facts = api.facts<AngularFact>('angular')
    if (!facts.length) return
    const isTest = (file: string) => api.nodes.get(fileId(file))?.tags?.includes('test') ?? false
    const templates = assembleTemplates(api, facts, isTest)
    assembleLinks(api, facts, assembleRoutes(api, facts, isTest), templates)
  },
}
