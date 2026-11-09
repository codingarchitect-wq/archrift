// Documents and the code they're about (config `docs`, docs/QUERY.md): which
// documents name which files, folders and functions, and which decision ids
// (`D34`, `ADR-12`, `M29`) the code cites and the documents define. All of it
// read from the text, no LLM: a document names code by its path (`src/lib/db.ts`,
// `../app/src/lib/`, `waterfall.ts` when only one file has that name) or, in a
// code span, by an exported name (`useDataService`, `DataService.getTransactions`);
// it defines an id in a heading, in a table row's first cell, or in a bold lead
// (`**D45 — …**`). An id counts when some document defines it and some code
// cites it; one several documents define is meant from the document that fits
// the citing file best.
//
// Pure: the analyzer reads the files (src/analyzer/docs.ts), the server, an
// exported page and the CLI read the result from the graph's meta.
import type { GraphIndex } from './graph-index.ts'
import type { Graph, GraphNode } from './model.ts'

/** Id-shaped words: one to three capitals, an optional dash, one to three digits (`D34`, `M29`, `ADR-12`, `L-1`). */
export const DEFAULT_ID_PATTERN = '\\b[A-Z]{1,3}-?\\d{1,3}\\b'

export interface DocsMeta {
  /** The documents read, by path relative to the root (`docs/setup.md`, `../design-docs/specs/SPEC.md`). */
  docs: DocMeta[]
  /** The decision ids some document defines and some code cites, in natural order. */
  ids: IdMeta[]
}

export interface DocMeta {
  path: string
  title: string
  /** Kept true to the code (config `docs.current`): `diff` names it when code it describes changes. */
  current?: true
  /** The code it names (a file, folder, function or member node), first place each. */
  mentions: DocMention[]
  /** Paths it names that no file has: moved, deleted, or another project's. */
  dangling?: DocPlace[]
}

export interface DocPlace {
  text: string
  line: number
  /** The heading above it. */
  section?: string
}

export interface DocMention {
  node: string
  line: number
  section?: string
  /** How often the document names it. */
  count: number
}

export interface IdMeta {
  id: string
  /** Where documents define it. */
  defined: IdDefinition[]
  /** The code citing it, with the documents it is meant from. */
  cited: IdCitation[]
}

export interface IdDefinition {
  doc: string
  line: number
  /** What the definition says, briefly: the heading, the row's next cell, the rest of the bold lead. */
  label: string
}

export interface IdCitation {
  file: string
  /** The first line citing it. */
  line: number
  count: number
  /** The defining documents that fit this file best (one, unless they tie). */
  docs: string[]
}

/** What a document says, before it is matched against the code. */
export interface ParsedDoc {
  path: string
  title: string
  /** Path-like words: `src/lib/db.ts`, `../app/src/lib/`, `waterfall.ts`. */
  paths: DocPlace[]
  /** Identifiers in code spans: `useDataService`, `DataService.getTransactions`. */
  symbols: DocPlace[]
  /** Ids the document defines: in a heading, a table row's first cell, a bold lead. */
  definitions: { id: string; line: number; label: string }[]
}

// ── reading a document ──────────────────────────────────────────────────────

const CODE_EXT = 'tsx?|jsx?|mjs|cjs|mts|cts|kts?|go|avsc|prisma|sql|json|css|scss|vue|svelte|py|java|rb|rs|cs|php|swift'
/** A path ending in a file name with a code extension, or a folder path ending in a slash. */
const PATH = new RegExp(`[\\w@.()\\[\\]~-]*(?:/[\\w@.()\\[\\]~-]+)*\\.(?:${CODE_EXT})(?![\\w-])|(?:[\\w@.()\\[\\]~-]+/){2,}`, 'g')
const URL = /\b[a-z][\w+.-]*:\/\/\S+/gi
const LABEL_MAX = 100
const SECTION_MAX = 80

