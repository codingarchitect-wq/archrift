// Mounts (docs/POLYGLOT.md): other folders analyzed as part of the project,
// each under a name. `"mounts": { "infra": "~/src/infra" }` makes the files of
// ~/src/infra appear as `infra/…` in the graph, next to the root's own. Source
// reads, editor links and git history go to the folder a path really lives in.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface Mount {
  /** The first path segment its files get in the graph. */
  name: string
  /** Absolute folder. */
  dir: string
}

/** The configured mounts with absolute folders: `~` is the home folder, a relative path is relative to the root. */
export function resolveMounts(root: string, mounts: Record<string, string> | undefined): Mount[] {
  return Object.entries(mounts ?? {}).map(([name, dir]) => {
    const expanded = dir === '~' ? os.homedir() : dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir
    const abs = path.resolve(root, expanded)
    if (!fs.existsSync(abs)) throw new Error(`mount "${name}": no folder ${abs}`)
    if (fs.existsSync(path.join(root, name))) throw new Error(`mount "${name}": the root has a ${name} of its own`)
    return { name, dir: abs }
  })
}

/** Graph path → absolute path: `infra/k8s/x.yaml` → `<infra's folder>/k8s/x.yaml`. */
export function absPathOf(root: string, mounts: readonly Mount[] | Record<string, string> | undefined, rel: string): string {
  const slash = rel.indexOf('/')
  const first = slash < 0 ? rel : rel.slice(0, slash)
  const rest = slash < 0 ? '' : rel.slice(slash + 1)
  const dir = Array.isArray(mounts) ? mounts.find(m => m.name === first)?.dir : (mounts as Record<string, string> | undefined)?.[first]
  return dir === undefined ? path.join(root, rel) : path.join(dir, rest)
}

/** Absolute path → graph path; outside the root and every mount it starts with `..` (like path.relative). */
export function relPathOf(root: string, mounts: readonly Mount[], abs: string): string {
  for (const m of mounts) if (abs === m.dir || abs.startsWith(m.dir + path.sep)) return [m.name, ...path.relative(m.dir, abs).split(path.sep)].filter(Boolean).join('/')
  return path.relative(root, abs).split(path.sep).join('/')
}
