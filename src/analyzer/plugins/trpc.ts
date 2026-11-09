// tRPC: a router's procedures become members of the router
// (`accountsRouter.list`), each tagged with its full path (`rpc:accounts.list`,
// from how routers nest), and a client call such as
// `trpc.accounts.list.query()` becomes an `rpc-call` edge to the procedure.
// Everything here is syntax plus the type checker's own resolution, so the
// real tRPC types aren't needed.
import ts from 'typescript'
import type { Plugin } from './types.ts'
import { calleeName, nextAccess, unwrap } from './syntax.ts'

const ROUTER = /^(router|createTRPCRouter|createRouter|mergeRouters)$/
const PROCEDURE = /^(query|mutation|subscription)$/
const CLIENT_CALLS = new Set([
  'query',
  'mutate',
  'subscribe',
  'useQuery',
  'useSuspenseQuery',
  'useInfiniteQuery',
  'useSuspenseInfiniteQuery',
  'useMutation',
  'useSubscription',
  'fetch',
  'prefetch',
  'ensureData',
  'invalidate',
  'queryOptions',
  'mutationOptions',
])

/** `router({ … })`: the object literal of routes. */
export function routerLiteral(init: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  const e = init && unwrap(init)
  if (!e || !ts.isCallExpression(e) || !ROUTER.test(calleeName(e.expression) ?? '')) return undefined
  const arg = e.arguments[0] && unwrap(e.arguments[0])
  return arg && ts.isObjectLiteralExpression(arg) ? arg : undefined
}

/** `x.input(…).query(async …)`: a procedure, and its type. */
function procedureType(value: ts.Expression): string | undefined {
  const e = unwrap(value)
  if (!ts.isCallExpression(e)) return undefined
  const name = calleeName(e.expression)
  return name && PROCEDURE.test(name) ? name : undefined
}

function isProcedure(decl: ts.Node): boolean {
  return ts.isPropertyAssignment(decl) && ts.isObjectLiteralExpression(decl.parent) && !!routerLiteral(decl.parent.parent as ts.Expression) && !!procedureType(decl.initializer)
}

export const trpc: Plugin = {
  name: 'trpc',
  version: 1,

  memberContainer: routerLiteral,

  memberKind(member) {
    if (!ts.isPropertyAssignment(member) || !ts.isObjectLiteralExpression(member.parent) || !routerLiteral(member.parent.parent as ts.Expression))
      return undefined
    const type = procedureType(member.initializer)
    if (type) return { subkind: 'procedure', tags: [`trpc:${type}`] }
    return { subkind: 'router' }
  },

  refKind(id, decl) {
    if (!isProcedure(decl)) return undefined
    const call = nextAccess(id)
    return call && CLIENT_CALLS.has(call) ? { kind: 'rpc-call', subkind: call } : undefined
  },

  // full paths: a router mounted as `accounts: accountsRouter` prefixes its procedures
  assemble(api) {
    const routerMembers = new Set([...api.nodes.values()].filter(n => n.kind === 'member' && n.subkind === 'router').map(n => n.id))
    const mountedAs = new Map<string, { parent: string; name: string }>() // router symbol → where it's mounted
    for (const e of api.edges())
      if (e.kind === 'references' && routerMembers.has(e.source) && api.nodes.get(e.target)?.kind === 'symbol')
        mountedAs.set(e.target, { parent: api.nodes.get(e.source)!.parent!, name: api.nodes.get(e.source)!.name })
    const prefix = (router: string, seen = new Set<string>()): string[] => {
      const m = mountedAs.get(router)
      if (!m || seen.has(router)) return []
      seen.add(router)
      return [...prefix(m.parent, seen), m.name]
    }
    for (const n of api.nodes.values()) {
      if (n.kind !== 'member' || n.subkind !== 'procedure' || !n.parent) continue
      const path = [...prefix(n.parent), n.name].join('.')
      n.tags = [...(n.tags ?? []), `rpc:${path}`]
    }
  },
}