/** A document's title, the code it names, and the ids it defines. `ids`: the id pattern, or none to skip them. */
export function parseDoc(path: string, text: string, ids?: RegExp): ParsedDoc {
  const html = /\.html?$/i.test(path)
  const doc: ParsedDoc = { path, title: titleOf(path, text, html), paths: [], symbols: [], definitions: [] }
  const exact = ids && new RegExp(`^(?:${ids.source})$`)
  let section: string | undefined
  let fenced = false
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    if (!html && /^\s*(```|~~~)/.test(raw)) fenced = !fenced
    const heading = fenced ? undefined : headingOf(raw, html)
    if (heading !== undefined) section = clip(heading, SECTION_MAX)
    const at = { line, ...(section ? { section } : {}) }
    for (const text of pathsIn(raw, html)) doc.paths.push({ text, ...at })
    for (const text of codeSpans(raw, html)) if (SYMBOL.test(text) && codeLike(text)) doc.symbols.push({ text: text.replace(/\(\)$/, ''), ...at })
    if (ids && exact && !fenced) for (const d of definitionsIn(raw, html, heading, ids, exact)) doc.definitions.push({ ...d, line })
  })
  return doc
}

/** `Name` or `Name.member`, a call's parentheses allowed. */
const SYMBOL = /^[A-Za-z_$][\w$]{3,}(?:\.[A-Za-z_$][\w$]*)?(?:\(\))?$/

/**
 * A name that looks like code: a capital after its first letter, or an underscore (`useDataService`,
 * `DataService`, `MAX_ROWS`), or ten letters at least. A plain word in a code span (`config`,
 * `prisma`) more often means the tool or the idea than an export of that name.
 */
const codeLike = (text: string) => {
  const name = text.split('.')[0]
  return /^.+[A-Z_]/.test(name) || name.length >= 10
}

function titleOf(path: string, text: string, html: boolean): string {
  const found = html ? (/<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1] ?? /<h1[^>]*>(.*?)<\/h1>/is.exec(text)?.[1]) : /^#\s+(.+?)\s*#*$/m.exec(text)?.[1]
  const title = found === undefined ? '' : plain(found, html)
  return title || path.split('/').pop()!
}

/** The heading text a line holds, if it is one. */
function headingOf(raw: string, html: boolean): string | undefined {
  const m = html ? /<h[1-6][^>]*>(.*?)<\/h[1-6]>/i.exec(raw) : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw)
  return m ? plain(m[1], html) : undefined
}

/** Path-like words on a line, links and attributes included; URLs left out. */
function pathsIn(raw: string, html: boolean): string[] {
  const attrs = html ? [...raw.matchAll(/\b(?:href|src)="([^"]+)"/gi)].map(m => decode(m[1])) : []
  const words = [...attrs, html ? decode(stripTags(raw)) : raw].map(s => s.replace(URL, ' '))
  return words
    .flatMap(s => [...s.matchAll(PATH)].map(m => m[0]))
    .map(t => (t.includes('](') ? t.slice(t.lastIndexOf('](') + 2) : t)) // a markdown link: its target
    .filter(t => t.includes('.') || t.endsWith('/'))
}

/** The contents of a line's code spans: `` `x` `` in markdown, `<code>x</code>` in HTML. */
function codeSpans(raw: string, html: boolean): string[] {
  const spans = html ? [...raw.matchAll(/<code[^>]*>(.*?)<\/code>/gi)].map(m => decode(stripTags(m[1]))) : [...raw.matchAll(/`([^`\n]+)`/g)].map(m => m[1])
  return spans.map(s => s.trim())
}

/** Ids a line defines: in a heading, a table row's first cell, or a bold lead. */
function definitionsIn(raw: string, html: boolean, heading: string | undefined, ids: RegExp, exact: RegExp): { id: string; label: string }[] {
  if (heading !== undefined) return [...heading.matchAll(new RegExp(ids.source, 'g'))].map(m => ({ id: m[0], label: clip(heading, LABEL_MAX) }))
  const lead = html ? htmlLead(raw) : markdownLead(raw)
  if (!lead || !exact.test(lead.id)) return []
  return [{ id: lead.id, label: clip(lead.label.replace(/^[\s:—–·.,-]+/, ''), LABEL_MAX) }]
}

/** `| D26 | Retirement … |`, `| **D53** | … |`, `**D45 — …**`, `- **M29:** …`, `- [x] **R6 …**`: the id first, then what it says. */
function markdownLead(raw: string): { id: string; label: string } | undefined {
  const row = /^\s*\|\s*[*`_]*([^|*`_]+?)[*`_]*\s*\|(.*)$/.exec(raw)
  if (row) return { id: row[1].trim(), label: telling(row[2].split('|').map(c => plain(c, false))) }
  const bold = /^\s*(?:[-*+]\s+|\d+\.\s+)?(?:\[[ xX]\]\s+)?\*\*([A-Za-z]+-?\d+)\b(.*?)\*\*(.*)$/.exec(raw)
  return bold ? { id: bold[1], label: plain(`${bold[2]} ${bold[3]}`, false) } : undefined
}

/** `<tr><td class="id">G12</td><td>…</td>`, `<li><strong>D45</strong> …`. */
function htmlLead(raw: string): { id: string; label: string } | undefined {
  const row = /^\s*(?:<tr[^>]*>\s*)?<t[dh][^>]*>\s*((?:<[^>]+>\s*)*)([^<]+?)\s*((?:<\/[^>]+>\s*)*)<\/t[dh]>(.*)$/i.exec(raw)
  if (row) {
    const cells = [...row[4].matchAll(/<t[dh][^>]*>(.*?)(?:<\/t[dh]>|$)/gi)].map(m => plain(m[1], true))
    return { id: decode(row[2]).trim(), label: telling(cells.length ? cells : [plain(row[4], true)]) }
  }
  const bold = /^\s*<(?:li|p)[^>]*>\s*<(?:strong|b)>\s*([A-Za-z]+-?\d+)\b(.*)$/i.exec(raw)
  return bold ? { id: bold[1], label: plain(bold[2], true) } : undefined
}

/** The first cell that says something: not empty, not a date or a number. */
function telling(cells: string[]): string {
  return cells.find(c => /\p{L}{3}/u.test(c) && !/^\d{4}-\d{2}(-\d{2})?$/.test(c)) ?? cells.find(c => c) ?? ''
}

function plain(s: string, html: boolean): string {
  const text = html ? decode(stripTags(s)) : s.replace(/[*`]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  return text.replace(/\s+/g, ' ').trim()
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, ' ')
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–', middot: '·', rarr: '→' }
const decode = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (/^#\d+$/.test(e) ? String.fromCodePoint(Number(e.slice(1))) : m))
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Where a file cites an id: the first line, its text, and how often. */
export interface Citation {
  line: number
  count: number
  /** The first citing line, trimmed: its words tell which of several definitions is meant. */
  text: string
}

/** Where a file cites ids: each id the pattern finds (and `keep` accepts). */
export function citedIds(text: string, ids: RegExp, keep: (id: string) => boolean): Map<string, Citation> {
  const found = new Map<string, Citation>()
  const all = new RegExp(ids.source, 'g')
  text.split('\n').forEach((raw, i) => {
    for (const m of raw.matchAll(all)) {
      if (!keep(m[0])) continue
      const seen = found.get(m[0])
      if (seen) seen.count++
      else found.set(m[0], { line: i + 1, count: 1, text: clip(raw.trim(), 200) })
    }
  })
  return found
}

// ── matching documents to the code ──────────────────────────────────────────

export interface LinkInput {
  graph: Graph
  index: GraphIndex
  docs: readonly ParsedDoc[]
  /** Code file path → the ids it cites (only ids some document defines). */
  citations: ReadonlyMap<string, ReadonlyMap<string, Citation>>
  /** Is the document kept true to the code? */
  current: (doc: string) => boolean
}

/** Most dangling paths kept per document. */
const DANGLING_MAX = 300

/** The documents matched to the code: what each names, and the ids the code cites. */
export function linkDocs(input: LinkInput): DocsMeta {
  const resolver = new CodeResolver(input.graph, input.index)
  const docs = input.docs.map(d => linkDoc(d, resolver, input.current(d.path))).sort((a, b) => cmp(a.path, b.path))
  return { docs, ids: linkIds(input, docs) }
}

function linkDoc(d: ParsedDoc, resolver: CodeResolver, current: boolean): DocMeta {
  const mentions = new Map<string, DocMention>()
  const dangling: DocPlace[] = []
  const add = (node: string | undefined, at: DocPlace) => {
    if (!node) return false
    const m = mentions.get(node)
    if (m) m.count++
    else mentions.set(node, { node, line: at.line, ...(at.section ? { section: at.section } : {}), count: 1 })
    return true
  }
  for (const p of d.paths) {
    if (add(resolver.path(p.text), p)) continue
    const text = normalize(p.text)
    if (text.includes('/') && !text.endsWith('/') && dangling.length < DANGLING_MAX) dangling.push({ ...p, text })
  }
  for (const s of d.symbols) add(resolver.symbol(s.text), s)
  return {
    path: d.path,
    title: d.title,
    ...(current ? { current: true as const } : {}),
    mentions: [...mentions.values()].sort((a, b) => a.line - b.line || cmp(a.node, b.node)),
    ...(dangling.length ? { dangling } : {}),
  }
}

function linkIds(input: LinkInput, docs: DocMeta[]): IdMeta[] {
  const defined = new Map<string, IdDefinition[]>()
  for (const d of input.docs) for (const def of d.definitions) push(defined, def.id, { doc: d.path, line: def.line, label: def.label })
  const named = new Map(docs.map(d => [d.path, new Set(d.mentions.map(m => m.node))]))
  const cited = new Map<string, IdCitation[]>()
  for (const [file, ids] of input.citations)
    for (const [id, at] of ids) {
      const defs = defined.get(id)
      if (!defs) continue
      const docsMeant = meantFrom(defs, { file, ids, text: at.text }, defined, named, input.current)
      push(cited, id, { file, line: at.line, count: at.count, docs: docsMeant })
    }
  return [...cited.keys()]
    .sort(naturalCmp)
    .map(id => ({ id, defined: firstPerDoc(defined.get(id)!), cited: cited.get(id)!.sort((a, b) => cmp(a.file, b.file)) }))
}

/**
 * The documents an id cited in a file is meant from: the one defining it when only one does,
 * else those that fit the file best: whose definition shares words with the citing line, that
 * define the file's other ids too, name the file or files beside it, or are kept current.
 */
function meantFrom(defs: IdDefinition[], at: { file: string; ids: ReadonlyMap<string, unknown>; text: string }, defined: Map<string, IdDefinition[]>, named: Map<string, Set<string>>, current: (doc: string) => boolean): string[] {
  const docs = [...new Set(defs.map(d => d.doc))].sort(cmp)
  if (docs.length === 1) return docs
  const line = stems(at.text)
  const dir = at.file.slice(0, at.file.lastIndexOf('/') + 1)
  const score = (doc: string) => {
    const others = [...at.ids.keys()].filter(other => defined.get(other)?.some(d => d.doc === doc)).length
    const shared = Math.max(0, ...defs.filter(d => d.doc === doc).map(d => [...stems(d.label)].filter(w => line.has(w)).length))
    const names = named.get(doc)
    const near = dir !== '' && [...(names ?? [])].some(id => id.slice(2).startsWith(dir))
    return 2 * shared + others + (names?.has(`f:${at.file}`) ? 3 : near ? 1 : 0) + (current(doc) ? 0.5 : 0)
  }
  const scores = new Map(docs.map(d => [d, score(d)]))
  const best = Math.max(...scores.values())
  return docs.filter(d => scores.get(d) === best).slice(0, 3)
}

const STOP = new Set(['with', 'that', 'this', 'from', 'when', 'into', 'only', 'also', 'each', 'have', 'been', 'they', 'their', 'than', 'then', 'none', 'what', 'which', 'there', 'where', 'here', 'more', 'most', 'some', 'does', 'done'])

/** A text's words of four letters or more, by their first five (`animations` and `animation` meet). */
function stems(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter(w => !STOP.has(w)).map(w => w.slice(0, 5)))
}

/** One definition per document: its first. */
function firstPerDoc(defs: IdDefinition[]): IdDefinition[] {
  const seen = new Set<string>()
  return defs.filter(d => !seen.has(d.doc) && seen.add(d.doc))
}

/**
 * Finds the code a document names. A path is a file (or folder) whose path it ends
 * with, or that ends with it when only one does; a name in a code span is an exported
 * function, class or type only one file declares, or a member of one.
 */
export class CodeResolver {
  private readonly bySuffix = new Map<string, string[]>()
  private readonly full = new Map<string, string>()
  private readonly exported = new Map<string, GraphNode[]>()
  private readonly index: GraphIndex

  constructor(graph: Graph, index: GraphIndex) {
    this.index = index
    for (const n of graph.nodes) {
      if ((n.kind === 'file' || n.kind === 'directory') && n.path) this.addPath(n.kind === 'directory' ? `${n.path}/` : n.path, n.id)
      if (n.kind === 'symbol' && n.exported && n.parent?.startsWith('f:')) push(this.exported, n.name, n)
    }
  }

  private addPath(path: string, id: string) {
    this.full.set(path, id)
    const parts = path.split('/')
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/')
      if (suffix && suffix !== '/') push(this.bySuffix, suffix, id)
    }
  }

  /** The node a path-like word names, if one does. */
  path(text: string): string | undefined {
    const t = normalize(text)
    if (!t || (t.endsWith('/') && t.split('/').length < 3)) return undefined // `lib/` alone is too vague
    const hits = this.bySuffix.get(t)
    if (hits?.length === 1) return hits[0]
    // longer than the project's path: `app/src/lib/db.ts`, `../app/src/lib/db.ts`
    const parts = t.split('/')
    for (let i = 1; i < parts.length - 1; i++) {
      const id = this.full.get(parts.slice(i).join('/'))
      if (id) return id
    }
    return undefined
  }

  /** The node an identifier names: `Name` (an exported declaration only one file has) or `Name.member`. */
  symbol(text: string): string | undefined {
    const [name, member] = text.split('.')
    const decls = this.exported.get(name)
    if (decls?.length !== 1) return undefined
    const owner = decls[0]
    if (!member) return owner.id
    const m = `${owner.id}.${member}`
    return this.index.node(m) ? m : owner.id
  }
}

