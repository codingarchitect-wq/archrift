// `archrift hook` (docs/GUIDE.md "A hook for Claude Code"): an optional Claude Code
// PreToolUse hook, off until `archrift hook install` writes it into a project's
// .claude/settings.local.json (or, --shared, settings.json). Before the agent
// writes or edits a code file of an archrift project, `hook pre-write` puts
// archrift's notes on that file into the agent's context (hook-notes.ts): for a
// new file, the rules of its place and how its block does each job; for an
// existing one, once per session, its rules, what it breaks and how it differs
// from its block. It never blocks the tool call: on any problem it prints
// nothing and exits 0.
//
// Protocol (https://code.claude.com/docs/en/hooks): the hook reads JSON on
// stdin (`session_id`, `tool_name`, `tool_input.file_path`, absolute for Write
// and Edit) and prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
// "additionalContext":"…"}}`, which Claude Code hands the agent beside the
// tool's result.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_EXCLUDE, loadConfig } from '../analyzer/config.ts'
import type { Config } from '../analyzer/config.ts'
import { analyzeIsolated } from '../analyzer/isolated.ts'
import { CODE } from '../core/first-look.ts'
import { matcher } from '../core/glob.ts'
import { fileId } from '../core/ids.ts'
import type { Graph } from '../core/model.ts'
import type { Place } from '../core/query.ts'
import { decodeGraph } from '../core/serialize.ts'
import type { SerializedGraph } from '../core/serialize.ts'
import { existingFileNotes, hookOutput, newFileNotes } from './hook-notes.ts'
import type { AskMore } from './hook-notes.ts'
import { countFiles } from './output.ts'
import { projectDir } from '../analyzer/config.ts'
import { DEFAULT_PROJECTS, ProjectList, defaultOut } from './projects.ts'
import { locate, queryFor } from './query.ts'
import { ENTRY, invokedAs, shellPath } from './self.ts'

export const HOOK_COMMANDS = ['install', 'uninstall', 'status', 'pre-write'] as const
export type HookCommand = (typeof HOOK_COMMANDS)[number]

/** The tools that write files. */
export const MATCHER = 'Write|Edit|MultiEdit'
/** Seconds Claude Code waits for the hook; a hook that times out doesn't block the tool. */
export const TIMEOUT_S = 15
/** The hook gives up on an analysis after this long (under the timeout); a background run then brings the cache up to date. */
const ANALYSIS_BUDGET_MS = 10_000
/** A background analysis started this recently isn't started again. */
const WARMING_MS = 2 * 60_000
/** Our entry in the settings: the command holds this. */
const MARK = 'hook pre-write'
/** The hook's command: archrift as it was started for `hook install` (`archrift`, `npx archrift` or `node <entry>`). */
export const hookCommand = (cli = invokedAs()) => `${cli} ${MARK}`

// ── settings ──────────────────────────────────────────────────────────────

type Json = Record<string, unknown>
export type Settings = Json

const isObject = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x)
const ours = (h: unknown) => isObject(h) && typeof h.command === 'string' && h.command.includes(MARK)

/** The settings file: personal (`settings.local.json`, not committed) or shared with the repo (`settings.json`). */
export const settingsPath = (dir: string, shared: boolean) => path.join(dir, '.claude', shared ? 'settings.json' : 'settings.local.json')

/** Where `install` writes by default: the git top-level of the folder (where Claude Code runs), else the folder. */
export function defaultDir(cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd
  } catch {
    return cwd
  }
}

export interface HookEntry {
  matcher?: string
  command: string
  timeout?: number
}

/** Our entries in the settings' PreToolUse hooks. */
export function entriesOf(settings: Settings): HookEntry[] {
  const pre = isObject(settings.hooks) ? settings.hooks.PreToolUse : undefined
  if (!Array.isArray(pre)) return []
  return pre.filter(isObject).flatMap(g =>
    (Array.isArray(g.hooks) ? g.hooks : []).filter(ours).map(h => {
      const handler = h as Json
      return { ...(typeof g.matcher === 'string' ? { matcher: g.matcher } : {}), command: handler.command as string, ...(typeof handler.timeout === 'number' ? { timeout: handler.timeout } : {}) }
    }),
  )
}

