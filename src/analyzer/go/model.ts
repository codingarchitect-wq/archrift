// What the Go reader (docs/POLYGLOT.md, P5) keeps per file between its two
// passes: the declarations (pass A, from the file alone, cached by its hash)
// with just enough about types and values to resolve names across files in
// pass B. Everything is plain JSON so it can be cached.
import type { Range } from '../../core/model.ts'

/**
 * A type as written. A named type keeps its package qualifier as written
 * (`kafka.Message` → { q: 'kafka', n: 'Message' }); it is resolved through
 * the imports of the file it was written in.
 */
export type GoType =
  | { n: string; q?: string; args?: GoType[] }
  | { ptr: GoType }
  | { slice: GoType } // slices and arrays
  | { map: GoType; key: GoType }
  | { chan: GoType }
  | { fn: GoType[] } // a function type: calling a value of it gives these results
  | { other: string } // struct{…}, interface{…}, constraints

/** A constant's value as written: string literals, names of other constants, concatenations. */
export type GoExpr = { s: string } | { ref: string; q?: string } | { cat: GoExpr[] }

export type GoTypeKind = 'struct' | 'interface' | 'type'

export interface GoDecl {
  id: string
  kind: 'symbol' | 'member'
  /** A member's own name; a method declared away from its type's file `Type.method`. */
  name: string
  subkind: string
  /** The file's id, or the owning type's. */
  parent: string
  range: Range
  exported: boolean
  signature?: string
  tags: string[]
  loc: number
  complexity: number
  /** Set on types. */
  type?: GoTypeKind
  /** `type A = B` (alias) and `type A B` (a defined type): B. */
  underlying?: GoType
  alias?: true
  /** Structs: the types of embedded fields; interfaces: embedded interfaces. */
  embeds?: GoType[]
  /** A field's, variable's or constant's declared (or evident: `var x = T{}`) type. */
  valueType?: GoType
  /** `var x = pkg.NewX(…)`: the function whose first result x holds. */
  initCall?: { n: string; q?: string }
  /** Functions and methods (interface methods too): their result types. */
  results?: GoType[]
  /** Functions and methods: one name per parameter ('' when unnamed). */
  params?: string[]
  /** Methods: the receiver's type name. */
  recv?: string
  /** Type parameters in scope of the declaration (a generic function's, a generic receiver's). */
  typeParams?: string[]
  /** Constants and variables with a string value. */
  init?: GoExpr
}

export interface GoImport {
  path: string
  /** As written: an alias, `_` or `.`. */
  name?: string
  line: number
  col: number
}

export interface GoFile {
  path: string
  hash: string
  /** The package clause's name. */
  pkg: string
  imports: GoImport[]
  decls: GoDecl[]
  loc: number
  complexity: number
  /** Regions tree-sitter couldn't parse (it recovers around them). */
  errors: number
}

/** A Go module: a folder with a go.mod. */
export interface GoModule {
  /** The folder ('' for the root). */
  dir: string
  /** Its module path (`module acme.cloud.image.resize`). */
  path: string
  /** Module paths its go.mod requires (for interface satisfaction across modules). */
  requires: string[]
}
