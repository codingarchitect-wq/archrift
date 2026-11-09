// Names and descriptions people (or their coding agents) write for the code:
// what a block, a folder, a file, a function or a feature is for, in a
// sentence. The analysis can't tell, so archrift keeps them beside the config
// (`.archrift/descriptions.json`, committed with it) and shows them in the
// viewer, in search and in `archrift query`; `archrift describe` lists what
// still needs words and writes them.
//
// Each entry remembers the surface of the code it was written for: a file's
// exports and routes, a function's signature. When that changes the entry is
// stale: still shown, with a note, until someone checks it. Folders, features
// and outside nodes never go stale. A file's content fingerprint lets a renamed
// or moved file keep its entry (`archrift describe sync`).
//
// Pure: no Node or DOM APIs, so the server, an exported page and the CLI share it.
import { GraphIndex } from './graph-index.ts'
import { shapeOf } from './first-look.ts'
import { DEPENDENCY_KINDS } from './model.ts'
import type { Graph, GraphNode } from './model.ts'

export const DESCRIPTIONS_SCHEMA = 'archrift/descriptions@1'

/** The key of the project's own description. */
export const PROJECT_KEY = 'project'

export interface DescriptionEntry {
  /** A short name a person would use ("Session check"), when the code's own name doesn't say it. */
  name?: string
  /** One or two sentences: what it is for. */
  summary: string
  /** The surface it was written for (`surfaceOf`); none for what never goes stale. */
  surface?: string
  /** A file's content when it was written (`contentFingerprint`), so a renamed or moved file keeps its entry. */
  content?: string
}

export interface DescriptionsFile {
  $schema?: string
  /** The project as a whole, in a few sentences. */
  project?: string
  /** By node id (`d:src/lib`, `f:src/lib/db.ts`, `s:src/lib/db.ts#prisma`, `x:db:…`) or feature (`feature:accounts`). */
  entries: Record<string, DescriptionEntry>
}

/** What the viewer, search and query show for a node. */
export interface Description {
  name?: string
  summary: string
  /** The code's surface changed since it was written. */
  stale?: true
  /** Written for the block of the files right in a folder that holds other blocks below it (`src` above `src/lib`): not the folder's name as a whole. */
  ownFiles?: true
}

export interface ResolvedDescriptions {
  project?: string
  entries: Record<string, Description>
  /** Keys whose node isn't in the graph any more: renamed, moved or deleted (`archrift describe sync` carries or drops them). */
  orphans: string[]
}

export const NO_DESCRIPTIONS: ResolvedDescriptions = { entries: {}, orphans: [] }

/** A descriptions file as read, its malformed entries named. Throws when it isn't one at all. */
export function parseDescriptions(raw: unknown): { file: DescriptionsFile; problems: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a descriptions file is a JSON object with "entries"')
  const r = raw as Record<string, unknown>
  const problems: string[] = []
  const entries: Record<string, DescriptionEntry> = {}
  const given = r.entries ?? {}
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('"entries" maps ids to { "name", "summary" }')
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    const v = value as Record<string, unknown> | null
    if (!v || typeof v !== 'object' || typeof v.summary !== 'string' || !v.summary.trim()) {
      problems.push(`${key}: needs a "summary"`)
      continue
    }
    entries[key] = {
      ...(typeof v.name === 'string' && v.name.trim() ? { name: v.name.trim() } : {}),
      summary: v.summary.trim(),
      ...(typeof v.surface === 'string' ? { surface: v.surface } : {}),
      ...(typeof v.content === 'string' ? { content: v.content } : {}),
    }
  }
  return { file: { $schema: DESCRIPTIONS_SCHEMA, ...(typeof r.project === 'string' && r.project.trim() ? { project: r.project.trim() } : {}), entries }, problems }
}

/** The file as written: keys sorted, so a change shows as a small diff. */
export function serializeDescriptions(file: DescriptionsFile): string {
  const entries = Object.fromEntries(Object.keys(file.entries).sort(cmp).map(k => [k, file.entries[k]]))
  return `${JSON.stringify({ $schema: DESCRIPTIONS_SCHEMA, ...(file.project ? { project: file.project } : {}), entries }, null, 2)}\n`
}

/**
 * What an entry's words depend on: a file's exported declarations (name, kind,
 * signature) and the routes it serves; a function's or member's kind and
 * signature. Undefined for folders, features and outside nodes: their entries
 * never go stale.
 */
