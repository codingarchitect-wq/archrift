// The graph contract between analyzers and the viewer. Everything
// here is plain data: no Node, no DOM, so both sides can import it.

import type { DocsMeta } from './docs.ts'
import type { RuleSummary, Violation } from './rules.ts'

export const SCHEMA_VERSION = 1

export type NodeKind = 'directory' | 'file' | 'symbol' | 'member' | 'external'

/** Symbol subkinds: function, component, hook, class, interface, type, enum, variable, namespace, default-export.
 *  Member subkinds: method, property, accessor, constructor. Plugins may add their own. */
export type Subkind = string

export type EdgeKind =
  | 'imports' // subkind static | type-only | side-effect | dynamic | require
  | 're-exports' // subkind static | type-only
  | 'calls'
  | 'instantiates'
  | 'references'
  | 'type-ref'
  | 'extends'
  | 'implements'
  | 'overrides'
  | 'renders'
  | 'spawns-worker'
  | 'mocks'
  // from plugins
  | 'rpc-call' // client → tRPC procedure; subkind = query | mutate | useQuery …
  | 'queries' // code → database model or table; subkind = read | write
  | 'provides' // component → React context it provides
  | 'consumes' // code → React context it reads
  | 'navigates' // code → the page an href or router.push leads to (inferred)
  | 'http-call' // client code → the endpoint handler serving the request (inferred); subkind = GET | POST …
  | 'publishes' // code → message topic it sends to
  | 'subscribes' // code → message topic it consumes
  // from git
  | 'co-changes' // file ↔ file changed in the same commits; undirected, count = commits, weight = confidence

export type Confidence = 'exact' | 'inferred'

/** [startLine, startCol, endLine, endCol], 1-based. */
export type Range = [number, number, number, number]

export interface GraphNode {
  id: string
  kind: NodeKind
  name: string
  subkind?: Subkind
  /** Containment parent (directory → file → symbol → member); externals have none. */
  parent?: string
  /** Repo-relative path of the file (or directory) the node lives in. */
  path?: string
  range?: Range
  exported?: boolean
  signature?: string
  tags?: string[]
  metrics?: Record<string, number>
}

export interface GraphEdge {
  source: string
  target: string
  kind: EdgeKind
  subkind?: string
  /** How many references this edge aggregates (per source, target, kind, subkind). */
  count: number
  /** Build targets the edge exists in (subset of meta.targets). */
  targets: string[]
  confidence: Confidence
  /** co-changes: how strongly the two files change together (0–1). */
  weight?: number
}

/** Where an edge's references are: [line, col, line, col, …] in the source node's file. */
export type Sites = number[]

export interface GraphMeta {
  name: string
  generatedAt: string
  tool: { name: string; version: string }
  analyzers: { language: string; version: string }[]
  targets: string[]
  /** Configured architecture layers, top to bottom; files carry `layer:<name>` tags. */
  layers?: string[]
  /** Configured groups; files carry `group:<name>` tags. */
  groups?: string[]
  /** Other folders analyzed with the root (config `mounts`): name → absolute folder; their files' paths start with the name. */
  mounts?: Record<string, string>
  /**
   * Functional features found from the pages and API routes (core/features.ts), most files first;
   * files carry `feature:<name>`, or `feature-shared` for common code many features use.
   */
  features?: { name: string; routes: string[]; files: number }[]
  /**
   * Coherence (docs/COHERENCE.md): the jobs files do in one of several ways, as far as some file does them;
   * files carry `paradigm:<concern>=<paradigm>`. Missing in a graph analyzed before coherence was measured.
   */
  concerns?: ConcernMeta[]
  /**
   * The databases whose schema the code declares (Prisma, Dexie, SQL migrations and scripts, JPA
   * entities, Mongo documents), with their tables, columns and keys (analyzer/plugins/schemas.ts).
   * Who reads or writes a table: the `queries` edges into its nodes. Missing in a graph analyzed
   * before schemas were read.
   */
  databases?: DatabaseMeta[]
  /**
   * The documents (config `docs`) and the code each names, and the decision ids the code cites and
   * the documents define (core/docs.ts). Missing when there are none, or in a graph analyzed before
   * documents were read.
   */
  docs?: DocsMeta
  counts: Record<string, number>
  timings: Record<string, number>
  /** File-level import cycles (strongly connected components), largest first. */
  cycles: string[][]
  /** Set on a snapshot: the commit it was analyzed at. */
  snapshot?: { sha: string; rev: string; time: number; subject: string }
  /** Git history summary, when the root is in a repository. */
  history?: { head: string; commits: number; authors: number; since: number; until: number; windowDays: number }
  /** The config's architecture rules, and which of them are broken where. */
  rules?: RuleSummary[]
  violations?: Violation[]
  diagnostics: {
    unresolvedImports: { file: string; spec: string; line: number }[]
    unresolvedIdentifiers: number
    danglingEdges: number
  }
  cache?: { hits: number; misses: number }
}

