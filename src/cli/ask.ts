// The Ask bar's engine (core/ask.ts): Claude Code's `claude -p` on this
// machine, run in the project's folder on the user's own sign-in. It may only
// read: Read, Grep, Glob, and `archrift query` (answered from the graph the
// viewer shows, written to disk for it), nothing else; no MCP servers, no
// session kept (a follow-up brings the conversation along). It reports each
// step as it works and ends with an answer in the schema.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ANSWER_SCHEMA, askInstructions, askPrompt, progressOf, resolveAnswer } from '../core/ask.ts'
import type { Answer, AskContext, RawAnswer } from '../core/ask.ts'
import type { Graph } from '../core/model.ts'
import { ENTRY } from './self.ts'

export const CLAUDE_CODE = 'Claude Code'
export const NO_CLAUDE = 'Ask needs the Claude Code CLI (claude) on this machine, signed in: https://docs.claude.com/en/docs/claude-code (or start archrift serve with --claude <path>)'

/** At most this long per question; then the agent is stopped. */
const ASK_TIMEOUT_MS = 5 * 60 * 1000

export interface AskEngine {
  available: boolean
  engine?: string
  /** Why it isn't available. */
  why?: string
  /** The `claude` program. */
  program?: string
}

/** The `claude` program: the one given, else on the PATH, else where its installer puts it. */
export function findClaude(given?: string): AskEngine {
  const runnable = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (given) return runnable(path.resolve(given)) ? { available: true, engine: CLAUDE_CODE, program: path.resolve(given) } : { available: false, why: `no claude program at ${given}` }
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), path.join(os.homedir(), '.local', 'bin')]
  for (const dir of dirs) for (const name of names) if (runnable(path.join(dir, name))) return { available: true, engine: CLAUDE_CODE, program: path.join(dir, name) }
  return { available: false, why: NO_CLAUDE }
}

export interface AskRun {
  program: string
  /** The project's folder: the agent works there. */
  root: string
  /** Its config, when it isn't `<root>/.archrift/config.json`. */
  config?: string
  /** The graph the viewer shows, as written to disk (`archrift query --graph` answers from it). */
  graphFile: string
  graph: Graph
  question: string
  context?: AskContext
  model?: string
  onProgress?: (text: string) => void
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * What the agent may never read, whatever it is asked: environment files, keys and certificates,
 * secrets folders and credentials (what archrift's own config reader never reads either). Deny rules
 * win over the allowed Read, Grep and Glob.
 */
export const SECRETS = ['Read(**/.env*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/*.p12)', 'Read(**/secrets/**)', 'Read(**/certificates/**)', 'Read(**/credentials*)']

/** How the agent asks the map: this checkout's CLI, with the graph and project in its environment. */
export const queryCommand = () => `node ${ENTRY} query`

export function askArgs(o: Pick<AskRun, 'question' | 'context' | 'model'>): string[] {
  const query = queryCommand()
  return [
    '-p',
    askPrompt(o.question, o.context),
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(ANSWER_SCHEMA),
    '--append-system-prompt',
    askInstructions(query),
    '--tools',
    'Read,Grep,Glob,Bash',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    `Bash(${query}:*)`,
    '--disallowedTools',
    ...SECRETS,
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--strict-mcp-config',
    ...(o.model ? ['--model', o.model] : []),
  ]
}

/** One question to the agent: its progress as it works, then the answer checked against the graph. */
export function runAsk(o: AskRun): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.program, askArgs(o), {
      cwd: o.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ARCHRIFT_QUERY_GRAPH: o.graphFile, ARCHRIFT_QUERY_ROOT: o.root, ...(o.config ? { ARCHRIFT_QUERY_CONFIG: o.config } : {}) },
    })
    let done = false
    let structured: RawAnswer | undefined
    let failure: string | undefined
    let stderr = ''
    let buffer = ''
    const finish = (err?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else if (structured) resolve(resolveAnswer(o.graph, o.question, structured))
      else reject(new Error(failure ?? (stderr.trim().split('\n').slice(-3).join(' ') || 'the agent gave no answer')))
    }
    const stop = (why: string) => {
      child.kill('SIGTERM')
      finish(new Error(why))
    }
    const onAbort = () => stop('stopped')
    const timer = setTimeout(() => stop(`no answer within ${Math.round((o.timeoutMs ?? ASK_TIMEOUT_MS) / 1000)} seconds`), o.timeoutMs ?? ASK_TIMEOUT_MS)
    o.signal?.addEventListener('abort', onAbort)
    const onLine = (line: string) => {
      let e: { type?: string; message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] }; structured_output?: RawAnswer; result?: string; is_error?: boolean; subtype?: string }
      try {
        e = JSON.parse(line)
      } catch {
        return
      }
      if (e.type === 'assistant')
        for (const c of e.message?.content ?? []) {
          if (c.type !== 'tool_use' || !c.name) continue
          if (c.name === 'StructuredOutput' && c.input) structured = c.input as RawAnswer
          const text = progressOf(c.name, c.input ?? {}, o.root)
          if (text) o.onProgress?.(text)
        }
      if (e.type === 'result') {
        if (e.structured_output) structured = e.structured_output
        else if (!structured && typeof e.result === 'string') {
          try {
            structured = JSON.parse(e.result) as RawAnswer
          } catch {
            // prose, not the schema
          }
        }
        if (e.is_error) failure = typeof e.result === 'string' && e.result ? e.result : `the agent stopped (${e.subtype ?? 'error'})`
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)))
    child.on('error', err => finish(new Error(`could not start ${o.program}: ${err.message}`)))
    child.on('close', () => {
      if (buffer.trim()) onLine(buffer)
      finish(failure && !structured ? new Error(failure) : undefined)
    })
  })
}