/**
 * A path-like word as the project's paths are written: a markdown link's target, no `./`
 * or `../`, no opening bracket it doesn't close (`(src/lib/db.ts` → `src/lib/db.ts`, but
 * `(dashboard)/page.tsx` stays).
 */
export function normalize(text: string): string {
  let t = text.includes('](') ? text.slice(text.lastIndexOf('](') + 2) : text
  while ((t.startsWith('(') && !t.includes(')')) || (t.startsWith('[') && !t.includes(']'))) t = t.slice(1)
  while (t.startsWith('./') || t.startsWith('../')) t = t.slice(t.indexOf('/') + 1)
  return t.replace(/^\/+/, '')
}

// ── asking ─────────────────────────────────────────────────────────────────

export interface DocRef {
  doc: string
  title: string
  current: boolean
  /** The places in it naming the code asked about, first first. */
  places: { node: string; line: number; section?: string; count: number }[]
}

/** The documents naming any of these nodes (a set, or a test), current ones first, then those naming them most. */
export function docsNaming(meta: DocsMeta | undefined, nodes: ReadonlySet<string> | ((node: string) => boolean)): DocRef[] {
  const refs: DocRef[] = []
  const test = typeof nodes === 'function' ? nodes : (n: string) => nodes.has(n)
  for (const d of meta?.docs ?? []) {
    const places = d.mentions.filter(m => test(m.node))
    if (places.length) refs.push({ doc: d.path, title: d.title, current: !!d.current, places })
  }
  const weight = (r: DocRef) => r.places.reduce((n, p) => n + p.count, 0)
  return refs.sort((a, b) => Number(b.current) - Number(a.current) || weight(b) - weight(a) || cmp(a.doc, b.doc))
}