export function surfaceOf(index: GraphIndex, id: string): string | undefined {
  const n = index.node(id)
  if (!n) return undefined
  if (n.kind === 'file') {
    const exported = (index.children.get(id) ?? [])
      .map(c => index.node(c)!)
      .filter(s => s.kind === 'symbol' && s.exported)
      .map(s => `${s.name}|${s.subkind ?? ''}|${s.signature ?? ''}`)
      .sort(cmp)
    const routes = (n.tags ?? []).filter(t => /^(route|api|layout|http):/.test(t)).sort(cmp)
    return hash([...exported, ...routes].join('\n'))
  }
  if (n.kind === 'symbol' || n.kind === 'member') return hash(`${n.subkind ?? ''}|${n.signature ?? ''}`)
  return undefined
}

/** Is the key a node or feature of this graph (or the project)? */
export function knownKey(graph: Graph, index: GraphIndex, key: string): boolean {
  if (key === PROJECT_KEY) return true
  if (key.startsWith('feature:')) return !!graph.meta.features?.some(f => `feature:${f.name}` === key)
  return index.byId.has(key)
}

/** The entries as the viewer shows them: stale where the surface moved on, orphans named. */
export function resolveDescriptions(graph: Graph, file: DescriptionsFile, index = new GraphIndex(graph)): ResolvedDescriptions {
  const entries: Record<string, Description> = {}
  const orphans: string[] = []
  const ownFiles = ownFilesBlocks(graph, file)
  for (const [key, e] of Object.entries(file.entries)) {
    if (!knownKey(graph, index, key)) {
      orphans.push(key)
      continue
    }
    const now = e.surface === undefined ? undefined : surfaceOf(index, key)
    entries[key] = {
      ...(e.name ? { name: e.name } : {}),
      summary: e.summary,
      ...(now !== undefined && now !== e.surface ? { stale: true as const } : {}),
      ...(ownFiles.has(key) ? { ownFiles: true as const } : {}),
    }
  }
  return { ...(file.project ? { project: file.project } : {}), entries, orphans: orphans.sort(cmp) }
}

/** The described blocks that are only the files right in their folder, other blocks lying below it (`d:src` above `d:src/lib`). */
function ownFilesBlocks(graph: Graph, file: DescriptionsFile): Set<string> {
  if (!Object.keys(file.entries).some(k => k.startsWith('d:'))) return new Set()
  return new Set(
    shapeOf(graph)
      .blocks.filter(b => b.match === `${b.path}/*.*`)
      .map(b => `d:${b.path}`),
  )
}

/** The entry with the surface (and, for a file, the content) it is written for now: what `describe set` and `apply` store. */
export function stamp(index: GraphIndex, key: string, entry: Pick<DescriptionEntry, 'name' | 'summary'>, content?: string): DescriptionEntry {
  const surface = surfaceOf(index, key)
  return { ...(entry.name ? { name: entry.name } : {}), summary: entry.summary, ...(surface !== undefined ? { surface } : {}), ...(content ? { content } : {}) }
}

/**
 * The key a command-line argument names: `project`, a feature (`feature:x`), a
 * node id (`d:`, `f:`, `s:`, `x:`), or a path: a file, else a folder (`.` or
 * `` for the root). Undefined when the graph has nothing by that name.
 */
export function keyFor(graph: Graph, index: GraphIndex, arg: string): string | undefined {
  const a = arg.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (a === PROJECT_KEY || /^(feature|[dfsx]):/.test(a)) return knownKey(graph, index, a) ? a : undefined
  if (index.byId.has(`f:${a}`)) return `f:${a}`
  const dir = a === '' || a === '.' ? 'd:.' : `d:${a}`
  return index.byId.has(dir) ? dir : undefined
}

// ── sync: entries follow their code ─────────────────────────────────────────

export interface SyncResult {
  file: DescriptionsFile
  /** Entries carried to the node their code moved to: [old key, new key]. */
  moved: [string, string][]
  /** Entries whose node is gone with no trace: deleted code (git keeps them). */
  dropped: string[]
  /** Entries written by hand, given their surface now. */
  stamped: string[]
}

/**
 * Carries each orphaned entry to where its code went, and drops the rest:
 * a file to the undescribed file with the same content (else the same name
 * and exports), a function to its file's new place (else the one undescribed
 * function of the same name and signature), a folder to the one undescribed
 * folder of the same name. Entries written by hand (no surface yet) are
 * stamped. `contentOf` fingerprints a file's text (`contentFingerprint`).
 */
