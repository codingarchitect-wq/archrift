// A module's configuration as the frameworks read it (docs/POLYGLOT.md, P4):
// every YAML and .properties file in its resource folders, all profiles
// together, keys compared the way Spring's relaxed binding and Viper do
// (case, `-` and `_` don't matter), `${key:default}` placeholders resolved
// within the module. The messaging and datastore plugins ask it what a
// topic or database is called; where profiles disagree (a placeholder for
// Kubernetes, a literal for local runs) the first value that resolves to a
// literal wins.
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import type { AssembleApi } from './types.ts'

/** Folders holding a module's runtime configuration, relative to the module. */
const CONFIG_DIRS = ['src/main/resources', 'resources', 'config']
const CONFIG_FILE = /\.(ya?ml|properties)$/
const BUILD_FILE = /(^|\/)(build\.gradle(\.kts)?|pom\.xml|go\.mod)$/

export interface ModuleConfig {
  /** Every value a key has, in file and document order. */
  values(key: string): string[]
  /** Keys (as written, dotted) whose canonical form matches. */
  keys(match: (canonicalKey: string) => boolean): string[]
  /** `text` with every `${…}` resolved, or undefined when one can't be. */
  resolve(text: string): string | undefined
}

/** Relaxed binding: `kafkaTopic`, `kafka-topic` and `KAFKA_TOPIC` are one key. */
export const canonical = (key: string) => key.toLowerCase().replace(/[-_]/g, '')

const memo = new WeakMap<AssembleApi, Map<string, ModuleConfig>>()

/** Module folders: those with a build file (Gradle, Maven, Go), deepest first. */
export function moduleDirs(api: AssembleApi): string[] {
  return [...new Set(api.files().filter(f => BUILD_FILE.test(f)).map(f => path.posix.dirname(f)))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
}

/** The module a file belongs to: the deepest folder with a build file above it ('' when none). */
export function moduleOf(dirs: readonly string[], file: string): string {
  return dirs.find(d => file.startsWith(`${d}/`)) ?? ''
}

export function moduleConfig(api: AssembleApi, module: string): ModuleConfig {
  let byModule = memo.get(api)
  if (!byModule) memo.set(api, (byModule = new Map()))
  let config = byModule.get(module)
  if (config) return config
  const prefixes = CONFIG_DIRS.map(d => (module ? `${module}/${d}/` : `${d}/`))
  const files = api.files().filter(f => CONFIG_FILE.test(f) && prefixes.some(p => f.startsWith(p) && !f.slice(p.length).includes('/')))
  const values = new Map<string, string[]>()
  const written = new Map<string, string>()
  const put = (key: string, value: string) => {
    const c = canonical(key)
    if (!written.has(c)) written.set(c, key)
    const list = values.get(c)
    if (list) list.push(value)
    else values.set(c, [value])
  }
  // application.yml before profile files, then the rest by name
  const order = (f: string) => (/\/application\.(ya?ml|properties)$/.test(f) ? 0 : /\/application-/.test(f) ? 1 : 2)
  for (const f of files.sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1))) {
    const text = api.readText(f)
    if (text === undefined) continue
    if (f.endsWith('.properties')) {
      for (const line of text.split('\n')) {
        const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line)
        if (m) put(m[1], m[2].trim())
      }
      continue
    }
    try {
      for (const doc of parseAllDocuments(text)) {
        if ('errors' in doc && doc.errors.length) continue
        flatten(doc.toJS(), '', put)
      }
    } catch {
      // a file YAML can't read (a template): skipped
    }
  }
  config = {
    values: key => values.get(canonical(key)) ?? [],
    keys: match => [...values.keys()].filter(match).map(k => written.get(k) ?? k),
    resolve: text => resolve(text, key => values.get(canonical(key)) ?? [], 0),
  }
  byModule.set(module, config)
  return config
}

function flatten(value: unknown, prefix: string, put: (key: string, value: string) => void) {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, put))
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, put)
  else if (prefix) put(prefix, String(value))
}

function resolve(text: string, lookup: (key: string) => string[], depth: number): string | undefined {
  if (!text.includes('${')) return text
  if (depth > 8) return undefined
  let failed = false
  const out = text.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_, key: string, fallback: string | undefined) => {
    for (const candidate of lookup(key.trim())) {
      const r = resolve(candidate, lookup, depth + 1)
      if (r !== undefined) return r
    }
    if (fallback !== undefined) return resolve(fallback, lookup, depth + 1) ?? ((failed = true), '')
    failed = true
    return ''
  })
  return failed ? undefined : out
}
