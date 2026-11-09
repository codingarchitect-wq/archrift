// Per-file extraction: declarations become symbol and member
// records, module specifiers are collected for resolution, and every
// identifier is resolved through the type checker to the declaration it
// refers to, becoming a reference from the innermost enclosing symbol.
import ts from 'typescript'
import { fileId, memberId, symbolId } from '../../core/ids.ts'
import type { EdgeKind, Range } from '../../core/model.ts'
import type { ExtractedFile, RefRecord, SpecifierKind, SpecifierRecord, SymbolRecord } from '../fragment.ts'
import { propertyName } from '../plugins/syntax.ts'
import type { Plugin } from '../plugins/types.ts'

export interface ExtractEnv {
  checker: ts.TypeChecker
  rel: (abs: string) => string
  /** True for files analyzed as part of the project (references elsewhere are external). */
  isProjectFile: (abs: string) => boolean
  hashOf: (relPath: string) => string | undefined
  maxSites: number
  plugins?: readonly Plugin[]
}

/** An object literal whose properties are members of the declaration it initializes. */
type Containers = (init: ts.Expression) => ts.ObjectLiteralExpression | undefined

export const containersOf =
  (plugins: readonly Plugin[] = []): Containers =>
  init => {
    for (const p of plugins) {
      const lit = p.memberContainer?.(init)
      if (lit) return lit
    }
    return undefined
  }

const SIGNATURE_MAX = 160
/** Debug aid: ARCHRIFT_TRACE_UNRESOLVED=1 prints every identifier the checker can't resolve. */
const TRACE_UNRESOLVED = !!process.env.ARCHRIFT_TRACE_UNRESOLVED

// ── Owners: which symbol or member a node belongs to ───────────────────────

export interface OwnerKey {
  symbol?: string
  member?: string
}

/**
 * The top-level declaration (and class/interface member) containing `node`.
 * Declarations and references both go through this, so a reference's target
 * id always matches the id the declaring file registered.
 */
export function ownerKey(node: ts.Node, containers?: Containers): OwnerKey {
  let stmt: ts.Node = node
  while (stmt.parent && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent
  if (!stmt.parent) return {}
  const inside = (n: ts.Node) => n.pos <= node.pos && node.end <= n.end
  if (isNamedStatement(stmt)) {
    const symbol = statementName(stmt)
    if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      for (const m of stmt.members as ts.NodeArray<ts.ClassElement | ts.TypeElement>) {
        if (!inside(m)) continue
        const member = memberName(m)
        return member ? { symbol, member } : { symbol }
      }
    }
    return { symbol }
  }
  if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (!inside(d)) continue
      if (ts.isIdentifier(d.name)) {
        // properties of a container literal (a tRPC router) are members
        const lit = d.initializer && containers?.(d.initializer)
        const prop = lit && inside(lit) ? lit.properties.find(inside) : undefined
        const member = prop && propertyName(prop)
        return member ? { symbol: d.name.text, member } : { symbol: d.name.text }
      }
      const names = bindingNames(d.name)
      const hit = names.find(b => inside(b.node))
      return names.length ? { symbol: (hit ?? names[0]).name } : {}
    }
    return {}
  }
  if (ts.isExportAssignment(stmt) && !ts.isIdentifier(stmt.expression)) return { symbol: 'default' }
  return {}
}

type NamedStatement =
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.ModuleDeclaration

function isNamedStatement(n: ts.Node): n is NamedStatement {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isClassDeclaration(n) ||
    ts.isInterfaceDeclaration(n) ||
    ts.isTypeAliasDeclaration(n) ||
    ts.isEnumDeclaration(n) ||
    ts.isModuleDeclaration(n)
  )
}

function statementName(s: NamedStatement): string {
  return s.name?.text ?? 'default'
}

export function memberName(m: ts.ClassElement | ts.TypeElement): string | undefined {
  if (ts.isConstructorDeclaration(m)) return 'constructor'
  const name = m.name
  if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)))
    return name.text
  return undefined
}

