// Coherence, part 1 (docs/COHERENCE.md): which way each file does each job.
// A file uses a paradigm when it imports one of its packages or prefixes (the
// specifier as written, or the project file it resolves to) or, for a text
// paradigm, when its text matches. Files get `paradigm:<concern>=<paradigm>`
// tags, and the graph's meta the concerns found (core/coherence.ts measures
// them). Test concerns look at test files only, the others at production code.
import { PARADIGM_TAG } from '../../core/coherence.ts'
import { globToRegExp } from '../../core/glob.ts'
import type { ConcernMeta, GraphNode } from '../../core/model.ts'
import type { Config } from '../config.ts'
import type { FileFragment } from '../fragment.ts'
import { CATALOG } from './catalog.ts'
import type { ConcernRule, ParadigmRule } from './catalog.ts'
import { hideSpans, isScript, literalSpans } from '../ts/lexical.ts'

/** The catalog with a project's own concerns: a concern with a catalog id adds paradigms to it (or imports and patterns to one of its own). */
export function concernsOf(config: Config): ConcernRule[] {
  const own = (config.coherence?.concerns ?? []).map(fromConfig)
  const merged = CATALOG.map(c => ({ ...c, paradigms: [...c.paradigms] }))
  for (const c of own) {
    const known = merged.find(x => x.id === c.id)
    if (!known) {
      merged.push(c)
      continue
    }
    for (const p of c.paradigms) {
      const at = known.paradigms.findIndex(x => x.id === p.id)
      if (at < 0) known.paradigms.push(p)
      else {
        const was = known.paradigms[at]
        known.paradigms[at] = { ...was, imports: [...(was.imports ?? []), ...(p.imports ?? [])], ...(p.text && !was.text ? { text: p.text, files: p.files, strings: p.strings } : {}) }
      }
    }
  }
  return merged
}

type ConfigConcern = NonNullable<Config['coherence']>['concerns'][number]

function fromConfig(c: ConfigConcern): ConcernRule {
  return {
    id: c.id,
    label: c.label ?? c.id,
    stack: c.stack ?? 'project',
    about: c.about ?? '',
    ...(c.tests ? { tests: true } : {}),
    paradigms: c.paradigms.map(paradigmFromConfig),
  }
}

function paradigmFromConfig(p: ConfigConcern['paradigms'][number]): ParadigmRule {
  return {
    id: p.id,
    label: p.label ?? p.id,
    ...(p.legacy ? { legacy: true } : {}),
    ...(p.imports ? { imports: p.imports.map(asPattern) } : {}),
    ...(p.text ? { text: new RegExp(p.text, 'm') } : {}),
    ...(p.strings ? { strings: true } : {}),
    ...(p.files ? { files: p.files } : {}),
  }
}

/** `/…/` in a config is a regular expression, anything else a package or prefix. */
const asPattern = (s: string): string | RegExp => (s.length > 2 && s.startsWith('/') && s.endsWith('/') ? new RegExp(s.slice(1, -1)) : s)

/** An import matches a package or prefix: the name itself, or it followed by `/` or `.`. */
export function importMatches(pattern: string | RegExp, spec: string): boolean {
  if (typeof pattern !== 'string') return pattern.test(spec)
  return spec === pattern || (spec.startsWith(pattern) && (spec[pattern.length] === '/' || spec[pattern.length] === '.'))
}

export interface ParadigmInput {
  /** The graph's file nodes (tags `test` set). */
  files: GraphNode[]
  fragments: readonly FileFragment[]
  config: Config
  readText: (path: string) => string | undefined
}

/** Tags each file with the paradigms it uses; returns the concerns some file uses, with what the config accepts. */
export function tagParadigms(input: ParadigmInput): ConcernMeta[] {
  const concerns = concernsOf(input.config)
  const accepted = input.config.coherence?.accept ?? {}
  // what each file imports: specifiers as written, and the project files they resolve to
  const imports = new Map<string, string[]>()
  for (const f of input.fragments) {
    const list: string[] = []
    for (const imp of f.imports) {
      list.push(imp.spec)
      for (const r of Object.values(imp.resolved)) if (r.kind === 'file' || r.kind === 'asset') list.push(r.path)
    }
    imports.set(f.path, list)
  }
  const globs = new Map<string, RegExp[]>()
  const matchesGlob = (list: string[], path: string) => {
    const key = list.join('\0')
    let res = globs.get(key)
    if (!res) globs.set(key, (res = list.map(globToRegExp)))
    return res.some(r => r.test(path))
  }
  const used = new Map<string, Set<string>>() // concern → paradigms some file uses
  for (const file of input.files) {
    if (file.tags?.includes('declaration') || !file.path) continue
    const isTest = file.tags?.includes('test') ?? false
    const specs = imports.get(file.path) ?? []
    const textOf = textViews(file.path, () => input.readText(file.path!)) // read once, when a text rule needs it
    const tags: string[] = []
    for (const c of concerns) {
      if (!!c.tests !== isTest) continue
      if (c.scope && !(c.scope.imports?.some(p => specs.some(s => importMatches(p, s))) || (c.scope.files && matchesGlob(c.scope.files, file.path)))) continue
      for (const p of c.paradigms) {
        if (!uses(p, file.path, specs, textOf, matchesGlob)) continue
        tags.push(`${PARADIGM_TAG}${c.id}=${p.id}`)
        const set = used.get(c.id) ?? new Set<string>()
        used.set(c.id, set.add(p.id))
      }
    }
    if (tags.length) (file.tags ??= []).push(...tags)
  }
  return concerns
    .filter(c => used.has(c.id))
    .map(c => ({
      id: c.id,
      label: c.label,
      stack: c.stack,
      about: c.about,
      ...(c.tests ? { tests: true } : {}),
      ...(accepted[c.id] ? { accepted: accepted[c.id] } : {}),
      paradigms: c.paradigms.filter(p => used.get(c.id)!.has(p.id)).map(p => ({ id: p.id, label: p.label, ...(p.legacy ? { legacy: true } : {}) })),
    }))
}

/** How a text pattern sees a file: all of it; a script's code alone (no comments, strings, regular expressions); or its code and strings. */
type TextView = 'all' | 'code' | 'strings'

/** A file's text in each view, read and scanned at most once. */
function textViews(path: string, read: () => string | undefined): (view: TextView) => string | undefined {
  let all: string | undefined | null = null
  let script: ((view: Exclude<TextView, 'all'>) => string) | undefined
  return view => {
    if (all === null) all = read()
    if (all === undefined || view === 'all' || !isScript(path)) return all
    script ??= scriptViews(all, path)
    return script(view)
  }
}

/** A script's code alone, or its code and strings: comments and regular expressions never. */
function scriptViews(text: string, path: string): (view: Exclude<TextView, 'all'>) => string {
  const spans = literalSpans(text, /x$/.test(path))
  const views = new Map<TextView, string>()
  return view => {
    let seen = views.get(view)
    if (seen === undefined) views.set(view, (seen = hideSpans(text, spans, kind => kind !== 'string' || view === 'code')))
    return seen
  }
}

function uses(p: ParadigmRule, path: string, specs: string[], textOf: (view: TextView) => string | undefined, matchesGlob: (list: string[], path: string) => boolean): boolean {
  if (p.imports?.some(pattern => specs.some(s => importMatches(pattern, s)))) return true
  if (!p.text || (p.files && !matchesGlob(p.files, path))) return false
  // the whole text first: most files don't match at all, and those are never scanned
  const all = textOf('all')
  return all !== undefined && p.text.test(all) && p.text.test(textOf(p.strings ? 'strings' : 'code')!)
}
