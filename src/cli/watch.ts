// Watch mode's file watcher.
import fs from 'node:fs'
import path from 'node:path'

/**
 * Calls `onChange` with the files that changed under root, 120 ms after the
 * last change (editors write in bursts), never twice at once: changes during a
 * run make one more run after it. Hidden directories (.git, .next, .archrift),
 * what the config excludes (build output, src-tauri/target …) and the output
 * directory are left alone.
 */
export function watchFiles(root: string, out: string, excluded: (rel: string) => boolean, onChange: (changed: string[]) => Promise<void>): fs.FSWatcher {
  const outDir = path.relative(root, path.dirname(out)).split(path.sep).join('/')
  const ignored = (rel: string) =>
    excluded(rel) ||
    rel.split('/').some(part => part.startsWith('.') || part === 'node_modules') ||
    (!outDir.startsWith('..') && outDir !== '' && (rel === outDir || rel.startsWith(`${outDir}/`)))
  const changed = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  const flush = async () => {
    if (running || !changed.size) return
    const files = [...changed].sort()
    changed.clear()
    running = true
    try {
      await onChange(files)
    } catch (err) {
      process.stderr.write(`archrift: update failed: ${err instanceof Error ? err.message : String(err)}\n`)
    } finally {
      running = false
      if (changed.size) schedule()
    }
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void flush(), 120)
  }
  const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
    if (!name) return
    const rel = String(name).split(path.sep).join('/')
    if (ignored(rel)) return
    changed.add(rel)
    schedule()
  })
  watcher.on('close', () => clearTimeout(timer))
  return watcher
}