function bindingNames(pattern: ts.BindingName): { name: string; node: ts.BindingElement }[] {
  if (ts.isIdentifier(pattern)) return []
  const out: { name: string; node: ts.BindingElement }[] = []
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue
    if (ts.isIdentifier(el.name)) out.push({ name: el.name.text, node: el })
    else out.push(...bindingNames(el.name))
  }
  return out
}

// ── Classification helpers ─────────────────────────────────────────────────

const isHookName = (name: string) => /^use[A-Z0-9]/.test(name)
const isPascal = (name: string) => /^[A-Z]/.test(name)

function containsJsx(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true
    else ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

function functionSubkind(name: string, fn: ts.Node) {
  if (isHookName(name)) return 'hook'
  if (isPascal(name) && containsJsx(fn)) return 'component'
  return 'function'
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e))
    e = e.expression
  return e
}

function expressionSubkind(name: string, init: ts.Expression | undefined) {
  if (!init) return 'variable'
  const e = unwrap(init)
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return functionSubkind(name, e)
  if (ts.isClassExpression(e)) return 'class'
  // memo(() => …), forwardRef(function X() {…}) and similar wrappers
  if (ts.isCallExpression(e) && e.arguments.some(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a)))
    return isPascal(name) && containsJsx(e) ? 'component' : isHookName(name) ? 'hook' : 'variable'
  return 'variable'
}

function isFunctionLikeWithBody(n: ts.Node): n is ts.FunctionLikeDeclaration & { body: ts.Node } {
  return (
    (ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n)) &&
    n.body !== undefined
  )
}

/** Cyclomatic complexity contributions: branches, loops, catch, short-circuits. */
function decisionPoints(node: ts.Node): number {
  let count = 0
  const visit = (n: ts.Node): void => {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        count++
        break
      case ts.SyntaxKind.BinaryExpression: {
        const op = (n as ts.BinaryExpression).operatorToken.kind
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken ||
          op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
          op === ts.SyntaxKind.BarBarEqualsToken ||
          op === ts.SyntaxKind.QuestionQuestionEqualsToken
        )
          count++
        break
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return count
}

function refKind(id: ts.Identifier | ts.PrivateIdentifier): EdgeKind {
  let child: ts.Node = id
  let p = id.parent
  // climb a.b.c so `obj.method()` counts as a call of `method`
  while (ts.isPropertyAccessExpression(p) && p.name === child) {
    child = p
    p = p.parent
  }
  if (ts.isCallExpression(p) && p.expression === child) return 'calls'
  if (ts.isTaggedTemplateExpression(p) && p.tag === child) return 'calls'
  if (ts.isDecorator(p)) return 'calls'
  if (ts.isNewExpression(p) && p.expression === child) return 'instantiates'
  if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === child) return 'renders'
  for (let n: ts.Node = id; !ts.isSourceFile(n); n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent))
      return n.parent.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements'
    if (ts.isTypeNode(n)) return 'type-ref'
    if (ts.isStatement(n) || ts.isFunctionLike(n) || ts.isClassElement(n)) break
  }
  return 'references'
}

/** The identifier names the thing being declared (not a use of something else). */
function isDeclarationName(id: ts.Identifier) {
  const p = id.parent as ts.Node & { name?: ts.Node }
  return p.name === id && !ts.isPropertyAccessExpression(p) && !ts.isShorthandPropertyAssignment(p)
}

// ── Extraction ─────────────────────────────────────────────────────────────