/** A job code does in one of several ways (dates, HTTP calls, test doubles …), per stack. */
export interface ConcernMeta {
  id: string
  label: string
  /** JS, Angular, JVM, Go, or the project's own. */
  stack: string
  /** The job, in a few words. */
  about: string
  /** A concern of test code; production code's otherwise. */
  tests?: boolean
  /** Its several ways are intended: why (the config's `coherence.accept`). */
  accepted?: string
  /** The ways some file uses, in the catalog's order. */
  paradigms: { id: string; label: string; legacy?: boolean }[]
}

/** Where a database's schema was read from. */
export type SchemaSource = 'prisma' | 'dexie' | 'sql' | 'jpa' | 'mongo'

/** A database the code declares a schema for: one per Prisma datasource, Dexie database, or service's SQL or Mongo database. */
export interface DatabaseMeta {
  /** Stable: the database node's id when there is one (`x:db:mysql:company`), else `db:<source>:<name>` (`db:prisma:db`, `db:dexie:ShopDB`). */
  id: string
  /** As the code names it: the Prisma datasource, the Dexie database, the service's database. */
  name: string
  /** postgres | mysql | mariadb | sqlite | sqlserver | oracle | h2 | mongodb | indexeddb, or sql when the dialect is unknown. */
  engine: string
  /** What its tables were read from, in that order of trust (a SQL migration's columns over a JPA entity's fields). */
  sources: SchemaSource[]
  /** The folder of the module (service) it belongs to, '' for the root; databases group by it. */
  module: string
  /** The graph node standing for the database itself (`x:db:…`), when there is one. */
  node?: string
  tables: TableMeta[]
}

export interface TableMeta {
  /** The physical name: the SQL table, the Mongo collection, the Dexie table (`@@map` or `@Table(name)` applied). */
  name: string
  kind: 'table' | 'view' | 'collection'
  /** The code's name for it when that differs: the Prisma model, the JPA entity class, the Dexie row type. */
  entity?: string
  /**
   * The graph nodes declaring it, the one a click selects first: the Prisma model, the Dexie table
   * member, the JPA or Mongo entity class, the CREATE TABLE symbol(s). Readers and writers are the
   * `queries` edges into any of them.
   */
  nodes: string[]
  /** In declaration order; the primary key's columns carry `pk`. */
  columns: ColumnMeta[]
  /** Foreign keys: these columns reference `to` in `table` (a TableMeta.name of the same database). */
  references: ForeignKeyMeta[]
  /** Indexes beyond the primary key, unique ones included. */
  indexes: IndexMeta[]
}

export interface ColumnMeta {
  name: string
  /** As declared: `String`, `Decimal?`, `VARCHAR(255)`, `Long`, `Account[]`. */
  type?: string
  pk?: boolean
  /** May be null: Prisma's `?`, SQL without NOT NULL, a Kotlin `?` type. */
  nullable?: boolean
  unique?: boolean
  /** The database fills it: autoincrement, `@default(uuid())`, Dexie's `++`. */
  generated?: boolean
  /** Not stored: a relation field the code navigates (Prisma `Transaction[]`, JPA `@OneToMany`); `target` names the table. */
  virtual?: boolean
  /** For a virtual column: the table (TableMeta.name) it leads to. */
  target?: string
  /** The line declaring it, in the file of the table's first node. */
  line?: number
}

export interface ForeignKeyMeta {
  columns: string[]
  table: string
  to: string[]
  name?: string
  /** CASCADE, SET NULL … as declared. */
  onDelete?: string
}

export interface IndexMeta {
  columns: string[]
  unique?: boolean
  name?: string
  /** One entry per element of an array value (Dexie's `*tags`). */
  multiEntry?: boolean
}

export interface Graph {
  meta: GraphMeta
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Parallel to edges; may be empty when sites weren't loaded. */
  sites: Sites[]
}

/** Edge kinds that express a dependency of source on target (everything but containment). */
export const DEPENDENCY_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'imports',
  're-exports',
  'calls',
  'instantiates',
  'references',
  'type-ref',
  'extends',
  'implements',
  'overrides',
  'renders',
  'spawns-worker',
  'mocks',
  'rpc-call',
  'queries',
  'provides',
  'consumes',
  'navigates',
  'http-call',
  'publishes',
  'subscribes',
])

/** Import-graph edges that exist at runtime (type-only imports are erased). */
export function isRuntimeImport(e: Pick<GraphEdge, 'kind' | 'subkind'>) {
  return (e.kind === 'imports' || e.kind === 're-exports' || e.kind === 'spawns-worker') && e.subkind !== 'type-only'
}
