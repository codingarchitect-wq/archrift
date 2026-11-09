// Stable node IDs. They are derived from paths and declared names
// only, never from positions, so saved views, caches and history snapshots
// stay anchored when code moves around inside a file.

export const ROOT_ID = 'd:.'

export const dirId = (path: string) => (path === '' || path === '.' ? ROOT_ID : `d:${path}`)
export const fileId = (path: string) => `f:${path}`
export const symbolId = (path: string, name: string) => `s:${path}#${name}`
export const memberId = (path: string, owner: string, member: string) => `s:${path}#${owner}.${member}`
export const npmId = (pkg: string) => `x:npm:${pkg}`
export const builtinId = (mod: string) => `x:node:${mod.replace(/^node:/, '')}`
/** A resolved file inside the root that the config excludes (e.g. generated code). */
export const excludedId = (path: string) => `x:excluded:${path}`

/** The file node an id belongs to (`s:a.ts#X.y` → `f:a.ts`); undefined for directories and externals. */
export function fileIdOf(id: string): string | undefined {
  if (id.startsWith('f:')) return id
  if (!id.startsWith('s:')) return undefined
  const hash = id.indexOf('#')
  return hash < 0 ? undefined : `f:${id.slice(2, hash)}`
}

export function parentDir(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** npm package name of a bare specifier: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
export function packageName(spec: string) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}
