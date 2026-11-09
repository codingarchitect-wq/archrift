// How archrift runs itself, and how it tells people and agents to run it.
// In a checkout the entry is src/cli/main.ts (Node strips its types); the
// package from npm carries the built lib/cli/main.js instead (Node refuses
// to strip types under node_modules), and bin/archrift.js picks one.
import os from 'node:os'
import path from 'node:path'

/** This archrift's entry file, beside this module: `main.ts` in a checkout, `main.js` when built. */
export const ENTRY = path.resolve(import.meta.dirname, `main${path.extname(import.meta.filename)}`)

/** A path for a shell command: `~/…` when it's under the home folder and needs no quotes, else quoted. */
export function shellPath(p: string, home = os.homedir()): string {
  const short = p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
  return /^[\w@%+=:,./~-]+$/.test(short) ? short : JSON.stringify(p)
}

const BIN = new Set(['archrift', 'archrift.js', 'archrift.cmd'])

/**
 * The command that started this process, as someone would type it again: `archrift` when it
 * came from the PATH (`npm link`, `npm i -g archrift`), `npx archrift` from a project's
 * node_modules/.bin, else `node <this entry>`. Printed commands and the hook use it, so they
 * work the way the person's own call did.
 */
export function invokedAs(argv1 = process.argv[1] ?? '', pathEnv = process.env.PATH ?? ''): string {
  if (BIN.has(path.basename(argv1))) {
    const dir = path.dirname(argv1)
    if (path.basename(dir) === '.bin' && path.basename(path.dirname(dir)) === 'node_modules') return 'npx archrift'
    if (pathEnv.split(path.delimiter).some(d => d && path.resolve(d) === dir)) return 'archrift'
  }
  return `node ${shellPath(ENTRY)}`
}