export function syncDescriptions(graph: Graph, file: DescriptionsFile, contentOf: (path: string) => string | undefined, index = new GraphIndex(graph)): SyncResult {
  const entries = { ...file.entries }
  const moved: [string, string][] = []
  const dropped: string[] = []
  const stamped: string[] = []
  const free = (n: GraphNode) => !entries[n.id]
  const files = graph.nodes.filter(n => n.kind === 'file')
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
  const one = <T>(list: T[]) => (list.length === 1 ? list[0] : undefined)
  const contentCache = new Map<string, string | undefined>()
  const content = (path: string) => (contentCache.has(path) ? contentCache.get(path) : (contentCache.set(path, contentOf(path)), contentCache.get(path)))
  const move = (from: string, to: string) => {
    entries[to] = entries[from]
    delete entries[from]
    moved.push([from, to])
  }
  const orphans = Object.keys(entries).filter(k => !knownKey(graph, index, k)).sort(cmp)
  // files first: their functions follow them
  const fileMoves = new Map<string, string>()
  for (const key of orphans.filter(k => k.startsWith('f:'))) {
    const e = entries[key]
    const path = key.slice(2)
    const byContent = e.content ? one(files.filter(f => free(f) && content(f.path!) === e.content)) : undefined
    const byShape = byContent ?? (e.surface ? one(files.filter(f => free(f) && base(f.path!) === base(path) && surfaceOf(index, f.id) === e.surface)) : undefined)
    if (byShape) {
      move(key, byShape.id)
      fileMoves.set(path, byShape.path!)
    } else dropped.push(key)
  }
  for (const key of orphans.filter(k => k.startsWith('s:'))) {
    const e = entries[key]
    const [path, name] = [key.slice(2, key.indexOf('#')), key.slice(key.indexOf('#') + 1)]
    const followed = fileMoves.has(path) ? `s:${fileMoves.get(path)}#${name}` : undefined
    const target = followed && index.byId.has(followed) && !entries[followed] ? followed : e.surface ? one(graph.nodes.filter(n => (n.kind === 'symbol' || n.kind === 'member') && free(n) && n.id.endsWith(`#${name}`) && surfaceOf(index, n.id) === e.surface))?.id : undefined
    if (target) move(key, target)
    else dropped.push(key)
  }
  for (const key of orphans.filter(k => k.startsWith('d:'))) {
    const target = one(graph.nodes.filter(n => n.kind === 'directory' && free(n) && base(n.path ?? '') === base(key.slice(2))))
    if (target) move(key, target.id)
    else dropped.push(key)
  }
  for (const key of orphans.filter(k => !/^[fsd]:/.test(k))) dropped.push(key)
  for (const key of dropped) delete entries[key]
  // written by hand: the surface (and content) it describes is today's
  for (const [key, e] of Object.entries(entries)) {
    const surface = surfaceOf(index, key)
    const n = index.node(key)
    const fingerprint = n?.kind === 'file' && !e.content ? content(n.path!) : undefined
    if ((surface !== undefined && e.surface === undefined) || fingerprint) {
      entries[key] = { ...e, ...(surface !== undefined && e.surface === undefined ? { surface } : {}), ...(fingerprint ? { content: fingerprint } : {}) }
      stamped.push(key)
    }
  }
  return { file: { ...file, entries }, moved, dropped: dropped.sort(cmp), stamped: stamped.sort(cmp) }
}

// ── coverage and what to describe next ──────────────────────────────────────

export type Level = 'project' | 'block' | 'feature' | 'folder' | 'file'
export const LEVELS: Level[] = ['project', 'block', 'feature', 'folder', 'file']

/** Files the analysis reads as code (configuration, styles and assets are files too). */
const CODE = /\.(?:[cm]?[jt]sx?|kts?|go|vue|svelte)$/

export interface Describable {
  key: string
  level: Level
  /** A path, a feature's name, or the project's. */
  label: string
  /** Lines of code in it, for the order. */
  loc: number
  /** Production files using it (files) or its files (folders, features). */
  weight: number
}

/**
 * What a project's description covers, most worth describing first: the
 * project, its blocks (the folders its production code splits into), its
 * features, the other folders holding production code (largest first), then
 * its production code files (most used first). Tests stay out.
 */
