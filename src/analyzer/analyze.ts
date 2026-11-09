// Entry point for analysis: config → language analyzers → assembled graph.
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Graph } from '../core/model.ts'
import { assemble } from './assemble.ts'
import { readDocs } from './docs.ts'
import { VERSION, loadConfig, targetsOf } from './config.ts'
import { listFiles } from './files.ts'
import { applyHistory, loadHistory } from './history.ts'
import type { Config } from './config.ts'
import { absPathOf, relPathOf, resolveMounts } from './mounts.ts'
import type { AnalyzeContext, FileFragment, LanguageAnalyzer } from './fragment.ts'
import { PLUGINS } from './plugins/index.ts'
import { goAnalyzer } from './go/analyzer.ts'
import { infraAnalyzer } from './infra/analyzer.ts'
import { jvmAnalyzer } from './jvm/analyzer.ts'
import { tsAnalyzer } from './ts/analyzer.ts'

export const TOOL = { name: 'archrift', version: VERSION }
const ANALYZERS: LanguageAnalyzer[] = [tsAnalyzer, jvmAnalyzer, goAnalyzer, infraAnalyzer]
const TEXT_ASSETS = /\.(css|scss|sass|less|json|svg|html|md|txt|ya?ml|graphql|gql)$/

export interface AnalyzeOptions {
  root: string
  /** Explicit config file; default `<root>/.archrift/config.json` when present. */
  configPath?: string
  /** Pre-loaded config (tests); wins over configPath. */
  config?: Config
  /** Fragment cache directory; false disables caching. */
  cacheDir?: string | false
  /** false skips git history even when the config enables it. */
  history?: boolean
  /** State to reuse between runs (watch mode); create with `new Map()` and pass it every time. */
  session?: Map<string, unknown>
  log?: (msg: string) => void
}

/** What every language analyzer gets: the root, the config, the mounts and the files. */
export function createContext(root: string, config: Config, options: Pick<AnalyzeOptions, 'cacheDir' | 'session' | 'log'> = {}): AnalyzeContext {
  const mounts = resolveMounts(root, config.mounts)
  let files: string[] | undefined
  return {
    root,
    config,
    mounts,
    abs: rel => absPathOf(root, mounts, rel),
    rel: abs => relPathOf(root, mounts, abs),
    files: () => (files ??= listFiles(root, mounts, config)),
    targets: targetsOf(config),
    cacheDir: options.cacheDir === false ? undefined : options.cacheDir,
    log: options.log ?? (() => {}),
    timings: {},
    cacheStats: { hits: 0, misses: 0 },
    session: options.session,
  }
}

export async function analyze(options: AnalyzeOptions): Promise<Graph> {
  const t0 = performance.now()
  const root = path.resolve(options.root)
  const config = options.config ?? loadConfig(root, options.configPath)
  const ctx = createContext(root, config, options)
  const { mounts } = ctx
  const fragments: FileFragment[] = []
  const used = ANALYZERS.filter(a => a.detect(ctx))
  for (const analyzer of used) for await (const f of analyzer.analyze(ctx)) fragments.push(f)

  const t1 = performance.now()
  const graph = assemble({
    name: config.name ?? path.basename(root),
    fragments,
    config,
    targets: ctx.targets,
    analyzers: used.map(a => ({ language: a.id, version: a.version })),
    tool: TOOL,
    assetLoc: rel => {
      if (!TEXT_ASSETS.test(rel)) return undefined
      try {
        return fs.readFileSync(ctx.abs(rel), 'utf8').split('\n').filter(l => l.trim() !== '').length
      } catch {
        return undefined
      }
    },
    root,
    readText: rel => readText(ctx.abs(rel)),
    files: ctx.files,
    plugins: PLUGINS,
    timings: ctx.timings,
    cacheStats: ctx.cacheStats,
  })
  ctx.timings.assemble = Math.round(performance.now() - t1)
  if (mounts.length) graph.meta.mounts = Object.fromEntries(mounts.map(m => [m.name, m.dir]))
  readDocs(graph, { root, config, readCode: rel => readText(ctx.abs(rel)), session: options.session })
  if (options.history !== false && config.history.enabled) {
    const t2 = performance.now()
    const files = new Set(graph.nodes.filter(n => n.kind === 'file').map(n => n.path!))
    const { enabled: _, ...historyOptions } = config.history
    let memo = options.session?.get('history') as Parameters<typeof loadHistory>[4]
    if (options.session && !memo) options.session.set('history', (memo = {}))
    const roots = [{ dir: root, prefix: '' }, ...mounts.map(m => ({ dir: m.dir, prefix: `${m.name}/` }))]
    const history = loadHistory(roots, files, historyOptions, ctx.cacheDir, memo)
    if (history) applyHistory(graph, history)
    ctx.timings.history = Math.round(performance.now() - t2)
  }
  ctx.timings.total = Math.round(performance.now() - t0)
  return graph
}

function readText(abs: string): string | undefined {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return undefined
  }
}
