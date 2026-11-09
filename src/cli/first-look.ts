// `archrift init`'s report, as text (the terminal) and markdown (a file to keep
// or paste), and the lines that set up a coding agent. The HTML page is in
// first-look-html.ts.
import type { FirstLook } from '../core/first-look.ts'
import { LIMITS } from '../core/first-look.ts'

/** The lines for a coding agent's CLAUDE.md or AGENTS.md (docs/QUERY.md), with this checkout's command. */
export function agentBlock(cli: string): string {
  return [
    '## Architecture checks (archrift)',
    '',
    'Before writing code that does a common job (HTTP calls, dates, state, forms,',
    'validation, logging, test doubles …) in a folder, ask how that folder does it',
    'and follow that way:',
    `  ${cli} query ways <folder or new file> --job "<the job in a few words>"`,
    'Before adding an import across folders, check it\'s allowed:',
    `  ${cli} query rules <file> --to <the file or package to import>`,
    'Before changing a widely used file, function or package, see what depends on',
    'it and which tests to run after the change:',
    `  ${cli} query impact <file, folder, path#function or package>`,
    'Before finishing, check what the change does to the architecture, and fix new',
    'rule violations, limits broken further, and files that do a job differently',
    'from their folder (unless moving off a legacy way); an import that brings many',
    'files or a new package into pages (Reach) deserves a second look:',
    `  ${cli} diff`,
    'A function the diff shows past a complexity limit (new, crossing it, or growing',
    `further) is split under the limit in the same change: ${LIMITS.logic} in logic, ${LIMITS.ui} in UI code.`,
    'Before writing tests, see which functions the tests leave riskiest:',
    `  ${cli} query crap <file or folder>`,
    'After adding a file or changing what one exports, keep its description in',
    '.archrift/descriptions.json current (a name only when the code\'s own doesn\'t say',
    'it, one or two sentences on what it is for):',
    `  ${cli} describe todo <folder>, then ${cli} describe set <path> --summary "…"`,
    'When a change is done, write what was asked and why each file changed in',
    '.archrift/changes.json ({ "tasks": [{ "title", "request", "summary", "notes":',
    '{ "<path>": "why" } }] }; it replaces the last one): the viewer\'s Changes panel shows it.',
    'Before changing code a comment ties to a decision (D34, ADR-12), read where it is',
    'defined; after, fix the documents the diff names under Docs:',
    `  ${cli} query docs <file or id>`,
  ].join('\n')
}

export interface Commands {
  /** How to run this archrift: `archrift`, `npx archrift` or `node ~/…/archrift/src/cli/main.ts`. */
  cli: string
  /** The project folder, as the user may type it. */
  root: string
  /** Where the reports went, relative to the root; none on a dry run. */
  reports?: string[]
}

