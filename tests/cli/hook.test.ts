// `archrift hook` (docs/GUIDE.md "A hook for Claude Code"): installing the PreToolUse
// hook into a project's Claude Code settings and taking it out again, leaving
// everything else; and `hook pre-write`, the notes it gives before the agent
// writes a file: rules and ways for a new one, an existing one's rules, breaks
// and differences once per session, nothing for anything else.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyzer/analyze.ts'
import { capNotes } from '../../src/cli/hook-notes.ts'
import { MATCHER, TIMEOUT_S, hookCommand, install, preWrite, sessionFile, settingsPath, status, uninstall } from '../../src/cli/hook.ts'
import type { PreWriteOptions } from '../../src/cli/hook.ts'
import { writeGraph } from '../../src/cli/output.ts'
import { shellPath } from '../../src/cli/self.ts'

const CLI = path.resolve(import.meta.dirname, '../../src/cli/main.ts')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
/** A temporary folder, gone after the test (or, `kept`, after the file's tests). */
const tmp = (kept?: string[]) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-hook-')))
  ;(kept ?? dirs).push(d)
  return d
}
const shared: string[] = []
afterAll(() => {
  for (const d of shared) fs.rmSync(d, { recursive: true, force: true })
})
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('hook install, uninstall and status', () => {
  /** A settings file someone keeps: permissions, a Bash hook of their own, a PostToolUse hook. */
  const theirs = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check-bash.sh' }] }],
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }],
    },
    env: { FOO: '1' },
  }

  it('adds the hook to settings.local.json, keeps everything else, and only once', () => {
    const dir = tmp()
    const file = settingsPath(dir, false)
    write(file, JSON.stringify(theirs))
    const text = install({ dir, shared: false })
    expect(text).toContain(`archrift hook installed in ${file} (personal: not committed)`)
    const once = read(file)
    expect(Object.keys(once)).toEqual(['permissions', 'hooks', 'env'])
    expect(once.permissions).toEqual(theirs.permissions)
    expect(once.env).toEqual(theirs.env)
    expect(once.hooks.PostToolUse).toEqual(theirs.hooks.PostToolUse)
    expect(once.hooks.PreToolUse).toEqual([...theirs.hooks.PreToolUse, { matcher: MATCHER, hooks: [{ type: 'command', command: hookCommand(), timeout: TIMEOUT_S }] }])
    expect(hookCommand()).toBe(`node ${shellPath(CLI)} hook pre-write`)
    expect(hookCommand('archrift')).toBe('archrift hook pre-write')

    expect(install({ dir, shared: false })).toBe(`archrift hook: already installed in ${file}\n`)
    expect(read(file)).toEqual(once)
    // another checkout's command is replaced, not added to
    install({ dir, shared: false, command: 'node "/elsewhere/main.ts" hook pre-write' })
    expect(read(file).hooks.PreToolUse.filter((g: { hooks: { command: string }[] }) => g.hooks.some(h => h.command.includes('hook pre-write')))).toEqual([
      { matcher: MATCHER, hooks: [{ type: 'command', command: 'node "/elsewhere/main.ts" hook pre-write', timeout: TIMEOUT_S }] },
    ])
  })

  it('uninstall removes only its own entry, and the lists and objects that leaves empty', () => {
    const dir = tmp()
    const file = settingsPath(dir, false)
    write(file, JSON.stringify(theirs))
    install({ dir, shared: false })
    expect(uninstall({ dir, shared: false })).toBe(`archrift hook removed from ${file}\n`)
    expect(read(file)).toEqual(theirs)
    expect(uninstall({ dir, shared: false })).toBe(`archrift hook: not installed in ${file}, nothing to remove\n`)

    // the hook alone: nothing of hooks is left
    const alone = tmp()
    install({ dir: alone, shared: false })
    uninstall({ dir: alone, shared: false })
    expect(read(settingsPath(alone, false))).toEqual({})
  })

  it('--shared goes to settings.json; status says where it is and with which command', () => {
    const dir = tmp()
    expect(status({ dir })).toBe(`archrift hook: not installed in ${dir} (.claude/settings.local.json, .claude/settings.json); archrift hook install adds it\n`)
    install({ dir, shared: true })
    expect(fs.existsSync(path.join(dir, '.claude', 'settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.claude', 'settings.local.json'))).toBe(false)
    expect(status({ dir })).toBe(
      `archrift hook: installed in ${path.join(dir, '.claude', 'settings.json')} (shared: committed with the repo)\n  PreToolUse ${MATCHER} → ${hookCommand()} (timeout ${TIMEOUT_S} s)\n`,
    )
    expect(status({ dir, command: 'node "/other/main.ts" hook pre-write' })).toMatch(/not this checkout's command, node "\/other\/main.ts" hook pre-write: archrift hook install --shared updates it/)
  })

  it('leaves a settings file it cannot read alone', () => {
    const dir = tmp()
    const file = settingsPath(dir, false)
    write(file, '{ "permissions": ')
    expect(() => install({ dir, shared: false })).toThrow(/doesn't hold a JSON object \(left as it is\)/)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "permissions": ')
  })

  it('runs from the command line, in the folder given', () => {
    const dir = tmp()
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, 'hook', ...args], { encoding: 'utf8' })
    expect(cli('install', '--dir', dir).status).toBe(0)
    expect(read(settingsPath(dir, false)).hooks.PreToolUse).toHaveLength(1)
    expect(cli('status', '--dir', dir).stdout).toContain(`installed in ${settingsPath(dir, false)}`)
    expect(cli('uninstall', '--dir', dir).status).toBe(0)
    expect(cli('frobnicate').status).toBe(1)
  })
})

