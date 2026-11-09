// plain-ts as a project with words written for it and a change in progress,
// for the viewer's descriptions, Changes and Ask (tests/e2e/ask-changes.spec.ts):
// a git repository with the fixture committed, a second commit (a comment in
// src/app.ts), then src/util.ts grown an export, src/extra.ts added, and the
// agent's notes on why.
//
//   node tests/helpers/change-repo.ts <dir>   (the e2e server builds its repo so)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/plain-ts')

export function changeRepo(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(FIXTURE, dir, { recursive: true })
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  write('.archrift/.gitignore', '*\n!.gitignore\n!config.json\n!descriptions.json\n')
  write('.archrift/config.json', `${JSON.stringify({ name: 'shapes' }, null, 2)}\n`)
  write(
    '.archrift/descriptions.json',
    `${JSON.stringify(
      {
        project: 'Draws shapes and says how big they are.',
        entries: {
          'd:src': { name: 'Shape code', summary: 'Everything the app runs.' },
          'f:src/util.ts': { name: 'Helpers', summary: 'Small sums the shapes need: parsing and clamping numbers.' },
          'f:src/shapes.ts': { summary: 'The shapes the app draws.', surface: 'written-for-older-exports' },
        },
      },
      null,
      2,
    )}\n`,
  )
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-06-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-06-01T10:00:00Z' },
    })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'start')
  // a second commit, for Changes' ranges: the last commit, one commit, everything since one
  fs.appendFileSync(path.join(dir, 'src/app.ts'), '\n// the shapes the app draws, and how big they are\n')
  git('commit', '-qam', 'Say what the app draws', '-m', 'A comment at the end of app.ts.')
  // the change in progress
  fs.appendFileSync(path.join(dir, 'src/util.ts'), '\nexport const twice = (n: number) => n * 2\n')
  write('src/extra.ts', "import { makeCircle } from './shapes'\nimport { clamp } from './util'\nexport const unit = () => makeCircle({ x: 0, y: 0 }, clamp(1, 0, 1))\n")
  write(
    '.archrift/changes.json',
    `${JSON.stringify({ tasks: [{ title: 'Unit circles', request: 'Let callers make a unit circle', summary: 'A helper makes one; util can double a number.', notes: { 'src/extra.ts': 'Makes the unit circle the request asked for.' } }] }, null, 2)}\n`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) changeRepo(path.resolve(process.argv[2] ?? 'out/e2e/ask/repo'))