const n = (x: number) => x.toLocaleString('en-US')
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`

/** The stack, sizes and history in a line or two. */
function overview(f: FirstLook): string[] {
  const size = [`${plural(f.size.files, 'file')} of code (${n(f.size.loc)} lines)`, plural(f.size.tests, 'test file'), plural(f.size.functions, 'function')]
  if (f.history) size.push(`${plural(f.history.commits, 'commit')} by ${plural(f.history.authors, 'author')}, ${f.history.since} to ${f.history.until}`)
  return [f.stack.join(' · '), size.join(' · ')]
}

const configLine = (f: FirstLook) =>
  f.config.status === 'written'
    ? `wrote ${f.config.path}: every line of it is a guess from this first look, made to be edited`
    : f.config.status === 'kept'
      ? `kept ${f.config.path} as it is (init --force writes a new one)`
      : `a dry run: nothing written (the config follows below)`

function ruleLine(r: FirstLook['rules'][number]): string {
  const mark = r.broken ? (r.severity === 'error' ? '✗' : '!') : '✓'
  const state = r.broken ? `${n(r.broken)} broken` : 'held'
  return `${mark} ${r.name} (${r.severity}): ${state}`
}

const blockLine = (b: FirstLook['blocks'][number]) => `${b.path} (${plural(b.files, 'file')}, ${n(b.loc)} lines${b.ui ? ', UI' : ''})`

/** `1 file uses it`, `206 files use it`. */
export const usedBy = (files: number) => `${plural(files, 'file')} ${files === 1 ? 'uses' : 'use'} it`

/** `src/components 187 · src/app 17`. */
export const blockCounts = (blocks: FirstLook['bridges'][number]['above']) => blocks.map(b => `${b.block} ${n(b.files)}`).join(' · ')

/** What the bridges section says they are. */
export const BRIDGES_ABOUT = 'the files the most shortest dependency paths between two other files run through, tying blocks together (a change there ripples furthest)'

/** What the questions section says they are. */
export const QUESTIONS_ABOUT = 'what the analysis points at but can\'t answer (the code, or the people who wrote it, can)'

function bridgeLines(f: FirstLook): string[] {
  if (!f.bridges.length) return []
  const out = ['', `Bridges: ${BRIDGES_ABOUT}`]
  f.bridges.forEach((b, i) =>
    out.push(
      `  ${String(i + 1).padStart(2)}. ${b.path}  (${b.block})  betweenness ${b.score} · ${usedBy(b.fanIn)} · it uses ${n(b.fanOut)}`,
      `      used by ${blockCounts(b.above) || 'nothing'}; uses ${blockCounts(b.below) || 'nothing'}`,
    ),
  )
  return out
}

function questionLines(f: FirstLook): string[] {
  if (!f.questions.length) return []
  const out = ['', `Questions worth asking: ${QUESTIONS_ABOUT}`]
  f.questions.forEach((q, i) => out.push(`  ${String(i + 1).padStart(2)}. ${q.question}  (${q.type})`, `      ${q.why}`))
  return out
}

export function firstLookText(f: FirstLook, c: Commands, config?: object): string {
  const out: string[] = [`archrift init ${f.project}`, ...overview(f).map(l => `  ${l}`), `  ${configLine(f)}`]
  if (f.config.status !== 'dry-run') out.push('  results go to .archrift/ beside it (git ignores all of them but the config)')
  for (const note of f.notes) out.push(`  ! ${note}`)

  if (f.excluded.length || f.vendored.length) {
    out.push('', 'Left out of the analysis')
    for (const e of f.excluded) out.push(`  ${e.glob}  ${e.why}`)
    for (const v of f.vendored) out.push(`  (analyzed, held to no limit) ${v.glob}  ${v.what}`)
  }
  if (f.layers.length) {
    out.push('', 'Layers, top to bottom: each block imports only from its own level or below (as the code does today)')
    for (const l of f.layers) out.push(`  ${l.name}`, ...l.blocks.map(b => `    ${blockLine(b)}`))
  }
  if (f.blocks.length) {
    out.push('', f.layers.length ? 'Blocks in no layer' : 'Blocks (no layering: they import each other in a circle, or not at all)')
    for (const b of f.blocks) out.push(`  ${blockLine(b)}`)
  }

  out.push('', `Import cycles: ${n(f.cycles.count)}`)
  for (const c of f.cycles.largest) out.push(`  ${plural(c.length, 'file')}: ${c.slice(0, 6).join(' → ')}${c.length > 6 ? ' → …' : ''}`)

  if (f.hotspots.length) {
    out.push('', 'Hotspots: lines changed lately × complexity (changing a lot, and hard to change)')
    f.hotspots.forEach((h, i) => out.push(`  ${String(i + 1).padStart(2)}. ${h.path}  ${plural(h.commits, 'commit')} · complexity ${n(h.complexity)} · ${n(h.loc)} lines`))
  }
  out.push(...bridgeLines(f))

  if (f.coherence.mixed.length || f.coherence.one.length) {
    out.push('', 'Jobs done several ways (archrift coherence has the detail)')
    if (!f.coherence.mixed.length) out.push('  none: each job is done one way')
    for (const m of f.coherence.mixed) out.push(`  ${m.label}: ${m.ways.map(w => `${w.label} ${n(w.files)}`).join(' · ')}${m.blocks.length ? `  (mixed in ${m.blocks.join(', ')})` : ''}`)
    if (f.coherence.one.length) out.push(`  one way: ${f.coherence.one.map(o => `${o.label.replace(/^\w+ · /, '')} (${o.way})`).join(' · ')}`)
  }

  out.push('', `Function complexity: ${f.functions.bands.map(b => `${b.label}: ${n(b.count)}`).join(' · ')}  (limits: ${LIMITS.logic} in logic, ${LIMITS.ui} in UI)`)
  f.functions.largest.forEach((fn, i) => out.push(`  ${String(i + 1).padStart(2)}. ${fn.name}  ${fn.path}:${fn.line}  complexity ${n(fn.complexity)}${fn.ui ? ' (UI)' : ''}`))

  out.push('', `Dead exports (nothing imports them): ${n(f.deadExports.count)}`)
  if (f.deadExports.folders.length) out.push(`  ${f.deadExports.folders.map(d => `${d.folder} ${n(d.count)}${d.vendored ? ' (copied in)' : ''}`).join(' · ')}`)

  if (f.rules.length) {
    out.push('', 'Rules, all errors (archrift check lists every case)')
    for (const r of f.rules) out.push(`  ${ruleLine(r)}`)
  }
  out.push(...questionLines(f))

  out.push('', 'Next', ...nextSteps(c).map(s => `  ${s}`))
  if (config) out.push('', 'The config init would write to .archrift/config.json:', JSON.stringify(config, null, 2))
  out.push('', 'For a coding agent in this project, add to its CLAUDE.md or AGENTS.md:', '', ...agentBlock(c.cli).split('\n').map(l => `  ${l}`))
  return `${out.join('\n')}\n`
}

function nextSteps(c: Commands): string[] {
  return [
    `${c.cli} serve ${c.root} --open   the 3D viewer, with the arc42 views`,
    `${c.cli} check ${c.root}   every rule and every case that breaks it`,
    `${c.cli} coherence ${c.root}   how many ways the code does each job`,
    `in the project: ${c.cli} query file <path> · query crap <folder> (after a coverage run) · diff (before finishing a change)`,
    ...(c.reports?.length ? [`the report, to keep or share: ${c.reports.join(' · ')}`] : []),
  ]
}

const cell = (s: string) => s.replace(/\|/g, '\\|')

export function firstLookMarkdown(f: FirstLook, c: Commands): string {
  const out: string[] = [`# ${f.project}: first look`, '', `archrift init, ${f.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, '', ...overview(f).map(l => `- ${l}`), `- ${configLine(f)}`]
  for (const note of f.notes) out.push(`- **Note:** ${note}`)

  if (f.excluded.length || f.vendored.length) {
    out.push('', '## Left out of the analysis', '', '| Files | Why |', '|---|---|')
    for (const e of f.excluded) out.push(`| \`${e.glob}\` | ${cell(e.why)} |`)
    for (const v of f.vendored) out.push(`| \`${v.glob}\` | ${cell(v.what)}: analyzed, held to no limit |`)
  }
  if (f.layers.length) {
    out.push('', '## Layers', '', 'Top to bottom: each block imports only from its own level or below, as the code does today.', '', '| Layer | Blocks |', '|---|---|')
    for (const l of f.layers) out.push(`| ${cell(l.name)} | ${l.blocks.map(b => cell(blockLine(b))).join('<br>')} |`)
  }
  if (f.blocks.length) {
    out.push('', f.layers.length ? '## Blocks in no layer' : '## Blocks', '', ...(f.layers.length ? [] : ['No layering: the blocks import each other in a circle, or not at all.', '']))
    for (const b of f.blocks) out.push(`- ${blockLine(b)}`)
  }

  out.push('', '## Import cycles', '', `${n(f.cycles.count)} in all.`)
  if (f.cycles.largest.length) out.push('', ...f.cycles.largest.map(c => `- ${plural(c.length, 'file')}: ${c.slice(0, 6).map(p => `\`${p}\``).join(' → ')}${c.length > 6 ? ' → …' : ''}`))

  if (f.hotspots.length) {
    out.push('', '## Hotspots', '', 'Lines changed lately × complexity: code that changes a lot and is hard to change.', '', '| # | File | Commits | Complexity | Lines |', '|---:|---|---:|---:|---:|')
    f.hotspots.forEach((h, i) => out.push(`| ${i + 1} | \`${h.path}\` | ${n(h.commits)} | ${n(h.complexity)} | ${n(h.loc)} |`))
  }
  out.push(...bridgeMarkdown(f))

  if (f.coherence.mixed.length || f.coherence.one.length) {
    out.push('', '## Jobs done several ways', '')
    if (!f.coherence.mixed.length) out.push('None: each job is done one way.')
    for (const m of f.coherence.mixed) out.push(`- **${m.label}:** ${m.ways.map(w => `${w.label} ${n(w.files)}`).join(' · ')}${m.blocks.length ? ` (mixed in ${m.blocks.map(b => `\`${b}\``).join(', ')})` : ''}`)
    if (f.coherence.one.length) out.push('', `Done one way: ${f.coherence.one.map(o => `${o.label.replace(/^\w+ · /, '')} (${o.way}, ${plural(o.files, 'file')})`).join(' · ')}.`)
  }

  out.push('', '## Function complexity', '', `The limits: ${LIMITS.logic} in logic, ${LIMITS.ui} in UI code.`, '', `| ${f.functions.bands.map(b => b.label).join(' | ')} |`, `|${f.functions.bands.map(() => '---:').join('|')}|`, `| ${f.functions.bands.map(b => n(b.count)).join(' | ')} |`)
  if (f.functions.largest.length) {
    out.push('', '| # | Function | Where | Complexity |', '|---:|---|---|---:|')
    f.functions.largest.forEach((fn, i) => out.push(`| ${i + 1} | ${cell(fn.name)}${fn.ui ? ' (UI)' : ''} | \`${fn.path}:${fn.line}\` | ${n(fn.complexity)} |`))
  }

  out.push('', '## Dead exports', '', `${n(f.deadExports.count)} exports nothing imports.`)
  if (f.deadExports.folders.length) out.push('', ...f.deadExports.folders.map(d => `- \`${d.folder}\`: ${n(d.count)}${d.vendored ? ' (copied in)' : ''}`))

  if (f.rules.length) {
    out.push('', '## Rules', '', 'Every rule is an error: `check` fails until the code keeps it, and `diff` fails on a change that breaks it again or further.', '', '| Rule | Severity | Today |', '|---|---|---|')
    for (const r of f.rules) out.push(`| ${r.name} | ${r.severity} | ${r.broken ? `${n(r.broken)} broken` : 'held'} |`)
  }
  out.push(...questionMarkdown(f))

  out.push('', '## Next', '', ...nextSteps(c).map(s => `- ${s.replace(/^(.*?)( {3})/, '`$1` ')}`))
  out.push('', '## For a coding agent', '', 'Add to the project\'s CLAUDE.md or AGENTS.md:', '', '```markdown', agentBlock(c.cli), '```')
  return `${out.join('\n')}\n`
}

function bridgeMarkdown(f: FirstLook): string[] {
  if (!f.bridges.length) return []
  const out = ['', '## Bridges', '', `${BRIDGES_ABOUT[0].toUpperCase()}${BRIDGES_ABOUT.slice(1)}.`, '', '| # | File | Block | Betweenness | Fan-in | Fan-out | Used by | Uses |', '|---:|---|---|---:|---:|---:|---|---|']
  f.bridges.forEach((b, i) => out.push(`| ${i + 1} | \`${b.path}\` | \`${b.block}\` | ${b.score} | ${n(b.fanIn)} | ${n(b.fanOut)} | ${cell(blockCounts(b.above))} | ${cell(blockCounts(b.below))} |`))
  return out
}

function questionMarkdown(f: FirstLook): string[] {
  if (!f.questions.length) return []
  const out = ['', '## Questions worth asking', '', `${QUESTIONS_ABOUT[0].toUpperCase()}${QUESTIONS_ABOUT.slice(1)}.`, '']
  f.questions.forEach((q, i) => out.push(`${i + 1}. ${q.question} _(${q.type})_`, `   - ${q.why}`))
  return out
}
