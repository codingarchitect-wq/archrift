// The files of a project for the analyzers that don't bring their own file
// list (TypeScript has its tsconfigs): everything under the root and the
// mounts, minus what the config excludes, as graph paths.
import fs from 'node:fs'
import path from 'node:path'
import { matcher } from '../core/glob.ts'
import { DEFAULT_EXCLUDE } from './config.ts'
import type { Config } from './config.ts'
import type { Mount } from './mounts.ts'

export function listFiles(root: string, mounts: readonly Mount[], config: Config): string[] {
  const excluded = matcher([...DEFAULT_EXCLUDE, ...config.exclude])
  const included = config.include ? matcher(config.include) : () => true
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // a mount's name shadows nothing: resolveMounts refuses one the root has
        if (!excluded(`${r}/_`)) walk(path.join(dir, entry.name), r)
      } else if (entry.isFile() && included(r) && !excluded(r)) out.push(r)
    }
  }
  walk(root, '')
  for (const m of mounts) walk(m.dir, m.name)
  return out.sort()
}
