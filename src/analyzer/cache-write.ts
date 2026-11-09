// Writing what archrift can do without: its caches. A folder it may not write
// (a sandbox, a read-only checkout or mount) costs time, not the answer: the
// analysis goes on uncached, with one warning per folder on stderr.
import fs from 'node:fs'
import path from 'node:path'

/** The errors that mean "this place can't be written". Anything else (a full disk, a bug) still throws. */
const NOT_WRITABLE = new Set(['EPERM', 'EACCES', 'EROFS'])
const warned = new Set<string>()

const stderr = (message: string) => void process.stderr.write(`${message}\n`)

/** Writes `text` to `file`, its folder made first. Where archrift may not write, it warns once for the folder and returns false. */
export function writeCache(file: string, text: string, warn: (message: string) => void = stderr): boolean {
  const dir = path.dirname(file)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, text)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (!code || !NOT_WRITABLE.has(code)) throw e
    if (!warned.has(dir)) {
      warned.add(dir)
      warn(`archrift: can't write its cache in ${dir} (${code}); going on without it. ARCHRIFT_CACHE or --out moves it to a folder it may write.`)
    }
    return false
  }
}