// ── pre-write ─────────────────────────────────────────────────────────────

/**
 * A small app with its own .archrift/config.json: pages in src/app, logic in src/lib that does dates
 * with date-fns (old.ts with Moment.js) and must not depend on the pages (bad.ts does).
 */
function app(kept?: string[]): string {
  const root = tmp(kept)
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['src'] }),
    'src/lib/day.ts': "import { format } from 'date-fns'\nexport const day = (d: Date) => format(d, 'yyyy-MM-dd')\n",
    'src/lib/next.ts': "import { addDays } from 'date-fns'\nexport const next = (d: Date) => addDays(d, 1)\n",
    'src/lib/old.ts': "import moment from 'moment'\nexport const year = (d: Date) => moment(d).format('YYYY')\n",
    'src/lib/bad.ts': "import { page } from '../app/page'\nexport const bad = page\n",
    'src/app/page.ts': "import { day } from '../lib/day'\nexport const page = () => day(new Date())\n",
    'src/generated/client.ts': 'export const generated = 1\n',
    'README.md': '# app\n',
    '.archrift/config.json': JSON.stringify({
      name: 'hook-app',
      exclude: ['src/generated/**'],
      layers: [
        { name: 'app', match: 'src/app/**' },
        { name: 'lib', match: 'src/lib/**' },
      ],
      rules: [
        { name: 'lib-not-app', description: 'Logic never imports pages.', forbid: { from: 'src/lib/**', to: 'src/app/**' } },
        { name: 'layers-down', severity: 'warn', layers: 'down' },
      ],
    }),
  }
  for (const [rel, text] of Object.entries(files)) write(path.join(root, rel), text)
  return root
}