export function describables(graph: Graph, index = new GraphIndex(graph)): Describable[] {
  const code = graph.nodes.filter(n => n.kind === 'file' && CODE.test(n.path ?? '') && !n.tags?.includes('test'))
  const out: Describable[] = [{ key: PROJECT_KEY, level: 'project', label: graph.meta.name, loc: 0, weight: 0 }]
  const blocks = shapeOf(graph).blocks
  const isBlock = new Set(blocks.map(b => `d:${b.path}`))
  for (const b of [...blocks].sort((a, b) => b.loc - a.loc || cmp(a.path, b.path))) out.push({ key: `d:${b.path}`, level: 'block', label: b.path, loc: b.loc, weight: b.files })
  for (const f of graph.meta.features ?? []) out.push({ key: `feature:${f.name}`, level: 'feature', label: f.name, loc: 0, weight: f.files })
  // the folders holding production code, at any depth; not the ones only holding blocks (`src` above `src/lib`)
  const container = new Set(blocks.flatMap(b => index.ancestors(`d:${b.path}`).map(a => a.id)))
  const folders = new Map<string, { loc: number; files: number }>()
  for (const f of code)
    for (const d of index.ancestors(f.id)) {
      if (d.kind !== 'directory' || d.id === 'd:.' || isBlock.has(d.id) || container.has(d.id)) continue
      const c = folders.get(d.id) ?? { loc: 0, files: 0 }
      c.loc += f.metrics?.loc ?? 0
      c.files++
      folders.set(d.id, c)
    }
  for (const [key, c] of [...folders].sort((a, b) => b[1].loc - a[1].loc || cmp(a[0], b[0]))) out.push({ key, level: 'folder', label: key.slice(2), loc: c.loc, weight: c.files })
  for (const f of [...code].sort((a, b) => (b.metrics?.fanIn ?? 0) - (a.metrics?.fanIn ?? 0) || (b.metrics?.loc ?? 0) - (a.metrics?.loc ?? 0) || cmp(a.id, b.id)))
    out.push({ key: f.id, level: 'file', label: f.path!, loc: f.metrics?.loc ?? 0, weight: f.metrics?.fanIn ?? 0 })
  return out
}

export interface Coverage {
  level: Level
  described: number
  total: number
  stale: number
}

export function coverageOf(items: readonly Describable[], resolved: ResolvedDescriptions): Coverage[] {
  return LEVELS.map(level => {
    const here = items.filter(i => i.level === level)
    const has = (i: Describable) => (i.key === PROJECT_KEY ? !!resolved.project : !!resolved.entries[i.key])
    return { level, described: here.filter(has).length, total: here.length, stale: here.filter(i => resolved.entries[i.key]?.stale).length }
  }).filter(c => c.total > 0)
}

export interface TodoItem extends Describable {
  /** missing: not described yet; stale: its code's surface changed since. */
  why: 'missing' | 'stale'
  /** The entry to check, for a stale one. */
  current?: Description
  digest: Digest
}

/** Enough about a node to describe most of them without opening them. */
export interface Digest {
  kind: string
  path?: string
  lines?: number
  /** Files (folders, features). */
  files?: number
  /** The routes it serves (pages, API handlers) or a feature's. */
  routes?: string[]
  /** A file's exported declarations: name, kind and signature (shortened). */
  exports?: { name: string; kind: string; signature?: string }[]
  /** Its biggest files or subfolders, with their descriptions where they have one. */
  contents?: { path: string; lines: number; described?: string }[]
  /** Files it uses and files using it (production code), most references first, with their total count. */
  uses?: { path: string; described?: string }[]
  usesCount?: number
  usedBy?: { path: string; described?: string }[]
  usedByCount?: number
}

const DIGEST_ROWS = 8
const SIGNATURE_CHARS = 160

/** The next things to describe under `scope` (a folder; all when empty): stale entries first at each level, then the missing ones, at most `max`. */
export function todo(graph: Graph, resolved: ResolvedDescriptions, options: { scope?: string; max?: number } = {}, index = new GraphIndex(graph)): { items: TodoItem[]; total: number } {
  const scope = (options.scope ?? '').replace(/^\.\/?/, '').replace(/\/+$/, '')
  const inScope = (i: Describable) => !scope || (i.level !== 'project' && i.level !== 'feature' && (i.label === scope || i.label.startsWith(`${scope}/`)))
  const open: TodoItem[] = []
  const all = describables(graph, index).filter(inScope)
  for (const level of LEVELS) {
    const here = all.filter(i => i.level === level)
    const why = (i: Describable): TodoItem['why'] | undefined =>
      i.key === PROJECT_KEY ? (resolved.project ? undefined : 'missing') : !resolved.entries[i.key] ? 'missing' : resolved.entries[i.key].stale ? 'stale' : undefined
    for (const want of ['stale', 'missing'] as const)
      for (const i of here) if (why(i) === want) open.push({ ...i, why: want, ...(want === 'stale' ? { current: resolved.entries[i.key] } : {}), digest: undefined as unknown as Digest })
  }
  const items = open.slice(0, options.max ?? 40).map(i => ({ ...i, digest: digestOf(graph, index, resolved, i) }))
  return { items, total: open.length }
}