export interface CitedId {
  id: string
  /** Where it is cited among the files asked about: the first file and line. */
  file: string
  line: number
  /** The definitions in the documents it is meant from. */
  meant: IdDefinition[]
  /** Its definitions in other documents. */
  also: IdDefinition[]
}

/**
 * What the documents say about one node of the viewer, by its id alone (the viewer may not have
 * loaded its functions): a file and its functions, a folder and everything below it, a function
 * and its members; and the ids the files among them cite.
 */
export function docsOfNode(meta: DocsMeta | undefined, node: { id: string; kind: string; path?: string }): { named: DocRef[]; cites: CitedId[] } {
  if (!meta) return { named: [], cites: [] }
  const p = node.path ?? ''
  const under = (id: string) => id.slice(2).startsWith(`${p}/`) || (id.startsWith('s:') && id.slice(2).startsWith(`${p}#`))
  const test =
    node.kind === 'directory' ? (id: string) => id === node.id || (p !== '' && under(id)) || p === '' || p === '.'
    : node.kind === 'file' ? (id: string) => id === node.id || id.startsWith(`s:${p}#`)
    : (id: string) => id === node.id || id.startsWith(`${node.id}.`)
  const files = new Set(node.kind === 'directory' ? meta.ids.flatMap(i => i.cited.map(c => c.file)).filter(f => p === '' || p === '.' || f.startsWith(`${p}/`)) : node.kind === 'file' ? [p] : [])
  return { named: docsNaming(meta, test), cites: idsCitedBy(meta, files) }
}

