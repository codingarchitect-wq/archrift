// Reads the documents (config `docs`) and the ids the code cites, and matches
// them to the analyzed code (src/core/docs.ts) into the graph's `meta.docs`.
// Documents may lie outside the root (`../design-docs`): their paths start with
// `../`. In watch mode a document is parsed again only when it changed.
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DEFAULT_ID_PATTERN, citedIds, linkDocs, parseDoc } from '../core/docs.ts'
import type { Citation, ParsedDoc } from '../core/docs.ts'
import { globToRegExp } from '../core/glob.ts'
import { GraphIndex } from '../core/graph-index.ts'
import type { Graph } from '../core/model.ts'
import type { Config } from './config.ts'

const DOC_EXT = /\.(?:md|mdx|markdown|html?|txt|adoc|rst)$/i
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor'])
/** Documents in these folders are records: never kept current. */
const RECORDS = /(?:^|\/)(?:historical|archive|archived|old|deprecated|superseded)(?:\/|$)/i
const MAX_BYTES = 2_000_000
const MAX_DOCS = 5000

export interface DocsOptions {
  root: string
  config: Config
  /** A code file's text, by its path in the graph. */
  readCode: (rel: string) => string | undefined
  /** Watch mode's state between runs. */
  session?: Map<string, unknown>
}

/** Sets `graph.meta.docs` (when there are documents), with its counts and timing. */
export function readDocs(graph: Graph, options: DocsOptions): void {
  const t0 = performance.now()
  const { root, config } = options
  const files = docFiles(root, config.docs.include)
  if (!files.length) return
  const ids = idPattern(config.docs.ids)
  const docs = files.map(rel => parsed(root, rel, ids, options.session)).filter((d): d is ParsedDoc => !!d)
  const defined = new Set(docs.flatMap(d => d.definitions.map(x => x.id)))
  const citations = new Map<string, Map<string, Citation>>()
  if (ids && defined.size)
    for (const n of graph.nodes) {
      if (n.kind !== 'file' || n.tags?.includes('asset')) continue
      const text = options.readCode(n.path!)
      const cited = text === undefined ? undefined : citedIds(text, ids, id => defined.has(id))
      if (cited?.size) citations.set(n.path!, cited)
    }
  const current = currentDocs(config.docs.current ?? config.docs.include)
  graph.meta.docs = linkDocs({ graph, index: new GraphIndex(graph), docs, citations, current })
  graph.meta.counts.docs = graph.meta.docs.docs.length
  graph.meta.counts.docMentions = graph.meta.docs.docs.reduce((n, d) => n + d.mentions.length, 0)
  graph.meta.counts.decisionIds = graph.meta.docs.ids.length
  graph.meta.timings.docs = Math.round(performance.now() - t0)
}

function idPattern(ids: string | false | undefined): RegExp | undefined {
  if (ids === false) return undefined
  try {
    return new RegExp(ids ?? DEFAULT_ID_PATTERN)
  } catch (err) {
    throw new Error(`config docs.ids is no regular expression: ${(err as Error).message}`)
  }
}

/** The document files the entries name, relative to the root (`../` for those outside it), sorted. */
export function docFiles(root: string, include: readonly string[]): string[] {
  const found = new Set<string>()
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/')
  for (const entry of include) {
    const abs = path.resolve(root, entry)
    if (/[*?{]/.test(path.basename(entry))) {
      const test = globToRegExp(path.basename(entry))
      for (const name of list(path.dirname(abs))) if (DOC_EXT.test(name) && test.test(name)) found.add(rel(path.join(path.dirname(abs), name)))
      continue
    }
    const stat = statOf(abs)
    if (stat?.isDirectory()) walk(abs, f => found.add(rel(f)), found)
    else if (stat?.isFile() && DOC_EXT.test(abs)) found.add(rel(abs))
  }
  return [...found].sort()
}

function walk(dir: string, add: (file: string) => void, found: Set<string>) {
  for (const entry of listEntries(dir)) {
    if (found.size >= MAX_DOCS) return
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) walk(abs, add, found)
    else if (entry.isFile() && DOC_EXT.test(entry.name)) add(abs)
  }
}

const statOf = (abs: string) => {
  try {
    return fs.statSync(abs)
  } catch {
    return undefined
  }
}

const list = (dir: string) => listEntries(dir).map(e => e.name)

function listEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
  } catch {
    return []
  }
}

/** A document parsed, from watch mode's memory while its size and time stay the same. */
function parsed(root: string, rel: string, ids: RegExp | undefined, session?: Map<string, unknown>): ParsedDoc | undefined {
  const abs = path.resolve(root, rel)
  const stat = statOf(abs)
  if (!stat || stat.size > MAX_BYTES) return undefined
  let memo = session?.get('docs') as Map<string, { key: string; doc: ParsedDoc }> | undefined
  if (session && !memo) session.set('docs', (memo = new Map()))
  const key = `${stat.size}:${stat.mtimeMs}:${ids?.source ?? ''}`
  const hit = memo?.get(rel)
  if (hit?.key === key) return hit.doc
  const doc = parseDoc(rel, fs.readFileSync(abs, 'utf8'), ids)
  memo?.set(rel, { key, doc })
  return doc
}

/** Is a document kept current: under one of the entries (a path or a glob), and in no records folder? */
export function currentDocs(entries: readonly string[]): (doc: string) => boolean {
  const tests = entries.map(e => {
    const p = e.replace(/^\.\//, '').replace(/\/+$/, '')
    if (/[*?{]/.test(p)) {
      const re = globToRegExp(p)
      return (doc: string) => re.test(doc)
    }
    return (doc: string) => doc === p || doc.startsWith(`${p}/`)
  })
  return doc => !RECORDS.test(doc) && tests.some(t => t(doc))
}
