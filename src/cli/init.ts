// `archrift init <folder>`: the first look at a project archrift hasn't seen.
// It reads what the project is made of (analyzer/detect.ts), analyzes it,
// proposes the layers its folders already keep and the starter rules, all
// errors (core/first-look.ts), writes the config into the project
// (`.archrift/config.json`, the results beside it, git ignoring them), adds it
// to the project list, and reports what it found: on stdout, and as
// first-look.md and first-look.html beside the results. A project that has a
// config keeps it: init then only analyzes and reports again (--force starts over).
import fs from 'node:fs'
import path from 'node:path'
import { ConfigSchema, loadConfig } from '../analyzer/config.ts'
import type { Config } from '../analyzer/config.ts'
import { detectProject } from '../analyzer/detect.ts'
import type { Detection } from '../analyzer/detect.ts'
import { analyzeIsolated } from '../analyzer/isolated.ts'
import { firstLook, shapeOf, starterRules } from '../core/first-look.ts'
import type { FirstLook } from '../core/first-look.ts'
import { matcher } from '../core/glob.ts'
import type { Graph } from '../core/model.ts'
import type { Rule } from '../core/rules.ts'
import { coherenceOf } from './coherence.ts'
import { firstLookMarkdown, firstLookText } from './first-look.ts'
import { firstLookHtml } from './first-look-html.ts'
import { countFiles, writeGraph } from './output.ts'
import { projectDir } from '../analyzer/config.ts'
import { ProjectList } from './projects.ts'
import { invokedAs } from './self.ts'

export interface InitOptions {
  root: string
  /** The project list to add it to. */
  projects: string
  force: boolean
  dryRun: boolean
  history: boolean
  cache: boolean
  format: 'text' | 'json' | 'markdown'
  log: (msg: string) => void
  now?: Date
}

/** What git should keep of `.archrift/`: the config, and the descriptions written for the code (`archrift describe`). */
const GITIGNORE = `# archrift (archrift init): the analysis results stay local; the config and the descriptions are meant for git
*
!.gitignore
!config.json
!descriptions.json
`

export async function runInit(o: InitOptions): Promise<{ text: string; code: number }> {
  const root = path.resolve(o.root)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`init: not a folder: ${root}`)
  const dir = projectDir(root)
  const configFile = path.join(dir, 'config.json')
  const keep = fs.existsSync(configFile) && !o.force
  const now = o.now ?? new Date()
  if (!o.dryRun) {
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE)
  }

  o.log(`archrift init: reading ${root}`)
  const detection = detectProject(root)
  const analyze = (config: Config) =>
    analyzeIsolated({ root, config, files: countFiles(root, config), cacheDir: o.dryRun || !o.cache ? false : path.join(dir, 'cache'), history: o.history, log: o.log })

  let config: Config
  let written: object | undefined
  let graph: Graph
  if (keep) {
    config = loadConfig(root)
    graph = await analyze(config)
  } else {
    const proposed = await propose(detection, analyze)
    ;({ config, graph } = proposed)
    written = proposed.raw
    if (!o.dryRun) fs.writeFileSync(configFile, `${JSON.stringify(written, null, 2)}\n`)
  }

  const notes = [...detection.notes]
  const reports = o.dryRun ? undefined : ['first-look.html', 'first-look.md'].map(f => path.join('.archrift', f))
  if (!o.dryRun) {
    writeGraph(graph, path.join(dir, 'graph.json'))
    const list = new ProjectList(o.projects)
    const elsewhere = list.all().find(p => p.root === root && p.config && path.resolve(p.config) !== configFile)
    const project = list.add({ root })
    if (elsewhere) notes.push(`the project list names ${elsewhere.config} as ${project.name}'s config, so serve, query and diff still use that one: remove its "config" from ${list.file} to use .archrift/config.json`)
  }

  const look = report(graph, config, detection, { root, notes, status: keep ? 'kept' : o.dryRun ? 'dry-run' : 'written', now })
  const commands = { cli: invokedAs(), root: tilde(root), reports }
  if (!o.dryRun) {
    fs.writeFileSync(path.join(dir, 'first-look.md'), firstLookMarkdown(look, commands))
    fs.writeFileSync(path.join(dir, 'first-look.html'), firstLookHtml(look, commands))
  }
  const text =
    o.format === 'json' ? `${JSON.stringify({ ...look, ...(o.dryRun ? { proposedConfig: written } : {}) }, null, 2)}\n` : o.format === 'markdown' ? firstLookMarkdown(look, commands) : firstLookText(look, commands, o.dryRun ? written : undefined)
  return { text, code: 0 }
}

/**
 * The config from what was detected: analyzed once as it is, then with the layers
 * its blocks keep and the starter rules, so the report counts what breaks them.
 */
async function propose(detection: Detection, analyze: (config: Config) => Promise<Graph>): Promise<{ raw: object; config: Config; graph: Graph }> {
  const base = {
    name: detection.name,
    ...(detection.tsconfig ? { tsconfig: detection.tsconfig } : {}),
    ...(detection.exclude.length ? { exclude: detection.exclude.map(e => e.glob) } : {}),
    tests: detection.tests,
    ...(detection.entrypoints.length ? { entrypoints: detection.entrypoints } : {}),
  }
  const first = await analyze(ConfigSchema.parse(base))
  const shape = shapeOf(first)
  const rules = starterRules(shape, detection.vendored.map(v => v.glob))
  const layered = { ...base, ...(shape.layers.length ? { layers: shape.layers.map(l => ({ name: l.name, match: l.match })) } : {}) }
  const graph = await analyze(ConfigSchema.parse({ ...layered, rules }))
  const raw = { ...layered, rules }
  return { raw, config: ConfigSchema.parse(raw), graph }
}

function report(graph: Graph, config: Config, detection: Detection, o: { root: string; notes: string[]; status: FirstLook['config']['status']; now: Date }): FirstLook {
  const ui = uiGlobs(config.rules)
  const isUi = matcher(ui)
  const isVendored = matcher(detection.vendored.map(v => v.glob))
  return firstLook({
    graph,
    coherence: coherenceOf(graph),
    root: o.root,
    stack: detection.stack,
    notes: o.notes,
    config: { path: path.join('.archrift', 'config.json'), status: o.status },
    excluded: config.exclude.map(glob => ({ glob, why: detection.exclude.find(e => e.glob === glob)?.why ?? 'the config leaves it out' })),
    vendored: detection.vendored,
    ui,
    isUi: p => isUi(p),
    isVendored: p => isVendored(p),
    now: o.now,
  })
}

/** The UI blocks: what the config's functions-small-ui rule covers. */
function uiGlobs(rules: readonly Rule[]): string[] {
  const rule = rules.find(r => r.name === 'functions-small-ui')
  return rule && 'limit' in rule && 'functions' in rule.limit ? [rule.limit.functions].flat() : []
}

const tilde = (p: string) => {
  const home = process.env.HOME
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p
}
