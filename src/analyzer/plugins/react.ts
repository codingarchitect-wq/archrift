// React context: `const X = createContext(…)` is a symbol of kind
// `context`; `<X.Provider>` (or React 19's `<X value>`) is a `provides` edge
// from the component, and `useContext(X)` / `use(X)` a `consumes` edge.
import ts from 'typescript'
import type { Plugin } from './types.ts'
import { calleeName, unwrap } from './syntax.ts'

const isContext = (decl: ts.Node) =>
  ts.isVariableDeclaration(decl) && !!decl.initializer && (() => {
    const e = unwrap(decl.initializer!)
    return ts.isCallExpression(e) && calleeName(e.expression) === 'createContext'
  })()

export const react: Plugin = {
  name: 'react-context',
  version: 1,

  symbolKind(decl) {
    return isContext(decl) ? { subkind: 'context' } : undefined
  },

  refKind(id, decl) {
    if (!isContext(decl)) return undefined
    let node: ts.Node = id
    // <Ctx.Provider>: the tag is `Ctx.Provider`
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && /^(Provider|Consumer)$/.test(node.parent.name.text)) {
      const consumer = node.parent.name.text === 'Consumer'
      node = node.parent
      const tag = node.parent
      if ((ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)) && tag.tagName === node) return { kind: consumer ? 'consumes' : 'provides' }
    }
    const p = id.parent
    if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === id) return { kind: 'provides' } // React 19: <Ctx value>
    if (ts.isCallExpression(p) && p.arguments.includes(id) && /^(useContext|use)$/.test(calleeName(p.expression) ?? '')) return { kind: 'consumes' }
    return undefined
  },
}
