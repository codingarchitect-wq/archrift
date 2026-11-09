// A small TypeScript project with a git history, dated so everything it
// yields is fixed: a.ts and b.ts change together without importing each
// other (hidden coupling), b.ts moves to lib/, d.ts arrives late.
//
//   node tests/helpers/history-repo.ts <dir>   (the e2e server builds its repo so)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface Step {
  date: string
  message: string
  write?: Record<string, string>
  move?: [string, string]
}

const fn = (name: string, body: string) => `export function ${name}(x: number) {\n${body}\n}\n`
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `  if (x === ${i}) return ${JSON.stringify(`${tag}${i}`)}`).join('\n') + '\n  return null'

export const HISTORY_STEPS: Step[] = [
  {
    date: '2026-01-05T10:00:00Z',
    message: 'start',
    write: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }, null, 2) + '\n',
      'src/a.ts': fn('a', lines(4, 'a')),
      'src/b.ts': fn('b', lines(4, 'b')),
      'src/c.ts': `import { a } from './a'\n${fn('c', '  return a(x)')}`,
    },
  },
  { date: '2026-02-02T10:00:00Z', message: 'a and b', write: { 'src/a.ts': fn('a', lines(8, 'a')), 'src/b.ts': fn('b', lines(8, 'b')) } },
  {
    date: '2026-03-02T10:00:00Z',
    message: 'a and b again',
    write: { 'src/a.ts': fn('a', lines(12, 'a')), 'src/b.ts': fn('b', lines(12, 'b')), 'src/c.ts': `import { a } from './a'\n${fn('c', '  return a(x + 1)')}` },
  },
  { date: '2026-04-06T10:00:00Z', message: 'move b into lib', move: ['src/b.ts', 'src/lib/b.ts'], write: { 'src/a.ts': fn('a', lines(14, 'a')) } },
  {
    date: '2026-05-04T10:00:00Z',
    message: 'add d',
    write: { 'src/a.ts': fn('a', lines(20, 'a')), 'src/lib/b.ts': fn('b', lines(16, 'b')), 'src/d.ts': `import { b } from './lib/b'\n${fn('d', '  return b(x)')}` },
  },
  { date: '2026-06-01T10:00:00Z', message: 'tidy c', write: { 'src/c.ts': `import { a } from './a'\n${fn('c', '  return a(x + 2)')}` } },
]

/** Builds the repository in `dir` (emptied first); returns the commit shas, oldest first. */
export function makeHistoryRepo(dir: string): string[] {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const git = (args: string[], date?: string) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Ada',
        GIT_AUTHOR_EMAIL: 'ada@example.com',
        GIT_COMMITTER_NAME: 'Ada',
        GIT_COMMITTER_EMAIL: 'ada@example.com',
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
    }).trim()
  git(['init', '-q'])
  const shas: string[] = []
  for (const step of HISTORY_STEPS) {
    if (step.move) {
      fs.mkdirSync(path.dirname(path.join(dir, step.move[1])), { recursive: true })
      git(['mv', ...step.move])
    }
    for (const [file, text] of Object.entries(step.write ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), text)
    }
    git(['add', '-A'])
    git(['commit', '-q', '-m', step.message], step.date)
    shas.push(git(['rev-parse', 'HEAD']))
  }
  return shas
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) throw new Error('usage: node tests/helpers/history-repo.ts <dir>')
  makeHistoryRepo(path.resolve(dir))
}
