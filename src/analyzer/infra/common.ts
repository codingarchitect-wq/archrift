// Helpers the infrastructure reader's file readers share: YAML documents with
// positions, lines of code, image names, database engines, and what must
// never be read or copied (secrets).
import { LineCounter, isMap, isScalar, parseAllDocuments } from 'yaml'
import type { Node as YamlNode, Pair } from 'yaml'
import type { Range } from '../../core/model.ts'

export interface YamlDoc {
  /** The document as plain data; undefined when it can't be read. */
  value: unknown
  contents: YamlNode | null
  /** Offsets of the document's content in the text. */
  start: number
  end: number
  range: Range
  errors: boolean
}

export interface ParsedYaml {
  docs: YamlDoc[]
  lines: LineCounter
  errors: boolean
}

/** Every document of a YAML text; duplicate keys (both branches of a template's `if`) keep the last. */
export function parseYaml(text: string): ParsedYaml {
  const lines = new LineCounter()
  const docs: YamlDoc[] = []
  let errors = false
  let parsed: ReturnType<typeof parseAllDocuments>
  try {
    parsed = parseAllDocuments(text, { lineCounter: lines, uniqueKeys: false, strict: false, prettyErrors: false })
  } catch {
    return { docs, lines, errors: true }
  }
  for (const doc of Array.isArray(parsed) ? parsed : []) {
    const contents = doc.contents as YamlNode | null
    if (doc.errors.length) errors = true
    if (!contents?.range) continue
    let value: unknown
    try {
      value = doc.toJS({ maxAliasCount: 100 })
    } catch {
      value = undefined
    }
    const [start, end] = contents.range
    docs.push({ value, contents, start, end, range: rangeOf(lines, start, end), errors: doc.errors.length > 0 })
  }
  return { docs, lines, errors }
}

/** [startLine, startCol, endLine, endCol] of an offset span (the end's last character, not the newline after it). */
export function rangeOf(lines: LineCounter, start: number, end: number): Range {
  const a = lines.linePos(start)
  const b = lines.linePos(Math.max(start, end - 1))
  return [a.line, a.col, b.line, b.col + 1]
}

/** The key/value pairs of a mapping node, with the key's text. */
export function pairsOf(node: YamlNode | null | undefined): { key: string; pair: Pair<YamlNode, YamlNode | null> }[] {
  if (!isMap(node)) return []
  const out: { key: string; pair: Pair<YamlNode, YamlNode | null> }[] = []
  for (const pair of node.items as Pair<YamlNode, YamlNode | null>[]) {
    if (isScalar(pair.key) && pair.key.value !== null && pair.key.value !== undefined) out.push({ key: String(pair.key.value), pair })
  }
  return out
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined)

/** Follows a path of keys through plain data. */
export function get(v: unknown, ...keys: string[]): unknown {
  let cur = v
  for (const k of keys) {
    if (!isObject(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/** Lines with something on them. */
export function countLoc(text: string, from = 1, to = Number.MAX_SAFE_INTEGER): number {
  let n = 0
  let line = 1
  let blank = true
  for (let i = 0; i <= text.length; i++) {
    const c = text[i]
    if (i === text.length || c === '\n') {
      if (!blank && line >= from && line <= to) n++
      line++
      blank = true
      if (line > to) break
    } else if (c !== ' ' && c !== '\t' && c !== '\r') blank = false
  }
  return n
}

/** 1-based line and column of an offset. */
export function positionOf(text: string, offset: number): [number, number] {
  let line = 1
  let last = -1
  for (let i = 0; i < offset && i < text.length; i++)
    if (text.charCodeAt(i) === 10) {
      line++
      last = i
    }
  return [line, offset - last]
}

/** Offsets where each line starts, for many lookups in one text. */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/**
 * `image:<repo/name>` for an image reference: the registry host, the tag and
 * the digest dropped (`acmeacr01.azurecr.io/bitnami/mongodb:8.0.3` → `bitnami/mongodb`).
 * Undefined when the reference is only known at run time.
 */
export function imageName(ref: string): string | undefined {
  let s = ref.trim().replace(/^["']|["']$/g, '')
  if (!s || s.includes('…') || /^\$\{?\w+\}?$/.test(s)) return undefined
  s = s.replace(/@sha256:[0-9a-f]+$/i, '')
  const slash = s.lastIndexOf('/')
  const colon = s.lastIndexOf(':')
  if (colon > slash) s = s.slice(0, colon)
  const parts = s.split('/')
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) parts.shift()
  if (parts[0] === 'library' && parts.length > 1) parts.shift()
  const name = parts.join('/')
  return name && !name.includes('$') ? name : undefined
}

/** The database engine an image runs, from its last segment (`bitnami/mongodb` → mongodb). */
export function engineOfImage(image: string): string | undefined {
  const last = image.slice(image.lastIndexOf('/') + 1).toLowerCase()
  if (/^(mysql|mariadb|percona(-server)?)$/.test(last)) return last === 'mariadb' ? 'mariadb' : 'mysql'
  if (/^postgres(ql)?$/.test(last)) return 'postgres'
  if (/^mongo(db)?$/.test(last)) return 'mongodb'
  if (/^redis(-stack)?$/.test(last)) return 'redis'
  return undefined
}

/** A key whose value must never be copied into the graph. */
export const SECRET_KEY = /pass(word|wd|phrase)?|pwd|secret|token|credential|private|api[-_]?key|access[-_]?key|client[-_]?id|tenant[-_]?id|connection[-_]?string|cert/i

/**
 * Files never read, whatever the config says: secret stores, certificates and
 * keys, credential files, environment files.
 */
export function isSecretPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return (
    /(^|\/)(secrets?|certificates?|certs|\.ssh|\.gnupg)\//i.test(path) ||
    /\.(pem|key|crt|cer|pfx|p12|jks|keystore|der|asc|gpg)$/.test(base) ||
    /^(credentials?|creds)([-_.]|$)/.test(base) ||
    /^\.env(\.|$)/.test(base) ||
    /(^|[-_.])secrets?([-_.]|$).*\.ya?ml$/.test(base)
  )
}

/** A SOPS-encrypted file (its values are ciphertext and its metadata says so). */
export const isEncrypted = (text: string) => text.includes('ENC[AES256_GCM,') || /^sops:\s*$/m.test(text)

/** The bit of a scalar a signature may show: numbers and booleans, never strings. */
export function shape(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return '~'
  if (Array.isArray(v)) return '[…]'
  if (typeof v === 'object') return '{…}'
  return '"…"'
}
