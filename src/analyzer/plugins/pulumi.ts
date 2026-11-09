// Pulumi (TypeScript): `new azure_native.resources.ResourceGroup("rg", …)`
// creates a cloud resource. The function (or file) constructing one is tagged
// with the resource's type token, `pulumi:azure-native:resources:ResourceGroup`.
// The type is read from the syntax and the file's imports, so it needs no
// provider types loaded (a Pulumi folder is analyzed as a light project).
import ts from 'typescript'
import type { Plugin } from './types.ts'

interface Construction {
  owner: string
  type: string
  site: [number, number]
}

/** A local name bound to a Pulumi provider package (or one of its modules): the package and the module path. */
type Binding = { pkg: string; path: string[] }

const bindings = new WeakMap<ts.SourceFile, Map<string, Binding>>()

function bindingsOf(sf: ts.SourceFile): Map<string, Binding> {
  let map = bindings.get(sf)
  if (map) return map
  map = new Map()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const m = /^@pulumi\/([\w-]+)(?:\/(.+))?$/.exec(stmt.moduleSpecifier.text)
    // the core SDK (Config, StackReference, Output) creates no cloud resources
    if (!m || m[1] === 'pulumi') continue
    const path = m[2] ? m[2].split('/') : []
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) map.set(clause.name.text, { pkg: m[1], path })
    const named = clause.namedBindings
    if (named && ts.isNamespaceImport(named)) map.set(named.name.text, { pkg: m[1], path })
    else if (named) for (const el of named.elements) map.set(el.name.text, { pkg: m[1], path: [...path, (el.propertyName ?? el.name).text] })
  }
  bindings.set(sf, map)
  return map
}

/** `a.b.C` → ['a', 'b', 'C']; undefined for anything but a chain of names. */
function chainOf(e: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(e)) return [e.text]
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    const head = chainOf(e.expression)
    return head && [...head, e.name.text]
  }
  return undefined
}

export const pulumi: Plugin = {
  name: 'pulumi',
  version: 1,

  visit(node, api) {
    if (!ts.isNewExpression(node)) return
    const chain = chainOf(node.expression)
    if (!chain) return
    const binding = bindingsOf(api.sf).get(chain[0])
    if (!binding) return
    const segments = [...binding.path, ...chain.slice(1)]
    const cls = segments.pop()
    if (!cls || !/^[A-Z]/.test(cls)) return
    const fact: Construction = { owner: api.ownerOf(node), type: `${binding.pkg}:${segments.join('/') || 'index'}:${cls}`, site: api.site(node) }
    api.emit(fact)
  },

  assemble(api) {
    for (const { fact } of api.facts<Construction>('pulumi')) {
      const n = api.nodes.get(fact.owner)
      if (!n) continue
      const tag = `pulumi:${fact.type}`
      if (!n.tags?.includes(tag)) n.tags = [...(n.tags ?? []), tag]
    }
  },
}
