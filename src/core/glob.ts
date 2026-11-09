// Minimal glob matching for config patterns, relative to the analyzed root:
// `**` (any number of path segments), `*` (within a segment), `?`, `{a,b}`.
// A pattern without a slash matches the basename anywhere (like .gitignore).

export function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes('/') ? glob.replace(/^\.\//, '') : `**/${glob}`
  let re = ''
  let inGroup = 0
  for (let i = 0; i < anchored.length; i++) {
    const c = anchored[i]
    if (c === '*') {
      if (anchored[i + 1] === '*') {
        const slashAfter = anchored[i + 2] === '/'
        re += slashAfter ? '(?:.*/)?' : '.*'
        i += slashAfter ? 2 : 1
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      inGroup++
      re += '(?:'
    } else if (c === '}' && inGroup) {
      inGroup--
      re += ')'
    } else if (c === ',' && inGroup) re += '|'
    else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c
  }
  // a pattern naming a directory also matches everything below it
  return new RegExp(`^${re}(?:/.*)?$`)
}

export type Matcher = (relPath: string) => boolean

export function matcher(globs: readonly string[]): Matcher {
  const res = globs.map(globToRegExp)
  return p => res.some(r => r.test(p))
}
