// HTTP between the parts of a system (docs/POLYGLOT.md, P4): the requests and
// handlers any language records on the `http` channel (http-facts.ts) are
// matched into `http-call` edges, from the code making a request to the
// handler that serves it (subkind: the method). Matching strings is a guess,
// so the edges are `inferred`.
//
// A request's path is usually known only from some segment on: its base
// (host, gateway prefix, API version) is configuration. So a handler matches
// a request when the handler's segments end the request's path, segment for
// segment, a variable (`{id}`, `:id`, `{}`) matching anything. Of the
// handlers that match, the longest wins, then the one with more literal
// segments; a handler of variables only never matches.
import type { HttpFact, HttpHandlerFact, HttpRequestFact } from './http-facts.ts'
import type { Plugin } from './types.ts'

const VARIABLE = /^(\{.*\}|:.+|\*)$/

/** A path's segments, variables as `{}`, without query, fragment, scheme or host. */
export function segments(path: string): string[] {
  const bare = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0]
  return bare
    .split('/')
    .filter(Boolean)
    .map(s => (VARIABLE.test(s) ? '{}' : s))
}

const methodMatches = (request: string, handler: string) => request === '*' || handler === '*' || request.toUpperCase() === handler.toUpperCase()

/**
 * How well a handler's path fits the end of a request's path: undefined when
 * it doesn't. A handler's variable matches any segment. A request's unknown
 * segment matches a handler's literal only in the request's unknown base
 * (before its first literal); further on it is a value, such as an id.
 */
export function fit(handler: readonly string[], request: readonly string[]): [number, number] | undefined {
  const literals = handler.filter(s => s !== '{}').length
  if (!literals || handler.length > request.length) return undefined
  const offset = request.length - handler.length
  const base = request.findIndex(s => s !== '{}')
  for (let i = 0; i < handler.length; i++) {
    const h = handler[i]
    const r = request[offset + i]
    if (h === '{}' || h === r) continue
    if (r === '{}' && offset + i < base) continue
    return undefined
  }
  return [handler.length, literals]
}

export const http: Plugin = {
  name: 'http',
  version: 1,

  assemble(api) {
    const facts = api.facts<HttpFact>('http').map(f => f.fact)
    const handlers = facts.filter((f): f is HttpHandlerFact => f.type === 'handler' && api.nodes.has(f.owner)).map(h => ({ h, segs: segments(h.path) }))
    if (!handlers.length) return
    for (const r of facts.filter((f): f is HttpRequestFact => f.type === 'request' && api.nodes.has(f.owner))) {
      const segs = segments(r.path)
      let best: [number, number] = [0, 0]
      let matches: HttpHandlerFact[] = []
      for (const { h, segs: hs } of handlers) {
        if (!methodMatches(r.method, h.method)) continue
        const f = fit(hs, segs)
        if (!f) continue
        const cmp = f[0] - best[0] || f[1] - best[1]
        if (cmp > 0) {
          best = f
          matches = [h]
        } else if (cmp === 0) matches.push(h)
      }
      for (const h of new Set(matches))
        api.addEdge({ source: r.owner, target: h.owner, kind: 'http-call', subkind: r.method === '*' ? h.method : r.method.toUpperCase(), count: 1, targets: api.targets, confidence: 'inferred' }, [r.site[0], r.site[1]])
    }
  },
}
