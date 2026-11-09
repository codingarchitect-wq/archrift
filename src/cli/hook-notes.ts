// The notes `archrift hook pre-write` gives a coding agent before it writes a
// file (docs/GUIDE.md "A hook for Claude Code"): for a new file, the rules its place
// has and how its block does each job; for an existing one, its rules, what it
// breaks now and the jobs it does differently from its block. Plain text made
// from `query` answers, cut to fit the agent's context. Pure: hook.ts reads
// the input and the graph.
import type { Constraint, FileAnswer, JobAnswer, RulesAnswer, WaysAnswer } from '../core/query.ts'
import { violationLine } from './query.ts'

/** Notes are cut to about this many characters (Claude Code moves context past 10,000 into a file). */
export const NOTES_MAX = 3000
/** Example files per job. */
const EXAMPLES = 2
/** Broken rules listed per file. */
const VIOLATIONS = 6
/** Longer lines are cut. */
const LINE_MAX = 300
/** A rule's description is shown when its first sentence is this short. */
const BRIEF_MAX = 90

/** How the notes say to ask more: the CLI as this checkout runs it, and the flag that finds the project. */
export interface AskMore {
  /** `archrift`, `npx archrift` or `node ~/…/archrift/src/cli/main.ts` */
  cli: string
  /** `--root ~/…/app` or `--project app` */
  project: string
}

/** "archrift: architecture notes for src/lib/new.ts (new file, block src/lib, layer logic)" */
export function notesHeader(path: string, facts: (string | false | undefined)[]): string {
  const said = facts.filter(Boolean).join(', ')
  return `archrift: architecture notes for ${path} (${said || 'no block'})`
}

/** The last line: how to ask archrift more about the file. */
export function askLine(path: string, ask: AskMore): string {
  return `Ask archrift more: ${ask.cli} query rules ${path} --to <import> ${ask.project} · ${ask.cli} query ways ${path} --job "<job>" ${ask.project}`
}

/** A rule's description when its first sentence is short enough to say why. */
function brief(description: string | undefined): string {
  const first = description?.split(/(?<=\.)\s/)[0]
  return first && first.length <= BRIEF_MAX ? ` ${first}` : ''
}

/** One rule as it holds for the file: "  must not depend on @tauri-apps/*  [platform-seam, error] Only src/platform talks to Tauri; …" */
export function constraintLine(c: Constraint): string {
  return `  ${c.says}  [${c.rule}, ${c.severity}]${brief(c.description)}`
}

function rulesSection(own: Constraint[]): string[] {
  return own.length ? ['Its rules:', ...own.map(constraintLine)] : ['No rule is about it.']
}

/** One job of the block: "  Dates: use date-fns, as src/lib/a.ts, src/lib/b.ts do" (the legacy way named when it's the block's main one). */
export function jobLine(j: JobAnswer): string | undefined {
  const b = j.blocks[0]
  if (!b) return undefined
  const legacy = b.main && b.main.id !== b.use.id ? ` (${b.main.label} is legacy)` : ''
  const examples = b.examples.slice(0, EXAMPLES)
  const as = examples.length ? `, as ${examples.join(', ')} ${examples.length === 1 ? 'does' : 'do'}` : ''
  return `  ${j.label}: use ${b.use.label}${legacy}${as}`
}

function waysSection(ways: WaysAnswer): string[] {
  const lines = ways.jobs.map(jobLine).filter((l): l is string => !!l)
  return lines.length ? [`How ${ways.blocks[0] ?? 'the project'} does its jobs:`, ...lines] : []
}

/** The block's ways in one line, for a file that exists: "How src/lib does its jobs: Dates → date-fns · HTTP calls → api-client helpers". */
function waysInBrief(ways: WaysAnswer): string[] {
  const said = ways.jobs.filter(j => j.blocks[0]).map(j => `${j.label} → ${j.blocks[0].use.label}`)
  return said.length ? [`How ${ways.blocks[0] ?? 'the project'} does its jobs: ${said.join(' · ')}`] : []
}

function brokenSection(violations: RulesAnswer['violations']): string[] {
  if (!violations.length) return ['Broken now: nothing.']
  const more = violations.length > VIOLATIONS ? [`  … ${violations.length - VIOLATIONS} more (archrift check lists them all)`] : []
  return [`Broken now (${violations.length}):`, ...violations.slice(0, VIOLATIONS).map(v => `  ${violationLine(v)}`), ...more]
}

function differsSection(jobs: FileAnswer['jobs']): string[] {
  const differs = jobs.filter(j => j.differs)
  return differs.length ? ['Jobs it does differently from its block:', ...differs.map(j => `  ${j.label}: it uses ${j.ways.join(' and ')}; its block uses ${j.use}`)] : []
}

/** A file nobody has written yet: the rules its place has, and how its block does each job. */
export function newFileNotes(rules: RulesAnswer, ways: WaysAnswer, ask: AskMore): string {
  const path = rules.place.path
  const block = ways.blocks[0]
  const head = notesHeader(path, ['new file', block && `block ${block}`, rules.layer && `layer ${rules.layer}`])
  return capNotes(head, [...rulesSection(rules.own), ...waysSection(ways)], askLine(path, ask))
}

/** A file that exists: its rules, what it breaks now, the jobs it does differently from its block, and the block's ways. */
export function existingFileNotes(file: FileAnswer, ways: WaysAnswer, ask: AskMore): string {
  const path = file.place.path
  const head = notesHeader(path, [file.block && `block ${file.block}`, file.rules.layer && `layer ${file.rules.layer}`])
  const body = [...rulesSection(file.rules.own), ...brokenSection(file.rules.violations), ...differsSection(file.jobs), ...waysInBrief(ways)]
  return capNotes(head, body, askLine(path, ask))
}

const clip = (line: string) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line)

/** Header, as many body lines as fit in `max` characters (each cut to LINE_MAX), then the last line. */
export function capNotes(head: string, body: string[], foot: string, max = NOTES_MAX): string {
  const lines = body.map(clip)
  const omitted = (n: number) => `  … ${n} more line${n === 1 ? '' : 's'} (ask archrift, below)`
  let room = max - head.length - foot.length - omitted(lines.length).length - 3
  let kept = 0
  while (kept < lines.length && lines[kept].length + 1 <= room) room -= lines[kept++].length + 1
  const rest = lines.length - kept
  return [head, ...lines.slice(0, kept), ...(rest ? [omitted(rest)] : []), foot].join('\n')
}

/** What the hook prints: the notes as context for the agent, beside the tool's result (PreToolUse, exit 0). */
export function hookOutput(text: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })}\n`
}
