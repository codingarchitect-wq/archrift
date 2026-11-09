// Syntax highlighting in an exported page (the static build puts this module
// where highlight.ts would be). Shiki and its grammars are about 1 MB, needed
// only when the page carries the source: `export html --source` embeds them,
// compressed to a fifth, as a module of their own (dist/static/highlight.js,
// built from highlight.ts). Without it the source shows plain.
import { importPart, pagePart } from '../static/embedded.ts'

type Highlight = typeof import('./highlight.ts')

let loaded: Promise<Highlight | undefined> | undefined

export async function tokenize(...args: Parameters<Highlight['tokenize']>): ReturnType<Highlight['tokenize']> {
  loaded ??= importPart<Highlight>(pagePart(document), 'highlighter').catch(() => undefined)
  return (await loaded)?.tokenize(...args)
}