describe('hook pre-write', () => {
  let root: string
  let graphFile: string
  beforeAll(async () => {
    root = app(shared)
    graphFile = path.join(root, '.archrift', 'graph.json')
    writeGraph(await analyze({ root, cacheDir: false, history: false }), graphFile)
  })

  const options = (): PreWriteOptions & { stateDir: string } => {
    const base = tmp()
    return { projects: path.join(base, 'projects.json'), stateDir: path.join(base, 'state'), cli: 'node /tools/archrift/src/cli/main.ts' }
  }
  const input = (file: string, session = 's-1', tool = 'Edit') => JSON.stringify({ session_id: session, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file } })
  const notes = (out: string) => {
    const json = JSON.parse(out)
    expect(json.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    return json.hookSpecificOutput.additionalContext as string
  }

  it('gives a new file the rules of its place and how its block does each job', async () => {
    const text = notes(await preWrite(input(path.join(root, 'src/lib/when.ts'), 's-1', 'Write'), options()))
    const lines = text.split('\n')
    expect(lines[0]).toBe('archrift: architecture notes for src/lib/when.ts (new file, block src/lib, layer lib)')
    expect(text).toContain('Its rules:\n  must not depend on src/app/**  [lib-not-app, error] Logic never imports pages.')
    expect(text).toContain('  is in layer lib: may depend on lib, not on app  [layers-down, warn]')
    expect(text).toContain('How src/lib does its jobs:\n  Dates: use date-fns, as src/lib/day.ts, src/lib/next.ts do')
    expect(lines.at(-1)).toBe(
      `Ask archrift more: node /tools/archrift/src/cli/main.ts query rules src/lib/when.ts --to <import> --root ${root} · node /tools/archrift/src/cli/main.ts query ways src/lib/when.ts --job "<job>" --root ${root}`,
    )
  })

  it('gives an existing file its rules, what it breaks and how it differs from its block, once per session', async () => {
    const o = options()
    const bad = notes(await preWrite(input(path.join(root, 'src/lib/bad.ts')), o))
    expect(bad.split('\n')[0]).toBe('archrift: architecture notes for src/lib/bad.ts (block src/lib, layer lib)')
    expect(bad).toContain('Broken now (2):\n  ✗ lib-not-app: src/lib/bad.ts → src/app/page.ts')
    expect(bad).toContain('How src/lib does its jobs: Dates → date-fns')

    const old = notes(await preWrite(input(path.join(root, 'src/lib/old.ts')), o))
    expect(old).toContain('Broken now: nothing.')
    expect(old).toContain('Jobs it does differently from its block:\n  Dates: it uses Moment.js; its block uses date-fns')

    // later edits in the session: nothing; another session hears it again
    expect(await preWrite(input(path.join(root, 'src/lib/bad.ts')), o)).toBe('')
    expect(await preWrite(input(path.join(root, 'src/lib/old.ts'), 's-1', 'Write'), o)).toBe('')
    expect(read(sessionFile(o.stateDir, 's-1')).files).toEqual([path.join(root, 'src/lib/bad.ts'), path.join(root, 'src/lib/old.ts')])
    expect(notes(await preWrite(input(path.join(root, 'src/lib/bad.ts'), 's-2'), o))).toContain('lib-not-app')
  })

  it('says nothing about files that are no code, excluded, outside a project, or input it cannot read', async () => {
    const o = options()
    expect(await preWrite(input(path.join(root, 'README.md')), o)).toBe('')
    expect(await preWrite(input(path.join(root, 'src/generated/client.ts')), o)).toBe('')
    expect(await preWrite(input(path.join(tmp(), 'src/lib/x.ts')), o)).toBe('')
    expect(await preWrite('not json', o)).toBe('')
    expect(await preWrite(JSON.stringify({ session_id: 's', tool_input: { file_path: 'src/lib/x.ts' } }), o)).toBe('')
    expect(await preWrite(JSON.stringify({ tool_input: {} }), o)).toBe('')
    expect(fs.existsSync(o.stateDir)).toBe(false)
  })

  it('without a written graph: from the cache, or nothing while a background run fills it', async () => {
    const fresh = app()
    const warmed: string[] = []
    const o = { ...options(), warm: (p: { root: string }) => warmed.push(p.root) }
    expect(await preWrite(input(path.join(fresh, 'src/lib/when.ts')), o)).toBe('')
    expect(warmed).toEqual([fresh])
    await analyze({ root: fresh, cacheDir: path.join(fresh, '.archrift', 'cache'), history: false })
    expect(notes(await preWrite(input(path.join(fresh, 'src/lib/when.ts')), o))).toContain('Dates: use date-fns')
    expect(warmed).toEqual([fresh])
  })

  it('runs from the command line: notes as JSON on stdout, exit 0 whatever comes in', () => {
    const state = tmp()
    const run = (stdin: string) => spawnSync(process.execPath, [CLI, 'hook', 'pre-write'], { input: stdin, encoding: 'utf8', env: { ...process.env, TMPDIR: state } })
    const ok = run(input(path.join(root, 'src/lib/when.ts'), 'cli', 'Write'))
    expect(ok.status).toBe(0)
    expect(notes(ok.stdout)).toMatch(/^archrift: architecture notes for src\/lib\/when\.ts/)
    for (const bad of ['', '{', 'null', '[]']) expect(run(bad)).toMatchObject({ status: 0, stdout: '' })
  })
})

describe('the notes', () => {
  it('keep the header and the last line, and as many lines between as fit', () => {
    const body = Array.from({ length: 50 }, (_, i) => `  line ${i} ${'x'.repeat(80)}`)
    const text = capNotes('head', body, 'foot', 1000)
    expect(text.length).toBeLessThanOrEqual(1000)
    const lines = text.split('\n')
    expect(lines[0]).toBe('head')
    expect(lines.at(-1)).toBe('foot')
    expect(lines.at(-2)).toMatch(/^ {2}… \d+ more lines \(ask archrift, below\)$/)
    expect(capNotes('head', ['a', 'b'], 'foot')).toBe('head\na\nb\nfoot')
  })
})
