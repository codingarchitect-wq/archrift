// Reading type declarations from their signatures (the declaration's text
// without its body, as the analyzers store it): what a symbol declares
// (class, abstract class, interface, type alias, enum), the supertypes it
// names (TypeScript `extends`/`implements`, Kotlin's list after `:`, Go's
// `struct`/`interface`), and what a member's signature says about it (static,
// visibility, a collection type). The class diagrams use it where the graph
// has no edge: a base type outside the project (`extends Error`) has no node.
// Pure and language-tolerant: a signature it can't read gives nothing.
import type { TypeBox, TypeMember } from './classes.ts'

export type DeclKind = TypeBox['kind']

/** Words before the declaring keyword that don't change what is declared. */
const MODIFIER = /^(?:export|default|declare|const|public|private|protected|internal|open|sealed|data|final|inner|value|static|partial|readonly|expect|actual)\s+/
const ANNOTATION = /^@[\w.]+(?:\([^)]*\))?\s*/
const KEYWORD = /^(abstract\s+)?(enum\s+class|annotation\s+class|fun\s+interface|class|object|record|interface|enum|typealias|type)\b/

/** What a declaration's signature says it declares, or undefined when it declares no type. */
export function declKindOf(signature: string | undefined): DeclKind | undefined {
  if (!signature) return undefined
  const rest = stripPrefix(signature)
  const m = KEYWORD.exec(rest)
  if (!m) return undefined
  return kindOfKeyword(m[2], !!m[1] || /\babstract\b/.test(signature.slice(0, signature.length - rest.length)), rest.slice(m[0].length))
}

function kindOfKeyword(keyword: string, abstract: boolean, after: string): DeclKind | undefined {
  if (keyword.startsWith('annotation')) return undefined
  if (keyword.startsWith('enum')) return 'enum'
  if (keyword.endsWith('interface')) return 'interface'
  if (keyword === 'type' || keyword === 'typealias') return goTypeKind(after) ?? 'type'
  return abstract ? 'abstract' : 'class'
}

/** Go declares its structs and interfaces with `type`: `type Store struct`, `type Repo interface`. */
function goTypeKind(after: string): DeclKind | undefined {
  const m = /^\s*\w+(?:\[[^\]]*\])?\s+(struct|interface)\b/.exec(after)
  return m ? (m[1] === 'struct' ? 'class' : 'interface') : undefined
}

function stripPrefix(signature: string): string {
  let rest = signature.trim()
  for (let guard = 0; guard < 20; guard++) {
    const m = ANNOTATION.exec(rest) ?? MODIFIER.exec(rest)
    if (!m) break
    rest = rest.slice(m[0].length)
  }
  return rest
}

/** A supertype a declaration names. */
export interface Heritage {
  /** As written, without type arguments or constructor arguments (`React.Component`, `JpaRepository`). */
  name: string
  relation: 'extends' | 'implements'
}

/** Type operators that wrap a supertype rather than being one (`extends Omit<Props, 'x'>`): the edge goes to what they wrap. */
const WRAPPERS = new Set(['Omit', 'Pick', 'Partial', 'Required', 'Readonly', 'Record', 'NonNullable', 'Exclude', 'Extract', 'ReturnType', 'Parameters', 'InstanceType', 'Awaited'])

/** The supertypes a type's signature names, in order. */
export function heritageOf(signature: string | undefined): Heritage[] {
  const kind = declKindOf(signature)
  if (!signature || !kind || kind === 'type' || kind === 'enum') return []
  const rest = stripPrefix(signature).replace(KEYWORD, '')
  const tail = afterName(rest)
  if (tail.startsWith(':')) return kotlinSupertypes(tail.slice(1), kind)
  return typescriptHeritage(tail)
}

/** What follows the declared name, its type parameters and (Kotlin) primary constructor. */
function afterName(rest: string): string {
  let s = rest.replace(/^\s*[\w$]+/, '')
  for (const open of ['<', '(']) {
    s = s.trimStart()
    if (s.startsWith(open)) s = s.slice(closingOf(s, 0) + 1)
  }
  return s.trim()
}