/** The ids these files cite, with the definitions meant, in natural order. */
export function idsCitedBy(meta: DocsMeta | undefined, files: ReadonlySet<string>): CitedId[] {
  const out: CitedId[] = []
  for (const id of meta?.ids ?? []) {
    const c = id.cited.find(x => files.has(x.file))
    if (!c) continue
    const docs = new Set(id.cited.filter(x => files.has(x.file)).flatMap(x => x.docs))
    out.push({ id: id.id, file: c.file, line: c.line, meant: id.defined.filter(d => docs.has(d.doc)), also: id.defined.filter(d => !docs.has(d.doc)) })
  }
  return out
}

/** The document a path names: exactly, or the only one whose path ends with it (`SPEC.md`). */
export function findDoc(meta: DocsMeta | undefined, text: string): DocMeta | undefined {
  const t = normalize(text)
  const docs = meta?.docs ?? []
  const exact = docs.find(d => d.path === text || normalize(d.path) === t)
  if (exact) return exact
  const ends = docs.filter(d => d.path.endsWith(`/${t}`) || d.path === t)
  return ends.length === 1 ? ends[0] : undefined
}

export function findId(meta: DocsMeta | undefined, text: string): IdMeta | undefined {
  return meta?.ids.find(i => i.id === text.trim())
}