/** A matcher group without our handler; undefined when that leaves it empty. */
function strip(group: unknown): unknown {
  if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(ours)) return group
  const hooks = group.hooks.filter(h => !ours(h))
  return hooks.length ? { ...group, hooks } : undefined
}

/** The settings without our hook; the PreToolUse list and the hooks object go when that empties them. Everything else stays, in order. */
export function withoutHook(settings: Settings): Settings {
  if (!entriesOf(settings).length) return settings
  const next = structuredClone(settings)
  const hooks = next.hooks as Json
  const pre = (hooks.PreToolUse as unknown[]).map(strip).filter(g => g !== undefined)
  if (pre.length) hooks.PreToolUse = pre
  else delete hooks.PreToolUse
  if (!Object.keys(hooks).length) delete next.hooks
  return next
}

/** The settings with our hook (once): a PreToolUse group of its own. */
export function withHook(settings: Settings, command = hookCommand()): Settings {
  const next = structuredClone(withoutHook(settings))
  if (next.hooks !== undefined && !isObject(next.hooks)) throw new Error('"hooks" is not an object')
  const hooks = (next.hooks ??= {}) as Json
  if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse)) throw new Error('"hooks.PreToolUse" is not a list')
  const pre = (hooks.PreToolUse ??= []) as unknown[]
  pre.push({ matcher: MATCHER, hooks: [{ type: 'command', command, timeout: TIMEOUT_S }] })
  return next
}

function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {}
  const data = jsonOf(fs.readFileSync(file, 'utf8'))
  if (!data) throw new Error(`${file} doesn't hold a JSON object (left as it is)`)
  return data
}

function writeSettings(file: string, settings: Settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}

const kindOf = (shared: boolean) => (shared ? 'shared: committed with the repo' : 'personal: not committed')
const entryLine = (e: HookEntry) => `PreToolUse ${e.matcher ?? '(every tool)'} → ${e.command}${e.timeout ? ` (timeout ${e.timeout} s)` : ''}`

/** Whether git ignores the file; undefined outside a repository. */
function gitIgnores(file: string): boolean | undefined {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: path.dirname(path.dirname(file)), stdio: 'ignore' })
    return true
  } catch (e) {
    return (e as { status?: number }).status === 1 ? false : undefined
  }
}

export interface HookPlace {
  /** The folder Claude Code runs in. */
  dir: string
  shared: boolean
  /** The command to install (default: this checkout's). */
  command?: string
}

/** Our entry alone, as this checkout installs it. */
const current = (found: HookEntry[], command: string) => found.length === 1 && found[0].command === command && found[0].matcher === MATCHER && found[0].timeout === TIMEOUT_S

function installedText(file: string, command: string, o: HookPlace): string {
  const lines = [
    `archrift hook installed in ${file} (${kindOf(o.shared)}).`,
    'Before Claude Code writes or edits a code file of an archrift project, archrift puts its notes on the file',
    "(its rules, how its folder does common jobs) into the agent's context. New sessions run it.",
    `  ${entryLine({ matcher: MATCHER, command, timeout: TIMEOUT_S })}`,
    `Remove it with: archrift hook uninstall${o.shared ? ' --shared' : ''}`,
  ]
  if (!o.shared && gitIgnores(file) === false) lines.push(`Note: git doesn't ignore ${path.relative(o.dir, file)} here; add it to .gitignore to keep it out of commits.`)
  return `${lines.join('\n')}\n`
}

/** `hook install`: adds our entry to the settings file, keeping everything else. */
export function install(o: HookPlace): string {
  const file = settingsPath(o.dir, o.shared)
  const command = o.command ?? hookCommand()
  const settings = readSettings(file)
  if (current(entriesOf(settings), command)) return `archrift hook: already installed in ${file}\n`
  writeSettings(file, withHook(settings, command))
  return installedText(file, command, o)
}

