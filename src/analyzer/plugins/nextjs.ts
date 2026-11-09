// Next.js App Router: pages, layouts and route handlers are tagged
// with the URL they serve (`route:/accounts`, `layout:/`, `api:/api/health`;
// route groups like `(dashboard)` don't count), and an `href="/x"` or
// `router.push('/x')` becomes a `navigates` edge to the page that serves it.
// Matching a string to a route is a guess, so those edges are `inferred`.
import ts from 'typescript'
import { fileIdOf } from '../../core/ids.ts'
import type { Plugin } from './types.ts'
import { calleeName, stringValue } from './syntax.ts'

const NAVIGATE = /^(push|replace|prefetch|redirect|permanentRedirect)$/
const APP_FILE = /^(?:src\/)?app\/(?:(.*)\/)?(page|layout|route|template|default|loading|error|not-found)\.(tsx|ts|jsx|js)$/

interface Link {
  owner: string
  href: string
  site: [number, number]
}

/** URL path of an app-router file: `src/app/(dashboard)/accounts/page.tsx` → `/accounts`. */
export function routePath(file: string): { path: string; kind: string } | undefined {
  const m = APP_FILE.exec(file)
  if (!m) return undefined
  const segments = (m[1] ?? '').split('/').filter(s => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
  return { path: `/${segments.join('/')}`, kind: m[2] }
}

/** Does a concrete href match a route pattern with [param], [...rest] and [[...optional]] segments? */
export function matchRoute(pattern: string, href: string): boolean {
  const p = pattern.split('/').filter(Boolean)
  const h = href.split(/[?#]/)[0].split('/').filter(Boolean)
  for (let i = 0; i < p.length; i++) {
    if (/^\[\[?\.\.\./.test(p[i])) return p[i].startsWith('[[') || h.length > i
    if (i >= h.length) return false
    if (!/^\[.+\]$/.test(p[i]) && p[i] !== h[i]) return false
  }
  return p.length === h.length
}

export const nextjs: Plugin = {
  name: 'nextjs',
  version: 1,

  visit(node, api) {
    let href: string | undefined
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'href' && node.initializer) {
      const init = node.initializer
      href = ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) ? stringValue(init.expression) : undefined
    } else if (ts.isCallExpression(node) && NAVIGATE.test(calleeName(node.expression) ?? '')) {
      href = stringValue(node.arguments[0])
    }
    if (href?.startsWith('/') && !href.startsWith('//')) {
      const link: Link = { owner: api.ownerOf(node), href, site: api.site(node) }
      api.emit(link)
    }
  },

  assemble(api) {
    const pages: { pattern: string; id: string }[] = []
    for (const n of api.nodes.values()) {
      if (n.kind !== 'file' || !n.path) continue
      const r = routePath(n.path)
      if (!r) continue
      const tag = r.kind === 'page' ? 'route' : r.kind === 'route' ? 'api' : r.kind
      n.tags = [...(n.tags ?? []), `${tag}:${r.path}`]
      if (r.kind === 'page') pages.push({ pattern: r.path, id: n.id })
    }
    // most specific first: static segments before [params]
    pages.sort((a, b) => (a.pattern.match(/\[/g)?.length ?? 0) - (b.pattern.match(/\[/g)?.length ?? 0) || b.pattern.length - a.pattern.length)
    for (const { fact } of api.facts<Link>('nextjs')) {
      const page = pages.find(p => matchRoute(p.pattern, fact.href))
      // a page linking to itself isn't a navigation worth drawing
      if (!page || !api.nodes.has(fact.owner) || fileIdOf(fact.owner) === page.id) continue
      api.addEdge({ source: fact.owner, target: page.id, kind: 'navigates', subkind: fact.href, count: 1, targets: api.targets, confidence: 'inferred' }, fact.site)
    }
  },
}
