// Framework plugins: links that plain imports and references don't
// show. A plugin works in two places. During extraction (per file, cached)
// it can turn object literals into members, name kinds, reclassify a
// reference once its target is known, and record facts. During assembly
// (whole graph, uncached) it resolves those facts and adds nodes and edges.
import type ts from 'typescript'
import type { EdgeKind, GraphEdge, GraphMeta, GraphNode } from '../../core/model.ts'
import type { Config } from '../config.ts'
import type { FileFragment } from '../fragment.ts'

export interface Classification {
  subkind: string
  tags?: string[]
}

export interface ExtractApi {
  sf: ts.SourceFile
  /** The program's checker (constants, types); what it resolves into other files is already a dependency of this file's cache entry. */
  checker: ts.TypeChecker
  /** Id of the symbol or member (or file) that contains a node. */
  ownerOf(node: ts.Node): string
  /** Graph id of a declaration in any project file (undefined outside the project); its file becomes a cache dependency. */
  idOf(decl: ts.Node): string | undefined
  site(node: ts.Node): [number, number]
  /** Records a fact for `assemble`, under the plugin's name, or under a shared channel (`http`: requests and handlers from any language). */
  emit(fact: unknown, channel?: string): void
}

export interface AssembleApi {
  root: string
  config: Config
  targets: string[]
  fragments: FileFragment[]
  nodes: Map<string, GraphNode>
  /** Facts a plugin recorded, with the file they came from. */
  facts<T>(plugin: string): { file: string; fact: T }[]
  /** Add a file node (and its directories) for a path under the root. */
  addFile(path: string, tags: string[], metrics: Record<string, number>): string
  addNode(node: GraphNode): void
  addEdge(edge: Omit<GraphEdge, 'confidence'> & { confidence?: GraphEdge['confidence'] }, sites?: number[]): void
  /** The edges assembled so far (imports and references), for plugins that analyze the graph. */
  edges(): GraphEdge[]
  readText(path: string): string | undefined
  /** Every file of the project, graph paths (root and mounts, without the excluded ones), sorted. */
  files(): string[]
  /** What plugins add to the graph's meta: the databases' schemas (plugins/schemas.ts). */
  meta: Pick<GraphMeta, 'databases'>
}

export interface Plugin {
  name: string
  /** Bump when extraction output changes (part of the cache key). */
  version: number
  /** An object literal whose properties become members of the declaration it initializes (tRPC routers). */
  memberContainer?(init: ts.Expression): ts.ObjectLiteralExpression | undefined
  /** Kind of a top-level declaration (a React context, an Angular component), or undefined to keep the default. */
  symbolKind?(decl: ts.Node, name: string): Classification | undefined
  /** Kind of a member: of a class, or of a container above (a Dexie table, a tRPC procedure). */
  memberKind?(member: ts.Node, owner: ts.Node): Classification | undefined
  /** Reclassify a reference from `id` to `decl` (an rpc call, a table query, a context read). */
  refKind?(id: ts.Identifier, decl: ts.Node): { kind: EdgeKind; subkind?: string } | undefined
  /** Look at every node of a file; `emit` records facts for `assemble`. */
  visit?(node: ts.Node, api: ExtractApi): void
  assemble?(api: AssembleApi): void
}