/** Which current documents name a path removed (dangling now), by the same rule a path names a file. */
export function namingRemoved(meta: DocsMeta | undefined, removed: readonly string[]): { doc: DocMeta; place: DocPlace; file: string }[] {
  if (!removed.length) return []
  const out: { doc: DocMeta; place: DocPlace; file: string }[] = []
  for (const doc of meta?.docs ?? []) {
    if (!doc.current) continue
    for (const place of doc.dangling ?? []) {
      const t = normalize(place.text)
      const file = removed.find(p => p === t || p.endsWith(`/${t}`) || t.endsWith(`/${p}`))
      if (file) out.push({ doc, place, file })
    }
  }
  return out
}

// ── after a change ─────────────────────────────────────────────────────────

/** A place in a document kept current that names code a change removes or reshapes. */
export interface StaleDoc {
  doc: string
  title: string
  line: number
  section?: string
  /** The code it names: a file or folder path, a function as `path › name`. */
  names: string
  /** The file that code is in (or the folder), for pinning the finding. */
  path: string
  /** removed: the file, folder or function is gone; reshaped: its exports or signature changed. */
  why: 'removed' | 'reshaped'
}

export interface CodeChange {
  /** Files the change removes. */
  removed: readonly string[]
  /** Was the node there before and isn't now? */
  gone: (node: string) => boolean
  /** Did its exports (a file) or its signature (a function) change? */
  reshaped: (node: string) => boolean
}