/** `hook uninstall`: removes only our entry. */
export function uninstall(o: Omit<HookPlace, 'command'>): string {
  const file = settingsPath(o.dir, o.shared)
  const settings = readSettings(file)
  if (!entriesOf(settings).length) return `archrift hook: not installed in ${file}, nothing to remove\n`
  writeSettings(file, withoutHook(settings))
  return `archrift hook removed from ${file}\n`
}

/** `hook status`: where it is installed, and the command. */
export function status(o: { dir: string; command?: string }): string {
  const command = o.command ?? hookCommand()
  const lines: string[] = []
  for (const shared of [false, true]) {
    const file = settingsPath(o.dir, shared)
    for (const e of entriesOf(readSettings(file))) {
      lines.push(`archrift hook: installed in ${file} (${kindOf(shared)})`, `  ${entryLine(e)}`)
      if (e.command !== command) lines.push(`  (not this checkout's command, ${command}: archrift hook install${shared ? ' --shared' : ''} updates it)`)
    }
  }
  if (!lines.length) lines.push(`archrift hook: not installed in ${o.dir} (.claude/settings.local.json, .claude/settings.json); archrift hook install adds it`)
  return `${lines.join('\n')}\n`
}

// ── pre-write ─────────────────────────────────────────────────────────────

export interface PreWriteOptions {
  /** The project list (default: ~/.config/archrift/projects.json). */
  projects?: string
  /** Where each session's files are kept (default: <tmp>/archrift-hook). */
  stateDir?: string
  /** The command the notes say to ask (default: archrift as the hook started it). */
  cli?: string
  /** Starts the background analysis that brings the cache up to date (tests replace it). */
  warm?: (project: Project) => void
  budgetMs?: number
}

function jsonOf(text: string): Json | undefined {
  try {
    const data: unknown = JSON.parse(text)
    return isObject(data) ? data : undefined
  } catch {
    return undefined
  }
}

/** What the hook reads from Claude Code: the session and the file about to be written (absolute). */
export function parseInput(stdin: string): { session: string; file: string } | undefined {
  const data = jsonOf(stdin) ?? {}
  const file = isObject(data.tool_input) ? data.tool_input.file_path : undefined
  if (typeof file !== 'string' || !path.isAbsolute(file)) return undefined
  return { session: typeof data.session_id === 'string' ? data.session_id : '', file: path.normalize(file) }
}

export interface Project {
  root: string
  config: Config
  /** The config file, when it isn't `<root>/.archrift/config.json`. */
  configFile: string | undefined
  /** graph.json; the cache is beside it. */
  out: string
  /** Its name in the project list, when it's listed. */
  listed: string | undefined
  /** The file, relative to the root. */
  rel: string
}

/** The file's path from the root, when it is under it. */
function relativeIn(root: string, file: string): string | undefined {
  const rel = path.relative(root, file).split(path.sep).join('/')
  return rel === '' || rel === '..' || rel.startsWith('../') ? undefined : rel
}

/** The archrift project a file is in (listed, or a folder up with .archrift/config.json), when it is in one. */
export function projectOf(file: string, projects = DEFAULT_PROJECTS): Project | undefined {
  const where = locate({ cwd: path.dirname(file), projects })
  const listed = new ProjectList(projects).all().find(p => p.root === where.root)?.name
  if (!listed && !fs.existsSync(path.join(projectDir(where.root), 'config.json'))) return undefined
  const rel = relativeIn(where.root, file)
  if (!rel) return undefined
  const config = loadConfig(where.root, where.config)
  const out = path.resolve(where.out ?? defaultOut(config.name ?? path.basename(where.root), where.root))
  return { root: where.root, config, configFile: where.config, out, listed, rel }
}

/** A code file the analysis reads: TS/JS, Kotlin or Go, not excluded, and included when the config says what to include. */
export function analyzes(rel: string, config: Config): boolean {
  if (!CODE.test(rel) || matcher([...DEFAULT_EXCLUDE, ...config.exclude])(rel)) return false
  return !config.include || matcher(config.include)(rel)
}

/** The files a session got notes for, kept between the hook's runs. */
export function sessionFile(stateDir: string, session: string): string {
  return path.join(stateDir, `${session.replace(/[^\w.-]/g, '_').slice(0, 120) || 'no-session'}.json`)
}

