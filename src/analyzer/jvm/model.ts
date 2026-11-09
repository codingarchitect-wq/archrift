// What the JVM reader (docs/POLYGLOT.md, P3) keeps per file between its two
// passes: the declarations (pass A, from the file alone, cached by its hash)
// with just enough about types and values to resolve names across files in
// pass B. Everything is plain JSON so it can be cached.
import type { Range } from '../../core/model.ts'

/** A value as written, kept until names can be resolved: annotation arguments, constant initializers. */
export type Expr =
  | { s: string } // a string literal, escapes applied
  | { ref: string[] } // a name, or a.b.c
  | { cat: Expr[] } // `a + b`, or a string template's parts
  | { arr: Expr[] } // `[a, b]`, arrayOf(a, b)
  | { call: string[]; args: Expr[]; names?: string[] } // `f(a, b = c)`: kept for the plugins (topic lookups by channel, nested annotations); names: '' for a positional argument
  | { other: string } // anything else, as text

export interface Annotation {
  /** As written: `GetMapping`, or `org.x.GetMapping`. */
  name: string
  args: { name?: string; value: Expr }[]
  site: [number, number]
}

/** A type as written: `Map<String, Foo>` → { name: ['Map'], args: [{ name: ['String'] }, { name: ['Foo'] }] }. */
export interface TypeRef {
  name: string[]
  args?: TypeRef[]
}

export type TypeKind = 'class' | 'interface' | 'object' | 'enum' | 'annotation' | 'alias' | 'record'

export interface JvmDecl {
  id: string
  kind: 'symbol' | 'member'
  /** A member's own name; a nested type's `Outer.Inner`. */
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
  /** Types and top-level declarations: the package-qualified name. */
  fqn?: string
  /** Set on types. */
  type?: TypeKind
  /** A type's supertypes; `call` when written as a constructor call (a class, not an interface). */
  supers?: { type: TypeRef; call: boolean }[]
  /** A property's or parameter's declared type, a function's return type, an alias's target. */
  valueType?: TypeRef
  /** A property whose declared type is nullable (`String?`). */
  nullable?: boolean
  /** A property without a backing field (a getter and no initializer, or a delegate): nothing is stored. */
  computed?: boolean
  annotations?: Annotation[]
  /** A property with a constant initializer (`const val PATH = "/a"`). */
  init?: Expr
  /** A member declared in the companion object: reachable through the type's name. */
  companion?: boolean
  /** A member declared with `override`. */
  override?: boolean
  /** Types it refers to by full name (an Avro field's record and enum types). */
  uses?: string[]
}

export interface JvmImport {
  fqn: string
  alias?: string
  star: boolean
  line: number
  col: number
}

export interface JvmFile {
  path: string
  hash: string
  language: 'kotlin' | 'avro'
  pkg: string
  imports: JvmImport[]
  decls: JvmDecl[]
  loc: number
  complexity: number
  /** Regions tree-sitter couldn't parse (it recovers around them). */
  errors: number
}
