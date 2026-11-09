// Strings the code builds from constants (route paths, URLs, selectors):
// what an expression evaluates to, followed through the type checker into
// other files. It reads string and number literals, template literals, `+`,
// const variables, enum members, class properties with an initializer,
// properties of object literals (also behind an `any` type, as route path
// tables often are) and calls of functions that only return such a string.
// A part known only at run time (a parameter, a function call) is `{}`; of a
// conditional's two paths, a partial string keeps the segments both share.
import ts from 'typescript'
import { propertyName, unwrap } from './syntax.ts'

/** A part of a string only known at run time. */
export const UNKNOWN = '{}'
const MAX_DEPTH = 12

export interface EvalEnv {
  checker: ts.TypeChecker
  /** Sees every declaration followed: a plugin passes ExtractApi.idOf, so what the value came from becomes a cache dependency. */
  follow?: (decl: ts.Node) => void
  /** The placeholder for a part only known at run time (default `{}`). */
  unknown?: (e: ts.Expression) => string
}

/** The value of an expression when all of it is known before run time. */
export function constantString(e: ts.Expression | undefined, env: EvalEnv): string | undefined {
  return e && evaluate(e, env, false, 0)
}

/** The string an expression builds, with a placeholder for each part only known at run time; undefined when no part is known. */
export function partialString(e: ts.Expression | undefined, env: EvalEnv): string | undefined {
  return e && evaluate(e, env, true, 0)
}

/** The declaration a name or property access refers to, through imports and aliases. */
export function declarationOf(e: ts.Expression, checker: ts.TypeChecker): ts.Declaration | undefined {
  const x = unwrap(e)
  const at = ts.isPropertyAccessExpression(x) ? x.name : x
  let sym = checker.getSymbolAtLocation(at)
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
  return sym?.valueDeclaration ?? sym?.declarations?.[0]
}

/** The expression a function or method returns when its body is that one return (an arrow's expression body counts). */
export function returnedExpression(fn: ts.Node): ts.Expression | undefined {
  if (ts.isVariableDeclaration(fn) || ts.isPropertyDeclaration(fn) || ts.isPropertyAssignment(fn)) {
    const init = fn.initializer && unwrap(fn.initializer)
    return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? returnedExpression(init) : undefined
  }
  if (!ts.isFunctionLike(fn)) return undefined
  const body = (fn as ts.FunctionLikeDeclaration).body
  if (!body) return undefined
  if (!ts.isBlock(body)) return body
  const [only] = body.statements
  return body.statements.length === 1 && ts.isReturnStatement(only) ? only.expression : undefined
}

function evaluate(node: ts.Expression, env: EvalEnv, partial: boolean, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined
  const e = unwrap(node)
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return e.text
  // pieces in order; in a partial string an unknown piece is a placeholder, but at least one piece must be known
  const join = (pieces: (string | ts.Expression)[]) => {
    let out = ''
    let known = false
    for (const p of pieces) {
      const v = typeof p === 'string' ? p : evaluate(p, env, partial, depth + 1)
      if (v === undefined && !partial) return undefined
      if (typeof p === 'string' ? p !== '' : v !== undefined) known = true
      out += v ?? env.unknown?.(p as ts.Expression) ?? UNKNOWN
    }
    return known ? out : undefined
  }
  if (ts.isTemplateExpression(e)) return join([e.head.text, ...e.templateSpans.flatMap(s => [s.expression, s.literal.text])])
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return join([e.left, e.right])
  // one of two paths: the segments both agree on, the others only known at run time
  if (partial && ts.isConditionalExpression(e)) {
    const [a, b] = [e.whenTrue, e.whenFalse].map(x => evaluate(x, env, partial, depth + 1))
    if (a === undefined || b === undefined) return undefined
    const [sa, sb] = [a.split('/'), b.split('/')]
    return sa.length === sb.length ? sa.map((s, i) => (s === sb[i] ? s : UNKNOWN)).join('/') : undefined
  }
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const decl = declarationOf(e, env.checker)
    if (decl) env.follow?.(decl)
    if (decl && ts.isEnumMember(decl)) {
      const v = env.checker.getConstantValue(decl)
      return v === undefined ? undefined : String(v)
    }
    const value = (decl && valueOf(decl)) ?? (ts.isPropertyAccessExpression(e) ? propertyOfLiteral(e, env, depth) : undefined)
    if (value) return evaluate(value, env, partial, depth + 1)
    const type = env.checker.getTypeAtLocation(e)
    return type.isStringLiteral() ? type.value : type.isNumberLiteral() ? String(type.value) : undefined
  }
  if (ts.isCallExpression(e)) {
    const fn = declarationOf(e.expression, env.checker)
    const returned = fn && returnedExpression(fn)
    if (returned) {
      env.follow?.(fn)
      return evaluate(returned, env, partial, depth + 1)
    }
  }
  return undefined
}

/** What a declaration holds: a const's or a property's initializer. */
function valueOf(decl: ts.Declaration): ts.Expression | undefined {
  if (ts.isVariableDeclaration(decl)) return decl.parent.flags & ts.NodeFlags.Const ? decl.initializer : undefined
  if (ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) return decl.initializer
  return undefined
}

/** `PATHS.projects` where the checker knows no such property (`PATHS: any = {…}`, an index signature): the literal's property. */
function propertyOfLiteral(e: ts.PropertyAccessExpression, env: EvalEnv, depth: number): ts.Expression | undefined {
  const obj = objectLiteralOf(e.expression, env, depth)
  const prop = obj?.properties.find(p => propertyName(p) === e.name.text)
  return prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined
}

function objectLiteralOf(e: ts.Expression, env: EvalEnv, depth: number): ts.ObjectLiteralExpression | undefined {
  if (depth > MAX_DEPTH) return undefined
  const x = unwrap(e)
  if (ts.isObjectLiteralExpression(x)) return x
  if (!ts.isIdentifier(x) && !ts.isPropertyAccessExpression(x)) return undefined
  const decl = declarationOf(x, env.checker)
  if (decl) env.follow?.(decl)
  const value = (decl && valueOf(decl)) ?? (ts.isPropertyAccessExpression(x) ? propertyOfLiteral(x, env, depth + 1) : undefined)
  return value && objectLiteralOf(value, env, depth + 1)
}