function seenIn(file: string): string[] {
  try {
    const files = (JSON.parse(fs.readFileSync(file, 'utf8')) as { files?: unknown }).files
    return Array.isArray(files) ? files.filter(f => typeof f === 'string') : []
  } catch {
    return []
  }
}

function remember(file: string, seen: string[], add: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ files: [...seen, add] })}\n`)
}

/** The project's written graph, when there is one that reads. */
function writtenGraph(out: string): Graph | undefined {
  try {
    return decodeGraph(JSON.parse(fs.readFileSync(out, 'utf8')) as SerializedGraph)
  } catch {
    return undefined
  }
}

/** The promise's value, or undefined when it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>(resolve => (timer = setTimeout(() => resolve(undefined), ms)))
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * The graph to answer from: the project's written graph (fast, perhaps a little behind), else a
 * fresh analysis from the cache. With no cache yet, or an analysis that takes too long, nothing:
 * a background run brings the cache up to date for the next file.
 */
async function graphOf(p: Project, o: PreWriteOptions): Promise<Graph | undefined> {
  const written = writtenGraph(p.out)
  if (written) return written
  const warm = o.warm ?? (project => warmUp(project, o.stateDir ?? STATE_DIR))
  const cacheDir = path.join(path.dirname(p.out), 'cache')
  if (!fs.existsSync(path.join(cacheDir, 'fragments.json'))) return void warm(p)
  const analysis = analyzeIsolated({ root: p.root, config: p.config, files: countFiles(p.root, p.config), cacheDir, history: false })
  const graph = await within(analysis, o.budgetMs ?? ANALYSIS_BUDGET_MS)
  if (!graph) warm(p)
  return graph
}

const STATE_DIR = path.join(os.tmpdir(), 'archrift-hook')

/** Analyzes the project in a process of its own that outlives the hook, so the next file finds the cache up to date. Once in a while. */
function warmUp(p: Project, stateDir: string) {
  const marker = path.join(stateDir, `warming-${createHash('sha1').update(p.root).digest('hex').slice(0, 12)}`)
  if (fs.existsSync(marker) && Date.now() - fs.statSync(marker).mtimeMs < WARMING_MS) return
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(marker, '')
  const args = [ENTRY, 'query', 'overview', '--root', p.root, '--out', p.out, '--no-history', ...(p.configFile ? ['--config', p.configFile] : [])]
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
}

/** The notes for the file: an existing file's (as the graph has it), else a new one's. */
export function notesText(graph: Graph, p: Project, cli = invokedAs()): string {
  const q = queryFor(graph, p.config)
  const node = q.index.node(fileId(p.rel))
  const ask: AskMore = { cli, project: p.listed ? `--project ${p.listed}` : `--root ${shellPath(p.root)}` }
  if (node?.kind === 'file') {
    const place: Place & { kind: 'file' } = { kind: 'file', path: p.rel, id: node.id }
    return existingFileNotes(q.file(place), q.ways(place), ask)
  }
  const place: Place = { kind: 'new', path: p.rel }
  return newFileNotes(q.rules(place), q.ways(place), ask)
}

async function notesFor(stdin: string, o: PreWriteOptions): Promise<string> {
  const input = parseInput(stdin)
  const project = input && projectOf(input.file, o.projects)
  if (!input || !project || !analyzes(project.rel, project.config)) return ''
  const state = sessionFile(o.stateDir ?? STATE_DIR, input.session)
  const seen = seenIn(state)
  if (seen.includes(input.file)) return ''
  const graph = await graphOf(project, o)
  if (!graph) return ''
  const text = notesText(graph, project, o.cli)
  remember(state, seen, input.file)
  return hookOutput(text)
}

/** `hook pre-write`: the hook's output for Claude Code, or nothing. Never throws: a problem prints nothing (ARCHRIFT_HOOK_DEBUG=1 says what on stderr). */
export async function preWrite(stdin: string, o: PreWriteOptions = {}): Promise<string> {
  try {
    return await notesFor(stdin, o)
  } catch (e) {
    if (process.env.ARCHRIFT_HOOK_DEBUG) process.stderr.write(`archrift hook: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    return ''
  }
}
