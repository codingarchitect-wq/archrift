// Fragment cache. An entry is reused when its file is unchanged and
// every project file its references resolved into is unchanged too. The whole
// cache is dropped when anything global changes: the analyzer, TypeScript,
// compiler options, targets or the dependency lockfile.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ExtractedFile } from './fragment.ts'
import { writeCache } from './cache-write.ts'

/** Bump when extraction output changes shape or meaning. */
export const CACHE_VERSION = 1
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']

export const hashText = (text: string) => crypto.createHash('sha1').update(text).digest('hex')

export function globalCacheKey(root: string, parts: unknown): string {
  const lock = LOCKFILES.map(f => path.join(root, f)).find(f => fs.existsSync(f))
  return hashText(JSON.stringify({ v: CACHE_VERSION, parts, lock: lock ? hashText(fs.readFileSync(lock, 'utf8')) : null }))
}

interface CacheFile {
  key: string
  files: Record<string, ExtractedFile>
}

export class FragmentCache {
  private readonly file: string | undefined
  private readonly key: string
  private readonly entries: Map<string, ExtractedFile>

  constructor(dir: string | undefined, key: string) {
    this.file = dir && path.join(dir, 'fragments.json')
    this.key = key
    this.entries = new Map()
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CacheFile
      if (data.key === key) for (const [p, e] of Object.entries(data.files)) this.entries.set(p, e)
    } catch {
      // unreadable cache: start over
    }
  }

  /** The cached extraction for `relPath` if it and everything it depends on is unchanged. */
  lookup(relPath: string, hashOf: (p: string) => string | undefined): ExtractedFile | undefined {
    const e = this.entries.get(relPath)
    if (!e || e.hash !== hashOf(relPath)) return undefined
    for (const [dep, h] of Object.entries(e.deps)) if (hashOf(dep) !== h) return undefined
    return e
  }

  /** The cached extraction for `relPath`, whatever changed since. */
  entry(relPath: string): ExtractedFile | undefined {
    return this.entries.get(relPath)
  }

  /** A cached extraction whose own file is unchanged but some files it depends on changed: which ones. */
  candidate(relPath: string, hashOf: (p: string) => string | undefined): { entry: ExtractedFile; changedDeps: string[] } | undefined {
    const e = this.entries.get(relPath)
    if (!e || e.hash !== hashOf(relPath)) return undefined
    const changedDeps = Object.entries(e.deps)
      .filter(([dep, h]) => hashOf(dep) !== h)
      .map(([dep]) => dep)
    return changedDeps.length ? { entry: e, changedDeps } : undefined
  }

  /** Remember extractions in memory (a long-lived session), without writing. */
  put(files: Iterable<ExtractedFile>) {
    for (const f of files) this.entries.set(f.path, f)
  }

  save(files: ExtractedFile[]) {
    if (!this.file) return
    const data: CacheFile = { key: this.key, files: Object.fromEntries(files.map(f => [f.path, f])) }
    writeCache(this.file, JSON.stringify(data))
  }
}