export function extractFile(sf: ts.SourceFile, hash: string, env: ExtractEnv): ExtractedFile {
  const path = env.rel(sf.fileName)
  const { checker } = env
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos)
  const rangeOf = (n: ts.Node): Range => {
    const s = lineOf(n.getStart(sf))
    const e = lineOf(n.end)
    return [s.line + 1, s.character + 1, e.line + 1, e.character + 1]
  }

  // code lines (non-blank, not comment-only) as a prefix sum for per-range LOC
  const lines = sf.text.split('\n')
  const codeBefore = new Int32Array(lines.length + 1)
  lines.forEach((l, i) => {
    const t = l.trim()
    codeBefore[i + 1] = codeBefore[i] + (t !== '' && !/^(\/\/|\/\*|\*)/.test(t) ? 1 : 0)
  })
  const locOf = (r: Range) => codeBefore[Math.min(r[2], lines.length)] - codeBefore[r[0] - 1]

  const signatureOf = (n: ts.Node, start: ts.Node = n): string | undefined => {
    let end = n.end
    if (isFunctionLikeWithBody(n)) end = n.body.getStart(sf)
    else if (ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isEnumDeclaration(n) || ts.isClassExpression(n))
      end = n.members.pos - 1
    else if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrap(n.initializer)
      if (isFunctionLikeWithBody(init)) end = init.body.getStart(sf)
    } else if (ts.isModuleDeclaration(n) && n.body) end = n.body.getStart(sf)
    const text = sf.text.slice(start.getStart(sf), end).replace(/\s+/g, ' ').replace(/\s*(\{|=>)?\s*$/, '').trim()
    if (!text) return undefined
    return text.length > SIGNATURE_MAX ? `${text.slice(0, SIGNATURE_MAX - 1)}…` : text
  }

  // ── declarations ──
  const symbols = new Map<string, SymbolRecord>()
  const fid = fileId(path)
  const isExported = (n: ts.Node) => (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0
  const isDefault = (n: ts.Node) => (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Default) !== 0

  const add = (rec: Omit<SymbolRecord, 'loc' | 'complexity'>, body: ts.Node) => {
    const loc = locOf(rec.range)
    const complexity = 1 + decisionPoints(body)
    const existing = symbols.get(rec.id)
    if (!existing) {
      symbols.set(rec.id, { ...rec, loc, complexity })
      return
    }
    // declaration merging / overloads (`const X = …; type X = …`): one node
    if (rec.range[0] < existing.range[0]) existing.range = [rec.range[0], rec.range[1], existing.range[2], existing.range[3]]
    if (rec.range[2] > existing.range[2]) existing.range = [existing.range[0], existing.range[1], rec.range[2], rec.range[3]]
    existing.loc = locOf(existing.range)
    existing.complexity += complexity - 1
    existing.exported ||= rec.exported
    if (rec.subkind !== existing.subkind && !existing.tags.includes(`also-${rec.subkind}`)) existing.tags.push(`also-${rec.subkind}`)
    for (const t of rec.tags) if (!existing.tags.includes(t)) existing.tags.push(t)
  }

  const plugins = env.plugins ?? []
  const containers = containersOf(plugins)
  const pluginKind = <T>(f: (p: Plugin) => T | undefined) => {
    for (const p of plugins) {
      const r = f(p)
      if (r) return r
    }
    return undefined
  }

  const addMembers = (owner: string, ownerId: string, members: ts.NodeArray<ts.ClassElement | ts.TypeElement>, ownerNode: ts.Node) => {
    for (const m of members) {
      const name = memberName(m)
      if (!name) continue
      const special = pluginKind(p => p.memberKind?.(m, ownerNode))
      const subkind =
        special?.subkind ??
        (ts.isConstructorDeclaration(m)
          ? 'constructor'
          : ts.isMethodDeclaration(m) || ts.isMethodSignature(m)
            ? 'method'
            : ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)
              ? 'accessor'
              : 'property')
      const tags: string[] = [...(special?.tags ?? [])]
      const flags = ts.canHaveModifiers(m) ? ts.getCombinedModifierFlags(m as unknown as ts.Declaration) : 0
      if (flags & ts.ModifierFlags.Static) tags.push('static')
      if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected) || (m.name && ts.isPrivateIdentifier(m.name)))
        tags.push('private')
      if (flags & ts.ModifierFlags.Abstract) tags.push('abstract')
      add(
        {
          id: memberId(path, owner, name),
          kind: 'member',
          name,
          subkind,
          parent: ownerId,
          range: rangeOf(m),
          exported: false,
          signature: signatureOf(m),
          tags,
        },
        m,
      )
    }
  }

  const addObjectMembers = (owner: string, ownerId: string, lit: ts.ObjectLiteralExpression) => {
    for (const m of lit.properties) {
      const name = propertyName(m)
      if (!name) continue
      const special = pluginKind(p => p.memberKind?.(m, lit))
      const body = ts.isPropertyAssignment(m) ? m.initializer : m
      add(
        {
          id: memberId(path, owner, name),
          kind: 'member',
          name,
          subkind: special?.subkind ?? (ts.isMethodDeclaration(m) ? 'method' : 'property'),
          parent: ownerId,
          range: rangeOf(m),
          exported: false,
          signature: signatureOf(body, m),
          tags: [...(special?.tags ?? [])],
        },
        m,
      )
    }
  }

  const localExports = new Map<string, boolean>() // name → is default
  for (const stmt of sf.statements) {
    if (isNamedStatement(stmt)) {
      const name = statementName(stmt)
      const id = symbolId(path, name)
      const subkind = ts.isFunctionDeclaration(stmt)
        ? functionSubkind(name, stmt)
        : ts.isClassDeclaration(stmt)
          ? 'class'
          : ts.isInterfaceDeclaration(stmt)
            ? 'interface'
            : ts.isTypeAliasDeclaration(stmt)
              ? 'type'
              : ts.isEnumDeclaration(stmt)
                ? 'enum'
                : 'namespace'
      const special = pluginKind(p => p.symbolKind?.(stmt, name))
      const tags: string[] = [...(special?.tags ?? [])]
      if (isDefault(stmt)) tags.push('default-export')
      if (ts.isModuleDeclaration(stmt) && (ts.isStringLiteral(stmt.name) || stmt.flags & ts.NodeFlags.GlobalAugmentation))
        tags.push('ambient')
      add(
        { id, kind: 'symbol', name, subkind: special?.subkind ?? subkind, parent: fid, range: rangeOf(stmt), exported: isExported(stmt), signature: signatureOf(stmt), tags },
        stmt,
      )
      if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) addMembers(name, id, stmt.members, stmt)
    } else if (ts.isVariableStatement(stmt)) {
      const single = stmt.declarationList.declarations.length === 1
      for (const d of stmt.declarationList.declarations) {
        const exported = isExported(d)
        if (ts.isIdentifier(d.name)) {
          const name = d.name.text
          const special = pluginKind(p => p.symbolKind?.(d, name))
          add(
            {
              id: symbolId(path, name),
              kind: 'symbol',
              name,
              subkind: special?.subkind ?? expressionSubkind(name, d.initializer),
              parent: fid,
              range: rangeOf(single ? stmt : d),
              exported,
              signature: signatureOf(d, single ? stmt : d),
              tags: [...(special?.tags ?? [])],
            },
            d,
          )
          const lit = d.initializer && containers(d.initializer)
          if (lit) addObjectMembers(name, symbolId(path, name), lit)
        } else {
          for (const b of bindingNames(d.name))
            add({ id: symbolId(path, b.name), kind: 'symbol', name: b.name, subkind: 'variable', parent: fid, range: rangeOf(b.node), exported, tags: [] }, b.node)
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      if (ts.isIdentifier(stmt.expression)) {
        localExports.set(stmt.expression.text, true)
      } else {
        const e = unwrap(stmt.expression)
        const subkind =
          ts.isArrowFunction(e) || ts.isFunctionExpression(e) ? functionSubkind('default', e) : ts.isClassExpression(e) ? 'class' : 'default-export'
        add(
          { id: symbolId(path, 'default'), kind: 'symbol', name: 'default', subkind, parent: fid, range: rangeOf(stmt), exported: true, signature: signatureOf(stmt), tags: ['default-export'] },
          stmt,
        )
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text
        localExports.set(local, localExports.get(local) || el.name.text === 'default')
      }
    }
  }
  for (const [name, isDefaultExport] of localExports) {
    const s = symbols.get(symbolId(path, name))
    if (!s) continue
    s.exported = true
    if (isDefaultExport && !s.tags.includes('default-export')) s.tags.push('default-export')
  }

  // ── module specifiers ──
  const specifiers: SpecifierRecord[] = []
  const addSpec = (lit: ts.StringLiteralLike, kind: SpecifierKind) => {
    const { line, character } = lineOf(lit.getStart(sf))
    specifiers.push({ spec: lit.text, kind, line: line + 1, col: character + 1 })
  }
  const collectSpecifiers = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause
      const allTypeOnly =
        !!c &&
        (c.isTypeOnly ||
          (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every(e => e.isTypeOnly)))
      addSpec(n.moduleSpecifier, !c ? 'side-effect' : allTypeOnly ? 'type-only' : 'static')
      return
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      addSpec(n.moduleSpecifier, n.isTypeOnly ? 're-export-type' : 're-export')
      return
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      addSpec(n.moduleReference.expression, n.isTypeOnly ? 'type-only' : 'require')
      return
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      addSpec(n.argument.literal, 'type-only')
    } else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const callee = n.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) addSpec(n.arguments[0], 'dynamic')
      else if (ts.isIdentifier(callee) && callee.text === 'require') addSpec(n.arguments[0], 'require')
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        /^(vi|jest)$/.test(callee.expression.text) &&
        /^(mock|doMock)$/.test(callee.name.text)
      )
        addSpec(n.arguments[0], 'mock')
    } else if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      /^(Worker|SharedWorker)$/.test(n.expression.text) &&
      n.arguments?.[0] &&
      ts.isNewExpression(n.arguments[0])
    ) {
      const url = n.arguments[0]
      if (
        ts.isIdentifier(url.expression) &&
        url.expression.text === 'URL' &&
        url.arguments?.length === 2 &&
        ts.isStringLiteralLike(url.arguments[0]) &&
        url.arguments[1].getText(sf) === 'import.meta.url'
      )
        addSpec(url.arguments[0], 'worker')
    }
    ts.forEachChild(n, collectSpecifiers)
  }
  collectSpecifiers(sf)

  // ── references ──
  const refs = new Map<string, RefRecord>()
  const deps: Record<string, string> = {}
  const targetIds = new Map<ts.Node, string | null>()
  let unresolvedIdentifiers = 0

  const idOfDeclaration = (decl: ts.Node): string | undefined => {
    let id = targetIds.get(decl)
    if (id === undefined) {
      const dsf = decl.getSourceFile()
      if (!env.isProjectFile(dsf.fileName)) id = null
      else {
        const p = env.rel(dsf.fileName)
        if (p !== path) {
          const h = env.hashOf(p)
          if (h) deps[p] = h
        }
        const key = ownerKey(decl, containers)
        id = key.symbol === undefined ? fileId(p) : key.member ? memberId(p, key.symbol, key.member) : symbolId(p, key.symbol)
      }
      targetIds.set(decl, id)
    }
    return id ?? undefined
  }
  const addRef = (source: string, target: string, kind: EdgeKind, at: ts.Node, subkind?: string) => {
    if (source === target) return
    const key = `${source}\u0000${target}\u0000${kind}\u0000${subkind ?? ''}`
    let r = refs.get(key)
    if (!r) refs.set(key, (r = subkind ? { source, target, kind, subkind, count: 0, sites: [] } : { source, target, kind, count: 0, sites: [] }))
    r.count++
    if (r.sites.length < env.maxSites * 2) {
      const { line, character } = lineOf(at.getStart(sf))
      r.sites.push(line + 1, character + 1)
    }
  }
  const sourceIdOf = (n: ts.Node) => {
    const key = ownerKey(n, containers)
    return key.symbol === undefined ? fid : key.member ? memberId(path, key.symbol, key.member) : symbolId(path, key.symbol)
  }

  const resolveIdentifier = (id: ts.Identifier | ts.PrivateIdentifier) => {
    const p = id.parent
    let sym: ts.Symbol | undefined
    if (ts.isShorthandPropertyAssignment(p) && p.name === id) sym = checker.getShorthandAssignmentValueSymbol(p)
    else sym = checker.getSymbolAtLocation(id)
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
    const decls = sym?.declarations
    // A symbol without declarations is either intrinsic (`undefined`, `globalThis`)
    // or a property of a type that dropped them (key-remapped mapped types, e.g.
    // tRPC's ctx): nothing to link to, but not a resolution failure either.
    if (!decls?.length) {
      if (sym) return
      unresolvedIdentifiers++
      if (TRACE_UNRESOLVED) {
        const { line } = lineOf(id.getStart(sf))
        process.stderr.write(`unresolved ${path}:${line + 1} ${id.text} (${ts.SyntaxKind[p.kind]})\n`)
      }
      return
    }
    // Every declaration, not just the first: a property of a union type
    // (`(a: A | B).x`) refers to A.x and B.x, and the order TypeScript lists
    // them in depends on which files it happened to check first.
    const source = sourceIdOf(id)
    const base = refKind(id)
    const seen = new Set<string>()
    for (const d of decls) {
      const t = idOfDeclaration(d)
      if (!t || seen.has(t)) continue
      seen.add(t)
      // a plugin may know better what this reference is (an rpc call, a table query)
      const special = ts.isIdentifier(id) ? pluginKind(p => p.refKind?.(id, d)) : undefined
      addRef(source, t, special?.kind ?? base, id, special?.subkind)
    }
  }

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n)) return
    if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression)) return
    if (ts.isJsxClosingElement(n) || ts.isMetaProperty(n)) return
    if (ts.isIdentifier(n)) {
      const p = n.parent
      const skip =
        isDeclarationName(n) ||
        (ts.isJsxAttribute(p) && p.name === n) ||
        (n.text === 'const' && ts.isTypeReferenceNode(p)) || // `as const`
        ts.isLabeledStatement(p) ||
        ts.isBreakOrContinueStatement(p)
      if (!skip) resolveIdentifier(n)
    } else if (ts.isPrivateIdentifier(n) && ts.isPropertyAccessExpression(n.parent)) {
      resolveIdentifier(n)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  // plugin facts (Prisma calls, hrefs …), resolved when the graph is assembled
  const facts: Record<string, unknown[]> = {}
  const visitors = plugins.filter(p => p.visit)
  if (visitors.length) {
    const api = (p: Plugin) => ({
      sf,
      checker,
      ownerOf: sourceIdOf,
      idOf: idOfDeclaration,
      site: (n: ts.Node): [number, number] => {
        const { line, character } = lineOf(n.getStart(sf))
        return [line + 1, character + 1]
      },
      emit: (fact: unknown, channel?: string) => (facts[channel ?? p.name] ??= []).push(fact),
    })
    const apis = visitors.map(p => [p, api(p)] as const)
    const walk = (n: ts.Node): void => {
      for (const [p, a] of apis) p.visit!(n, a)
      ts.forEachChild(n, walk)
    }
    walk(sf)
  }

  // class members that implement an interface member or override a base member
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.heritageClauses) continue
    const classSym = stmt.name ? checker.getSymbolAtLocation(stmt.name) : undefined
    if (!classSym) continue
    const instance = checker.getDeclaredTypeOfSymbol(classSym)
    for (const clause of stmt.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
        for (const t of clause.types) {
          for (const prop of checker.getTypeAtLocation(t).getProperties()) {
            const ifaceDecl = prop.declarations?.[0]
            const implDecl = checker.getPropertyOfType(instance, prop.name)?.declarations?.[0]
            if (!ifaceDecl || !implDecl) continue
            const s = idOfDeclaration(implDecl)
            const target = idOfDeclaration(ifaceDecl)
            if (s && target) addRef(s, target, 'implements', (implDecl as ts.NamedDeclaration).name ?? implDecl)
          }
        }
      } else {
        const bases = instance.isClassOrInterface() ? checker.getBaseTypes(instance) : []
        for (const m of stmt.members) {
          const name = memberName(m)
          if (!name || name === 'constructor') continue
          for (const base of bases) {
            const baseDecl = checker.getPropertyOfType(base, name)?.declarations?.[0]
            const target = baseDecl && idOfDeclaration(baseDecl)
            if (target) addRef(memberId(path, statementName(stmt), name), target, 'overrides', m.name ?? m)
          }
        }
      }
    }
  }

  const tags: string[] = []
  if (sf.isDeclarationFile) tags.push('declaration')
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) break
    if (s.expression.text === 'use client') tags.push('use-client')
    if (s.expression.text === 'use server') tags.push('use-server')
  }

  return {
    path,
    hash,
    loc: codeBefore[lines.length],
    complexity: 1 + decisionPoints(sf),
    tags,
    symbols: [...symbols.values()],
    refs: [...refs.values()],
    specifiers,
    deps,
    unresolvedIdentifiers,
    ...(Object.keys(facts).length ? { facts } : {}),
  }
}