/**
 * The places in documents kept current that name what a change removes or reshapes: from the
 * base's documents what's gone (a base analyzed before documents were read has none), from the
 * head's what's reshaped, and paths the head's documents name that the change removed.
 */
export function staleDocs(base: DocsMeta | undefined, head: DocsMeta | undefined, change: CodeChange): StaleDoc[] {
  const out = new Map<string, StaleDoc>()
  const current = new Set((head?.docs ?? []).filter(d => d.current).map(d => d.path))
  const put = (d: DocMeta, at: { line: number; section?: string }, node: string, why: StaleDoc['why']) => {
    const key = `${d.path}\0${node}`
    if (!out.has(key)) out.set(key, { doc: d.path, title: d.title, line: at.line, ...(at.section ? { section: at.section } : {}), names: nodeLabel(node), path: nodePath(node), why })
  }
  for (const d of base?.docs ?? []) if (d.current && (current.has(d.path) || !head)) for (const m of d.mentions) if (change.gone(m.node)) put(d, m, m.node, 'removed')
  for (const d of head?.docs ?? []) if (d.current) for (const m of d.mentions) if (change.reshaped(m.node)) put(d, m, m.node, 'reshaped')
  for (const { doc, place, file } of namingRemoved(head, change.removed)) put(doc, place, `f:${file}`, 'removed')
  return [...out.values()].sort((a, b) => cmp(a.doc, b.doc) || a.line - b.line)
}

/** A node as a reader names it: a path, a folder with its slash, a function as `path › name`. */
export function nodeLabel(id: string): string {
  if (id.startsWith('d:')) return `${id.slice(2)}/`
  if (id.startsWith('s:')) return `${id.slice(2, id.indexOf('#'))} › ${id.slice(id.indexOf('#') + 1)}`
  return id.replace(/^[fx]:/, '')
}

const nodePath = (id: string) => (id.startsWith('s:') ? id.slice(2, id.indexOf('#')) : id.replace(/^[dfx]:/, ''))

// ── helpers ──────────────────────────────────────────────────────────────────

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** `D2` before `D10`, `ADR-3` before `ADR-12`. */
export function naturalCmp(a: string, b: string): number {
  const [pa, na] = [a.replace(/\d+$/, ''), Number(/\d+$/.exec(a)?.[0] ?? 0)]
  const [pb, nb] = [b.replace(/\d+$/, ''), Number(/\d+$/.exec(b)?.[0] ?? 0)]
  return cmp(pa, pb) || na - nb
}