/** The index of the bracket closing the one at `at` (the string's end when it's cut short). */
function closingOf(s: string, at: number): number {
  let depth = 0
  for (let i = at; i < s.length; i++) {
    if ('<([{'.includes(s[i])) depth++
    else if ('>)]}'.includes(s[i]) && s[i - 1] !== '=') depth--
    if (depth === 0) return i
  }
  return s.length
}

/** `extends A, B` and `implements C`, at the top level (a type parameter's `extends` sits inside brackets). */
function typescriptHeritage(tail: string): Heritage[] {
  const out: Heritage[] = []
  const clauses = topLevel(tail).split(/\b(extends|implements)\b/)
  for (let i = 1; i < clauses.length; i += 2) {
    const relation = clauses[i] === 'implements' ? 'implements' : 'extends'
    for (const entry of splitTop(tail.slice(...spanOf(tail, clauses, i)))) push(out, entry, relation)
  }
  return out
}

/** Where the text of clause i+1 lies in the original (the masked copy keeps positions). */
function spanOf(tail: string, clauses: string[], i: number): [number, number] {
  let start = 0
  for (let k = 0; k <= i; k++) start += clauses[k].length
  return [start, Math.min(tail.length, start + clauses[i + 1].length)]
}

function kotlinSupertypes(list: string, kind: DeclKind): Heritage[] {
  const out: Heritage[] = []
  for (const entry of splitTop(list.replace(/\s+by\s+.*$/, ''))) {
    // a class's superclass is called (`Base()`); the rest of the list are interfaces
    const called = /\(/.test(entry)
    push(out, entry, kind === 'interface' || called ? 'extends' : 'implements')
  }
  return out
}

function push(out: Heritage[], entry: string, relation: Heritage['relation']) {
  const name = entry.replace(/[<(].*$/s, '').replace(/[{].*$/s, '').trim()
  if (!/^[A-Za-z_$][\w$.]*$/.test(name) || WRAPPERS.has(name)) return
  out.push({ name, relation })
}

/** The text with everything inside brackets blanked out, so keywords and commas inside type arguments don't count. */
function topLevel(s: string): string {
  let depth = 0
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if ('<([{'.includes(c)) depth++
    const inside = depth > 0
    if ('>)]}'.includes(c) && s[i - 1] !== '=') depth = Math.max(0, depth - 1)
    out += inside ? ' ' : c
  }
  return out
}

/** Comma-separated entries at the top level. */
function splitTop(s: string): string[] {
  const masked = topLevel(s)
  const out: string[] = []
  let from = 0
  for (let i = 0; i <= masked.length; i++) {
    if (i < masked.length && masked[i] !== ',') continue
    const entry = s.slice(from, i).trim()
    if (entry) out.push(entry)
    from = i + 1
  }
  return out
}

// ── members ─────────────────────────────────────────────────────────────────

/** Visibility as a member's signature declares it (Kotlin's `internal` and TypeScript's default say nothing). */
export function visibilityOf(signature: string | undefined, name: string): TypeMember['visibility'] {
  if (name.startsWith('#')) return 'private'
  const m = /(?:^|\s)(private|protected|public)\s/.exec(beforeName(signature, name))
  return m ? (m[1] as TypeMember['visibility']) : undefined
}

/** A static member: `static` in its signature (a Kotlin companion's members carry the tag). */
export function isStatic(signature: string | undefined, name: string, tags: readonly string[] | undefined): boolean {
  return /(?:^|\s)static\s/.test(beforeName(signature, name)) || !!tags?.includes('static')
}

/** The signature up to the member's name (where modifiers are). */
function beforeName(signature: string | undefined, name: string): string {
  if (!signature) return ''
  const at = signature.search(new RegExp(`(?:^|[\\s.])${escape(name)}\\b`))
  return at < 0 ? signature : signature.slice(0, at + 1)
}

const COLLECTION = /\[\]|\b(?:Array|ReadonlyArray|List|MutableList|ArrayList|Set|MutableSet|ReadonlySet|HashSet|Collection|Iterable|Sequence|Map|ReadonlyMap|MutableMap|HashMap|Record)\s*</

/** A property typed as a collection: an array, a list, a set or a map. */
export function isCollection(signature: string | undefined, name: string): boolean {
  if (!signature) return false
  const at = signature.indexOf(name)
  return COLLECTION.test(at < 0 ? signature : signature.slice(at + name.length))
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
