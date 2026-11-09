// What a language analyzer produces per source file, before the
// graph is assembled. Fragments are plain JSON so they can be cached.
import type { EdgeKind, Range } from '../core/model.ts'
import type { Config, Target } from './config.ts'
import type { Mount } from './mounts.ts'

export interface SymbolRecord {
  id: string
  kind: 'symbol' | 'member'
  name: string
  subkind: string
  parent: string
  range: Range
  exported: boolean
  signature?: string
  tags: string[]
  loc: number
  complexity: number
}

/** A reference from one node to another, aggregated per (source, target, kind). */
export interface RefRecord {
  source: string
  target: string
  kind: EdgeKind
  subkind?: string
  count: number
  /** [line, col, …], capped at maxSitesPerEdge. */
  sites: number[]
}

export type SpecifierKind =
  | 'static'
  | 'type-only'
  | 'side-effect'
  | 're-export'
  | 're-export-type'
  | 'dynamic'
  | 'require'
  | 'mock'
  | 'worker'

/** A module specifier as written, resolved again on every run (cheap, and file layout can change). */
export interface SpecifierRecord {
  spec: string
  kind: SpecifierKind
  line: number
  col: number
}

/** The cacheable, resolution-independent part of a file's analysis. */
export interface ExtractedFile {
  path: string
  hash: string
  loc: number
  complexity: number
  tags: string[]
  symbols: SymbolRecord[]
  refs: RefRecord[]
  specifiers: SpecifierRecord[]
  /** Other project files whose declarations this file's references resolved to → their hash then. */
  deps: Record<string, string>
  unresolvedIdentifiers: number
  /** Hash of how the specifiers resolved when this was extracted (set before caching). */
  resolution?: string
  /** Per plugin: facts found in this file, resolved when the graph is assembled. */
  facts?: Record<string, unknown[]>
}

export type ResolvedTarget =
  | { kind: 'file'; path: string } // project source file
  | { kind: 'asset'; path: string } // non-source file inside the root (css, json, …)
  | { kind: 'excluded'; path: string } // inside the root but excluded by config
  | { kind: 'external'; id: string } // npm package or node builtin
  | { kind: 'unresolved' }

export interface ImportRecord {
  spec: string
  kind: EdgeKind
  subkind?: string
  line: number
  col: number
  /** Per target name. */
  resolved: Record<string, ResolvedTarget>
}

export interface FileFragment extends ExtractedFile {
  language: string
  imports: ImportRecord[]
}

export interface AnalyzeContext {
  root: string
  config: Config
  /** Other folders analyzed with the root (mounts.ts). */
  mounts: Mount[]
  /** Graph path → absolute path, and back (mount-aware). */
  abs(rel: string): string
  rel(abs: string): string
  /** Every file under the root and the mounts the config includes and doesn't exclude, as graph paths (sorted, read once per run). */
  files(): string[]
  targets: Target[]
  cacheDir?: string
  log: (msg: string) => void
  timings: Record<string, number>
  cacheStats: { hits: number; misses: number }
  /** Per language analyzer: state kept between runs of a long-lived analysis (watch mode). */
  session?: Map<string, unknown>
}

export interface LanguageAnalyzer {
  id: string
  version: string
  /** Whether the project has files for it (ctx.files() lists them). */
  detect(ctx: AnalyzeContext): boolean
  analyze(ctx: AnalyzeContext): AsyncIterable<FileFragment>
}