function digestOf(graph: Graph, index: GraphIndex, resolved: ResolvedDescriptions, item: Describable): Digest {
  const said = (id: string) => {
    const d = resolved.entries[id]
    return d ? (d.name ? `${d.name}: ${d.summary}` : d.summary) : undefined
  }
  const withSaid = (path: string, id: string) => (said(id) ? { path, described: said(id) } : { path })
  if (item.level === 'project') {
    const blocks = shapeOf(graph).blocks
    return { kind: 'project', files: graph.nodes.filter(n => n.kind === 'file' && !n.tags?.includes('test')).length, contents: blocks.slice(0, DIGEST_ROWS * 2).map(b => ({ path: b.path, lines: b.loc, ...(said(`d:${b.path}`) ? { described: said(`d:${b.path}`) } : {}) })) }
  }
  if (item.level === 'feature') {
    const name = item.key.slice('feature:'.length)
    const f = graph.meta.features?.find(x => x.name === name)
    const files = graph.nodes.filter(n => n.kind === 'file' && n.tags?.includes(`feature:${name}`)).sort((a, b) => (b.metrics?.loc ?? 0) - (a.metrics?.loc ?? 0))
    return { kind: 'feature', files: f?.files, routes: f?.routes, contents: files.slice(0, DIGEST_ROWS).map(n => ({ path: n.path!, lines: n.metrics?.loc ?? 0, ...(said(n.id) ? { described: said(n.id) } : {}) })) }
  }
  const n = index.node(item.key)!
  if (n.kind === 'directory') {
    const kids = (index.children.get(n.id) ?? []).map(id => index.node(id)!).filter(k => (k.kind === 'directory' || k.kind === 'file') && !k.tags?.includes('test'))
    kids.sort((a, b) => (b.metrics?.loc ?? 0) - (a.metrics?.loc ?? 0) || cmp(a.id, b.id))
    return {
      kind: item.level,
      path: n.path,
      lines: n.metrics?.loc,
      files: n.metrics?.files,
      contents: kids.slice(0, DIGEST_ROWS * 2).map(k => ({ path: k.kind === 'directory' ? `${k.path}/` : k.path!, lines: k.metrics?.loc ?? 0, ...(said(k.id) ? { described: said(k.id) } : {}) })),
    }
  }
  const exports = (index.children.get(n.id) ?? [])
    .map(id => index.node(id)!)
    .filter(s => s.kind === 'symbol' && s.exported)
    .sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0))
    .map(s => ({ name: s.name, kind: s.subkind ?? 'symbol', ...(s.signature ? { signature: s.signature.length > SIGNATURE_CHARS ? `${s.signature.slice(0, SIGNATURE_CHARS)}…` : s.signature } : {}) }))
  const { uses, usedBy } = fileNeighbors(index, n.id)
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, DIGEST_ROWS).map(([id]) => withSaid(index.node(id)?.path ?? id.replace(/^x:(npm|node):/, ''), id))
  const routes = (n.tags ?? []).filter(t => /^(route|api|http):/.test(t))
  return {
    kind: 'file',
    path: n.path,
    lines: n.metrics?.loc,
    ...(routes.length ? { routes } : {}),
    exports,
    uses: top(uses),
    usesCount: uses.size,
    usedBy: top(usedBy),
    usedByCount: usedBy.size,
  }
}

/** The files (and packages) a file's code depends on and the production files depending on it, by references. */
export function fileNeighbors(index: GraphIndex, fileId: string): { uses: Map<string, number>; usedBy: Map<string, number> } {
  const uses = new Map<string, number>()
  const usedBy = new Map<string, number>()
  const own = [fileId, ...index.descendants(fileId).map(d => d.id)]
  const lift = (id: string) => {
    const n = index.node(id)
    return n?.kind === 'external' ? n : index.fileOf(id)
  }
  for (const id of own) {
    for (const e of index.out(id)) {
      if (!DEPENDENCY_KINDS.has(e.kind)) continue
      const t = lift(e.target)
      if (t && t.id !== fileId) uses.set(t.id, (uses.get(t.id) ?? 0) + e.count)
    }
    for (const e of index.in(id)) {
      if (!DEPENDENCY_KINDS.has(e.kind)) continue
      const s = index.fileOf(e.source)
      if (s && s.id !== fileId && !s.tags?.includes('test')) usedBy.set(s.id, (usedBy.get(s.id) ?? 0) + e.count)
    }
  }
  return { uses, usedBy }
}

/** A short, stable fingerprint (two 32-bit FNV-1a passes): enough to notice a change, not a security hash. */
export function hash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
