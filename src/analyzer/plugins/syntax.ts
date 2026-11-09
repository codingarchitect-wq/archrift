// Small syntactic helpers the plugins share.
import ts from 'typescript'

export function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression
  return e
}

/** The name a call is made through: `f()` → f, `a.b.f()` → f. */
export function calleeName(callee: ts.Expression): string | undefined {
  const e = unwrap(callee)
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

/** The member accessed right after the chain `id` ends: in `a.b.list.query()`, for `list` → query. */
export function nextAccess(id: ts.Identifier): string | undefined {
  let node: ts.Node = id
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) node = node.parent
  const p = node.parent
  return ts.isPropertyAccessExpression(p) && p.expression === node ? p.name.text : undefined
}

/** Name of an object-literal property or method. */
export function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  const name = p.name
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text
  return undefined
}

/** The string value of a literal-ish expression: 'x', "x", `x` (no substitutions). */
export function stringValue(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined
  const u = unwrap(e)
  return ts.isStringLiteralLike(u) ? u.text : undefined
}
