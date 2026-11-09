// The project hub behind `archrift serve`: opens one project at a time
// (analyzed on a worker, watched with --watch) and switches when the viewer
// asks. A switch analyzes the new project first and lets the old one go only
// when that worked, so a failed switch leaves the open project as it was.
import fs from 'node:fs'
import { DEFAULT_EXCLUDE, loadConfig } from '../analyzer/config.ts'
import { analyzeIsolated, startSession } from '../analyzer/isolated.ts'
import type { AnalysisSession } from '../analyzer/isolated.ts'
import { matcher } from '../core/glob.ts'
import type { Graph } from '../core/model.ts'
import { LiveGraph } from '../server/live.ts'
import type { ProjectEvent, ProjectSummary, ProjectsHandle } from '../server/projects.ts'
import type { Config } from '../analyzer/config.ts'
import type { ChangesRange, ChangesReport, CommitInfo } from '../core/changes.ts'
import { changesReport, recentCommits } from './changes.ts'
import type { Answer, AskContext } from '../core/ask.ts'
import { runAsk } from './ask.ts'
import type { AskEngine } from './ask.ts'
import { countFiles, writeGraph } from './output.ts'
import type { Project, ProjectList } from './projects.ts'
import { watchFiles } from './watch.ts'

export interface HubOptions {
  watch: boolean
  cache: boolean
  history: boolean
  dump?: string
  log: (msg: string) => void
  /** After each project's first analysis (the CLI prints its summary). */
  report?: (graph: Graph, project: Project) => void
  /** The Ask bar's agent (`claude`), when there is one, and the model it asks (its default when none). */
  ask?: AskEngine
  askModel?: string
}

interface Open {
  project: Project
  config: Config
  graph: Graph
  /** The graph last written to the project's graph.json (what `archrift query --graph` reads). */
  written?: Graph
  session?: AnalysisSession
  watcher?: fs.FSWatcher
}

export class ProjectHub implements ProjectsHandle {
  /** Watch mode's new graphs for the open project. */
  readonly live = new LiveGraph()
  private current: Open | undefined
  private opening: string | undefined
  private readonly listeners = new Set<(e: ProjectEvent) => void>()
  /** Bases analyzed for the Changes panel, by project and commit: a commit doesn't change. */
  private readonly bases = new Map<string, Map<string, Graph>>()

  readonly projects: ProjectList
  private readonly options: HubOptions

  constructor(projects: ProjectList, options: HubOptions) {
    this.projects = projects
    this.options = options
  }

  subscribe(fn: (e: ProjectEvent) => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit(e: ProjectEvent) {
    for (const fn of this.listeners) fn(e)
  }

  list() {
    const active = this.current?.project.name
    return { active, opening: this.opening, projects: this.projects.all().map(p => summarize(p, p.name === active)) }
  }

  /** Analyzes a project and makes it the open one; throws when it can't (the old one stays open). */
  async load(name: string): Promise<{ graph: Graph; project: Project }> {
    const project = this.projects.get(name)
    if (!project) throw new Error(`no project named ${name}`)
    const log = (message: string) => {
      this.options.log(message)
      this.emit({ type: 'progress', name, message })
    }
    const config = loadConfig(project.root, project.config)
    const analysis = {
      root: project.root,
      config,
      files: countFiles(project.root, config),
      cacheDir: this.options.cache ? project.cache : (false as const),
      history: this.options.history,
      log,
    }
    const started = this.options.watch ? await startSession(analysis) : undefined
    const graph = started?.graph ?? (await analyzeIsolated(analysis))
    writeGraph(graph, project.out, this.options.dump)
    this.options.report?.(graph, project)

    await this.close()
    const open: Open = { project, config, graph, written: graph, session: started?.session }
    if (started)
      open.watcher = watchFiles(project.root, project.out, matcher([...DEFAULT_EXCLUDE, ...config.exclude]), async changed => {
        const { graph: next, ms } = await started.session.update()
        if (this.current !== open) return // switched away meanwhile
        open.graph = next
        this.live.publish({ graph: next, ms })
        this.options.log(`  updated in ${ms} ms: ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`)
      })
    this.current = open
    this.projects.setActive(name)
    return { graph, project }
  }

  /** The open project's change in progress (`head`: the graph the viewers show), or a range of its commits, against its base. */
  async changes(head: Graph, range: ChangesRange = {}): Promise<ChangesReport> {
    const open = this.current
    if (!open) throw new Error('no project is open')
    const { project } = open
    const bases = this.bases.get(project.name) ?? new Map<string, Graph>()
    this.bases.set(project.name, bases)
    return changesReport({ root: project.root, config: open.config, configPath: project.config, out: project.out, head, range, baseGraphs: bases })
  }

  /** The open project's latest commits, for the Changes panel's range picker. */
  commits(): CommitInfo[] {
    return this.current ? recentCommits(this.current.project.root) : []
  }

  /** A question for the Ask bar's agent, about the open project as the viewers show it. */
  async ask(input: { question: string; context?: AskContext }, onProgress: (text: string) => void, signal: AbortSignal): Promise<Answer> {
    const open = this.current
    const engine = this.options.ask
    if (!open) throw new Error('no project is open')
    if (!engine?.available || !engine.program) throw new Error(engine?.why ?? 'Ask has no agent to ask')
    // the agent asks the map from disk: what the viewers show, live changes included
    if (open.written !== open.graph) {
      writeGraph(open.graph, open.project.out)
      open.written = open.graph
    }
    return runAsk({ program: engine.program, root: open.project.root, config: open.project.config, graphFile: open.project.out, graph: open.graph, question: input.question, context: input.context, model: this.options.askModel, onProgress, signal })
  }

  open(name: string) {
    if (this.opening) throw new Error(`already opening ${this.opening}`)
    if (!this.projects.get(name)) throw new Error(`no project named ${name}`)
    this.opening = name
    this.emit({ type: 'progress', name, message: `Opening ${name}…` })
    this.load(name).then(
      ({ graph, project }) => {
        this.opening = undefined
        this.emit({ type: 'switched', name, root: project.root, graph, views: project.views, snapshots: project.snapshots, descriptions: project.descriptions })
      },
      err => {
        this.opening = undefined
        this.emit({ type: 'failed', name, error: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  add(input: { root: string; name?: string; config?: string }) {
    const project = this.projects.add(input)
    return summarize(project, project.name === this.current?.project.name)
  }

  remove(name: string) {
    if (name === this.current?.project.name) throw new Error(`${name} is open: open another project first`)
    this.projects.remove(name)
  }

  /** Stops watching the open project and lets its worker go. */
  async close() {
    const open = this.current
    this.current = undefined
    open?.watcher?.close()
    await open?.session?.close()
  }
}

function summarize(p: Project, active: boolean): ProjectSummary {
  let analyzedAt: string | undefined
  try {
    analyzedAt = fs.statSync(p.out).mtime.toISOString()
  } catch {
    // never analyzed
  }
  return { name: p.name, root: p.root, config: p.config, active, analyzedAt }
}
