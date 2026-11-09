// Where a JavaScript or TypeScript file's text is code, and where it only
// talks about code: comments, string and template literals, regular
// expressions. One pass of TypeScript's scanner, no parser: a `/` after
// something that ends an expression divides, else it starts a regular
// expression; a `}` that closes a template's `${` goes on with the template.
// That tells a pattern written in a regular expression or a label from a use
// of it (ways of doing a job), and a type whose name looks like a decision
// id from an id a comment cites. JSX text is read as code, which only costs a match there.
import ts from 'typescript'

export type LiteralKind = 'comment' | 'string' | 'regex'
export interface LiteralSpan {
  kind: LiteralKind
  start: number
  end: number
}

const K = ts.SyntaxKind
const KIND = new Map<ts.SyntaxKind, LiteralKind>([
  [K.SingleLineCommentTrivia, 'comment'],
  [K.MultiLineCommentTrivia, 'comment'],
  [K.StringLiteral, 'string'],
  [K.NoSubstitutionTemplateLiteral, 'string'],
  [K.TemplateHead, 'string'],
  [K.TemplateMiddle, 'string'],
  [K.TemplateTail, 'string'],
  [K.RegularExpressionLiteral, 'regex'],
])
const TRIVIA = new Set([K.WhitespaceTrivia, K.NewLineTrivia, K.SingleLineCommentTrivia, K.MultiLineCommentTrivia, K.ShebangTrivia, K.ConflictMarkerTrivia])
/** Tokens that end an expression: a `/` after them divides. */
const ENDS_EXPRESSION = new Set([
  K.Identifier,
  K.PrivateIdentifier,
  K.NumericLiteral,
  K.BigIntLiteral,
  K.StringLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.TemplateTail,
  K.RegularExpressionLiteral,
  K.CloseParenToken,
  K.CloseBracketToken,
  K.CloseBraceToken,
  K.ThisKeyword,
  K.SuperKeyword,
  K.TrueKeyword,
  K.FalseKeyword,
  K.NullKeyword,
  K.PlusPlusToken,
  K.MinusMinusToken,
])

/** A JavaScript or TypeScript file, by its name. */
export const isScript = (path: string) => /\.[cm]?[jt]sx?$/.test(path)

interface ScanState {
  scanner: ts.Scanner
  /** The brace depth at each `${` still open. */
  templates: number[]
  depth: number
  /** The last two tokens that weren't trivia. */
  last: ts.SyntaxKind
  beforeLast: ts.SyntaxKind
}

const isKeyword = (k: ts.SyntaxKind) => k >= K.FirstKeyword && k <= K.LastKeyword

/** Whether a `/` here divides: after an expression, or a keyword used as a property name (`x.default / 2`). */
const divides = (s: ScanState) => ENDS_EXPRESSION.has(s.last) || (isKeyword(s.last) && (s.beforeLast === K.DotToken || s.beforeLast === K.QuestionDotToken))

/** The token as it reads in context: a regular expression, or the rest of a template. */
function reScan(s: ScanState, token: ts.SyntaxKind): ts.SyntaxKind {
  if ((token === K.SlashToken || token === K.SlashEqualsToken) && !divides(s)) return s.scanner.reScanSlashToken()
  if (token === K.CloseBraceToken && s.templates.at(-1) === s.depth) return s.scanner.reScanTemplateToken(false)
  return token
}

function track(s: ScanState, token: ts.SyntaxKind) {
  if (token === K.TemplateHead) s.templates.push(s.depth)
  else if (token === K.TemplateTail && s.templates.length) s.templates.pop()
  else if (token === K.OpenBraceToken) s.depth++
  else if (token === K.CloseBraceToken) s.depth--
  if (TRIVIA.has(token)) return
  s.beforeLast = s.last
  s.last = token
}

/** The comments, string and template literals and regular expressions of a script, in order. */
export function literalSpans(text: string, jsx = false): LiteralSpan[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text)
  const s: ScanState = { scanner, templates: [], depth: 0, last: K.Unknown, beforeLast: K.Unknown }
  const spans: LiteralSpan[] = []
  for (let token = scanner.scan(); token !== K.EndOfFileToken; token = scanner.scan()) {
    token = reScan(s, token)
    const kind = KIND.get(token)
    if (kind) spans.push({ kind, start: scanner.getTokenStart(), end: scanner.getTokenEnd() })
    track(s, token)
  }
  return spans
}

const blank = (text: string) => text.replace(/[^\n\r]/g, ' ')

/** The text with the spans `hide` picks turned to spaces, line breaks kept: same length, same lines and columns. */
export function hideSpans(text: string, spans: readonly LiteralSpan[], hide: (kind: LiteralKind) => boolean): string {
  let out = ''
  let at = 0
  for (const s of spans) {
    if (!hide(s.kind)) continue
    out += text.slice(at, s.start) + blank(text.slice(s.start, s.end))
    at = s.end
  }
  return out + text.slice(at)
}

/** Only the spans `keep` picks, everything else turned to spaces (line breaks kept). */
export function keepSpans(text: string, spans: readonly LiteralSpan[], keep: (kind: LiteralKind) => boolean): string {
  let out = ''
  let at = 0
  for (const s of spans) {
    if (!keep(s.kind)) continue
    out += blank(text.slice(at, s.start)) + text.slice(s.start, s.end)
    at = s.end
  }
  return out + blank(text.slice(at))
}

/** A script's comments and strings alone, where a document's id is cited; code turned to spaces. */
export const proseOf = (text: string, path: string) => keepSpans(text, literalSpans(text, /x$/.test(path)), kind => kind !== 'regex')
