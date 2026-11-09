// tree-sitter for the languages TypeScript's compiler doesn't read (Kotlin,
// Go): web-tree-sitter runs the parsers as WebAssembly, so nothing is built
// natively on install. Each grammar package ships its own .wasm; the runtime
// and the grammars are loaded once per process.
import { createRequire } from 'node:module'
import { Language, Parser } from 'web-tree-sitter'
import type { Node, Tree } from 'web-tree-sitter'

export type { Node, Tree }

const GRAMMARS = {
  kotlin: '@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
} as const

export type Grammar = keyof typeof GRAMMARS

const require = createRequire(import.meta.url)
let ready: Promise<void> | undefined
const languages = new Map<Grammar, Promise<Language>>()

/** A parser for one grammar. Trees it returns must be `delete()`d: they live in WebAssembly memory. */
export async function parserFor(grammar: Grammar): Promise<Parser> {
  ready ??= Parser.init()
  await ready
  let language = languages.get(grammar)
  if (!language) languages.set(grammar, (language = Language.load(require.resolve(GRAMMARS[grammar]))))
  const parser = new Parser()
  parser.setLanguage(await language)
  return parser
}

/** [startLine, startCol, endLine, endCol], 1-based, as the graph's ranges are. */
export function rangeOf(n: Node): [number, number, number, number] {
  return [n.startPosition.row + 1, n.startPosition.column + 1, n.endPosition.row + 1, n.endPosition.column + 1]
}

/** [line, col], 1-based: where a reference is. */
export function siteOf(n: Node): [number, number] {
  return [n.startPosition.row + 1, n.startPosition.column + 1]
}

/** The named children of a node (tree-sitter's `namedChildren` allocates a node per call; this keeps to one array). */
export function named(n: Node): Node[] {
  const out: Node[] = []
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i)
    if (c) out.push(c)
  }
  return out
}

/** The first named child of a type. */
export function childOf(n: Node, type: string): Node | undefined {
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i)
    if (c?.type === type) return c
  }
  return undefined
}

/** Whether a node has an unnamed child token of this text (a keyword such as `interface` or `val`). */
export function hasToken(n: Node, token: string): boolean {
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i)
    if (c && !c.isNamed && c.type === token) return true
  }
  return false
}
