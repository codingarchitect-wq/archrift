// Objects the panels need that aren't state: the scene engine (camera home,
// screen positions) and the analyzed root (for editor links).
import type { SceneEngine } from '../scene/engine.ts'

export const runtime: { engine?: SceneEngine } = {}

/**
 * VS Code's URL scheme opens a file at a line: vscode://file/<abs path>:<line>:<col>.
 * A path under a mount (Info.mounts) lives in that folder.
 */
export function editorUrl(root: string, relPath: string, line = 1, col = 1, mounts?: Record<string, string>) {
  const slash = relPath.indexOf('/')
  const mount = slash > 0 && mounts && Object.hasOwn(mounts, relPath.slice(0, slash)) ? mounts[relPath.slice(0, slash)] : undefined
  const abs = mount !== undefined ? `${mount}/${relPath.slice(slash + 1)}` : `${root}/${relPath}`
  return `vscode://file${abs.startsWith('/') ? '' : '/'}${encodeURI(abs)}:${line}:${col}`
}
