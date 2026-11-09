// What a change's imports bring in (`archrift diff`, docs/QUERY.md): what each
// entry point loads at runtime, before and after, per build target. One new
// import line can bring dozens of files and a package into every page, and
// the line diff shows the line. Each file an entry point reaches now and
// didn't before is pinned on the import that brought it in: walking back from
// the file along its way from the entry point, the first import the base
// didn't have. There is one (else the base would have reached the file), and
// the nearest is the line to look at: a page importing a new file whose own
// import brings in a module tree is that import's doing, for every page it
// reaches. Files the change touched are in its line diff and aren't counted;
// a package counts when the target's entry points didn't load it at all. The
// same walk the other way round finds the imports that are gone and what they
// took with them. Pure.
import { reach } from './algorithms.ts'
import { isRuntimeImport } from './model.ts'
import type { Graph } from './model.ts'

export interface ReachChange {
  /** The import (file paths; a package by name). */
  from: string
  to: string
  /** Project files entry points reach now that they didn't (or the other way round, for a gone import), untouched by the change. */
  files: string[]
  /** Packages (npm, `node:` builtins) the target loads now and didn't load at all before (or no longer loads). */
  packages: string[]
  /** Entry points that reach them now (or did). */
  entries: string[]
  targets: string[]
}

export interface ReachDiff {
  /** New imports bringing files or packages in, the most first. */
  added: ReachChange[]
  /** Imports that are gone, with what entry points no longer load. */
  removed: ReachChange[]
}

/** Fewer files than this, brought in by one import, and no new package: an ordinary change, left out. */
export const MIN_FILES = 5

type Adjacency = Map<string, string[]>
type Reached = ReturnType<typeof reach>

interface Cause {
  files: Set<string>
  packages: Set<string>
  entries: Set<string>
  targets: Set<string>
}

/** What a change's imports bring into the entry points, and what the imports it removes take out. */
export function reachDiff(base: Graph, head: Graph, touched?: readonly string[], minFiles = MIN_FILES): ReachDiff {
  const skip = new Set((touched ?? []).map(p => `f:${p}`))
  return { added: consequences(base, head, skip, minFiles), removed: consequences(head, base, skip, minFiles) }
}

/** The imports `after` has and `before` hasn't, with what they bring into entry points both have. */
function consequences(before: Graph, after: Graph, skip: ReadonlySet<string>, minFiles: number): ReachChange[] {
  const existed = new Set(before.nodes.map(n => n.id))
  const entries = entryPoints(after).filter(id => existed.has(id))
  const entriesBefore = entryPoints(before)
  const causes = new Map<string, Cause>()
  for (const target of after.meta.targets) {
    const [was, now] = [runtimeImports(before, target), runtimeImports(after, target)]
    const side = { was, now, wasImports: importKeys(was), loadedBefore: new Set(reach(was, entriesBefore).keys()) }
    for (const entry of entries) pinNewlyReached(entry, target, side, skip, causes)
  }
  return [...causes]
    .map(([key, c]) => change(key, c))
    .filter(c => c.packages.length || c.files.length >= minFiles)
    .sort((a, b) => b.files.length - a.files.length || b.packages.length - a.packages.length || cmp(a.from, b.from) || cmp(a.to, b.to))
}

/** One target's imports before and after, and what its entry points loaded before. */
interface Side {
  was: Adjacency
  now: Adjacency
  /** `was`'s imports as `from\0to`. */
  wasImports: ReadonlySet<string>
  loadedBefore: ReadonlySet<string>
}

/** Pins each node `entry` reaches now and didn't before on the import that brought it in. */
function pinNewlyReached(entry: string, target: string, side: Side, skip: ReadonlySet<string>, causes: Map<string, Cause>) {
  const before = reach(side.was, [entry])
  const after = reach(side.now, [entry])
  for (const [id] of after) {
    if (before.has(id)) continue
    const pkg = isPackage(id)
    if (pkg ? side.loadedBefore.has(id) : skip.has(id)) continue // a package loaded elsewhere already, a file the change touched
    const cause = causeOf(id, after, side.wasImports)
    const c = causes.get(cause) ?? causes.set(cause, { files: new Set(), packages: new Set(), entries: new Set(), targets: new Set() }).get(cause)!
    ;(pkg ? c.packages : c.files).add(id)
    c.entries.add(entry)
    c.targets.add(target)
  }
}

/** The first import on `id`'s way back to the entry point that the base didn't have, as `from\0to`. */
function causeOf(id: string, after: Reached, wasImports: ReadonlySet<string>): string {
  let node = id
  let via = after.get(node)!.via!
  while (wasImports.has(`${via}\0${node}`)) {
    node = via
    via = after.get(node)!.via!
  }
  return `${via}\0${node}`
}

const importKeys = (adjacency: Adjacency) => new Set([...adjacency].flatMap(([from, tos]) => tos.map(to => `${from}\0${to}`)))

/** Production files the config names as entry points (pages, routes, workers, scripts …). */
const entryPoints = (graph: Graph) => graph.nodes.filter(n => n.kind === 'file' && n.tags?.includes('entrypoint') && !n.tags.includes('test')).map(n => n.id)

/** Runtime imports between files and packages in one build target, each list sorted. */
function runtimeImports(graph: Graph, target: string): Adjacency {
  const level = new Set(graph.nodes.filter(n => n.kind === 'file' || n.kind === 'external').map(n => n.id))
  const out: Adjacency = new Map()
  for (const e of graph.edges) {
    if (!isRuntimeImport(e) || !e.targets.includes(target) || e.source === e.target || !level.has(e.source) || !level.has(e.target)) continue
    const list = out.get(e.source) ?? out.set(e.source, []).get(e.source)!
    if (!list.includes(e.target)) list.push(e.target)
  }
  for (const list of out.values()) list.sort(cmp)
  return out
}

function change(key: string, c: Cause): ReachChange {
  const [from, to] = key.split('\0')
  return {
    from: label(from),
    to: label(to),
    files: [...c.files].map(label).sort(cmp),
    packages: [...c.packages].map(label).sort(cmp),
    entries: [...c.entries].map(label).sort(cmp),
    targets: [...c.targets].sort(cmp),
  }
}

const isPackage = (id: string) => id.startsWith('x:npm:') || id.startsWith('x:node:')

/** A path for a file (an excluded one too), a name for a package (`node:fs` for a builtin). */
const label = (id: string) => id.replace(/^f:|^x:excluded:|^x:npm:/, '').replace(/^x:node:/, 'node:')

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
