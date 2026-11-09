// archrift command line: `init`, `analyze`, `serve`, `check`, `snapshot`, `coherence`, `query`, `describe`, `diff`, `export` and `hook`.
//
//   archrift init     [root] [--force] [--dry-run] [--no-cache] [--no-history] [--projects file] [--format text|json|markdown] [--quiet]
//   archrift analyze  [root] [--config file] [--out file] [--no-cache] [--no-history] [--dump file] [--quiet]
//   archrift serve    [folder…] [--config file] [--out file] [--views dir] [--projects file] [--port 4300] [--open] [--watch] [--claude path] [--ask-model name]
//   archrift check    [root] [--config file] [--out file] [--no-cache] [--format text|json]
//   archrift snapshot [root] [rev…] [--config file] [--out file] [--count 10] [--every n]
//   archrift coherence [root] [--config file] [--out file] [--no-cache] [--format text|json]
//   archrift query ways|rules|path|file|crap|impact|overview|find|docs <path…> [--job words] [--to path] [--depth n] [--max n] [--graph file] [--root dir | --project name] [--format text|json]
//   archrift describe [status|todo|set|apply|sync] [path…] [--name n] [--summary s] [--max n] [--root dir | --project name] [--format text|json]
//   archrift diff [root] [--base ref] [--head ref] [--strict] [--format text|json|markdown]
//   archrift export html [root] [--view id|link] [--out file] [--source] [--config file] [--project name]
//   archrift export archify <architecture|erd|class> [root] [--database name] [--family name|--folder path] [--out dir] [--config file] [--project name]
//   archrift hook install|uninstall|status|pre-write [--shared] [--dir folder]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { Graph } from '../core/model.ts'
import { decodeGraph } from '../core/serialize.ts'
import type { SerializedGraph, SerializedSites } from '../core/serialize.ts'
import { TOOL } from '../analyzer/analyze.ts'
import { loadConfig } from '../analyzer/config.ts'
import { analyzeIsolated } from '../analyzer/isolated.ts'
import { pickRevisions, resolveRevisions, takeSnapshots } from '../analyzer/snapshots.ts'
import { coherenceJson, coherenceOf, coherenceText } from './coherence.ts'
import { DESCRIBE_COMMANDS, DESCRIBE_EXIT, readDescriptionsFile, runDescribe } from './describe.ts'
import { findClaude } from './ask.ts'
import { HOOK_COMMANDS, defaultDir, install, preWrite, status, uninstall } from './hook.ts'
import type { HookCommand } from './hook.ts'
import { resolveDescriptions } from '../core/descriptions.ts'
import type { DescribeCommand } from './describe.ts'
import { runDiff } from './diff.ts'
import { ARCHIFY_KINDS, exportArchifyText, runExportArchify } from './export-archify.ts'
import type { ArchifyKind } from './export-archify.ts'
import { runExport } from './export-html.ts'
import { runInit } from './init.ts'
import { EXIT, QUESTIONS, answer, locate, queryFor, readCoverage, rootRelative } from './query.ts'
import type { Question } from './query.ts'
import { startServer } from '../server/server.ts'
import { ProjectHub } from './hub.ts'
import { JSON_SCHEMA_VERSION, countFiles, printSummary, sitesPath, writeGraph } from './output.ts'
import { DEFAULT_PROJECTS, ProjectList, defaultOut, descriptionsPath } from './projects.ts'

const USAGE = `archrift ${TOOL.version}

Usage:
  archrift init [root] [options]       a first look at a project archrift hasn't seen: detects its stack,
                                      writes a starter config into <root>/.archrift/ (layers its folders
                                      keep, starter rules, all errors: check fails until the code keeps
                                      them, diff only on new ones), adds it to the project list and
                                      reports what it found, also as .archrift/first-look.html and .md.
                                      A project that has a config keeps it (--force writes a new one)
  archrift analyze [root] [options]    analyze and write the graph
  archrift serve [folder…] [options]   analyze (cached), then open the 3D viewer. The folders join the
                                      project list the viewer switches between, and the first opens;
                                      with none, the project opened last
  archrift check [root] [options]      analyze (cached), report broken architecture rules;
                                      exits 1 when a rule with severity "error" is broken
  archrift snapshot [root] [rev…]      analyze older commits for the viewer's timeline
                                      (in a temporary git worktree; kept in <out dir>/snapshots)
  archrift coherence [root] [options]  analyze (cached), report how many ways the code does each job
                                      (dates, HTTP calls, test doubles …; docs/COHERENCE.md)
  archrift query <question> <path…>    analyze (cached), answer a question about the code before changing
                                      it (docs/QUERY.md). Paths may be files no one has written yet:
    ways <path> [--job <words>]         how it does each job, and the way to follow ("call the server")
    rules <path> [--to <path>]          what it may depend on, who may depend on it; with --to, whether
                                        that dependency would break a rule
    path <from> <to>                    how one depends on the other, hop by hop
    file <path>                         one file at a glance
    crap <path> [--max <n>]             its riskiest functions: CRAP (complexity and the branches the
                                        last coverage run left untaken), else complexity
    impact <path> [--depth <n>] [--max <n>]  what depends on it, directly or not (a file, a folder, a
                                        function as <path>#<name>, a package): the files, features and
                                        entry points it reaches, and the tests to run after changing it
    overview                            the project: what was written about it, its blocks, features,
                                        layers and rules
    find <words…> [--max <n>]           files, folders, functions and routes by name, path, route or
                                        description (archrift describe)
    docs <path | id | document>         the documents naming a file, folder or function and the decision
                                        ids it cites; where an id (D34) is defined and who cites it; the
                                        code a document names (config docs)
  archrift describe [command] [path]   the names and descriptions written for the code, beside the config
                                      (.archrift/descriptions.json, committed with it); the viewer, search
                                      and query show them:
    status                              how much is described, what went stale, what lost its code
    todo [folder] [--max <n>]           the next things to describe, most worth it first, each with a
                                        digest to write from (exports, routes, what it uses, who uses it)
    set <path|id> [--name …] [--summary …]  one entry (a file, a folder, feature:<name>, project or a
                                        node id); without either, marks a stale one as still fitting
    apply <file.json | ->               many at once: { "<path or id>": { "name": "…", "summary": "…" } }
    sync                                entries follow renamed and moved code; the rest of the orphans go
  archrift diff [root] [options]       what a change does to rules, import cycles, coherence and the
                                      dependencies between blocks: the working tree (or --head) against
                                      --base (default: where the branch left main; on main, HEAD).
                                      Exits 1 on a new violation of an error rule, or one it worsens
  archrift export html [root]          analyze (cached), write the viewer with the project's graph inside
                                      as one HTML file: it opens from disk with no server and no network
                                      (to share: the source stays out unless --source). Default file:
                                      <name>.html beside the project's graph
  archrift export archify <kind> [root] analyze (cached), write archify's JSON (github.com/tt-a1i/archify)
                                      and print the command that renders it: architecture (the blocks by
                                      layer, the databases), erd (one file per database) or class (a type
                                      family, or a folder's types). Beside the graph
  archrift hook <command>              an optional Claude Code hook, off until installed: before the agent
                                      writes or edits a code file of an archrift project, archrift puts its
                                      notes on the file into the agent's context (rules; how its folder
                                      does common jobs; for a file that exists, what it breaks, once per
                                      session)
    install [--shared] [--dir <d>]      adds it to <d>/.claude/settings.local.json (personal), or with
                                        --shared settings.json (committed); <d>: the git top-level
    uninstall [--shared] [--dir <d>]    removes it, and only it
    status [--dir <d>]                  whether it is installed, where, and its command
    pre-write                           what the hook runs: Claude Code's JSON on stdin, the notes on
                                        stdout; always exits 0

Options:
  --config <file>   config file (default: <root>/.archrift/config.json when present)
  --out <file>      graph output (default: $ARCHRIFT_CACHE/<name>/graph.json when that is set, else
                    <root>/.archrift/graph.json when the config is there, else
                    ~/.config/archrift/projects/<name>/graph.json); sites, cache, snapshots and saved views
                    go next to it. export html: the HTML file; export archify: the JSON's folder
  --no-cache        re-analyze every file
  --no-history      skip git history (churn, co-change); also "history": { "enabled": false }
  --dump <file>     also write a readable text dump of the graph
  --quiet           print nothing but errors
  --version, -v     print archrift's version
  --port <n>        serve: port on 127.0.0.1 (default 4300)
  --views <dir>     serve: where saved views go (default: <out dir>/views); export: the views it carries
  --view <id|link>  export: the view the page opens on (city, wheel …), or a viewer link to carry its
                    options and selection (http://127.0.0.1:4300/?view=wheel&group=feature#n=…)
  --source          export: carry the source of the project's files (the inspector's source panel)
  --database <name> export archify erd: one database (its name or id) instead of each
  --family <name>   export archify class: the type family (default: the biggest with classes)
  --folder <path>   export archify class: a folder's own types and their associations instead
  --projects <file> serve, init: the project list (default: ~/.config/archrift/projects.json;
                    ARCHRIFT_HOME moves the whole folder)
  --force           init: detect again and replace the project's config
  --dry-run         init: print the config it would write, write nothing
  --open            serve: open the viewer in the browser
  --claude <path>   serve: the Claude Code CLI the Ask bar asks (default: claude on the PATH, or
                    ~/.local/bin/claude); it reads the code and asks archrift query, read-only
  --ask-model <m>   serve: the model the Ask bar's agent uses (sonnet, opus, a full model id);
                    default: Claude Code's own default
  --watch           serve: re-analyze as files change and update the viewer live
  --format <f>      check, coherence, query: text (default) or json, on stdout; diff and init also markdown
  --root <dir>      query, diff: the project (default: the listed project the current folder is in,
                    else the current folder)
  --project <name>  query, diff, export: a project of the list, by name
  --job <words>     query ways: the jobs to ask about (an id like js.http, or words: "call the server")
  --to <path>       query rules: a dependency to check (a file, a folder or a package)
  --graph <file>    query: answer from a graph already written (archrift serve's, for its Ask bar)
                    instead of analyzing
  --max <n>         query path: at most this many paths (default 5); query crap: functions (default 20);
                    query docs: documents, files or sections listed (default 12);
                    query impact: files per list (default 20); describe todo: items (default 40)
  --depth <n>       query impact: at most this many steps from it (default: all the way)
  --name <words>    describe set: the short name a person would use (when the code's own doesn't say it)
  --summary <words> describe set: one or two sentences on what it is for
  --base <ref>      diff: the commit to compare with
  --head <ref>      diff: a commit instead of the working tree
  --strict          diff: also exit 1 on a new way or a file doing a job differently from its block
  --count <n>       snapshot: without revs, this many commits spread over the history (default 10)
  --every <n>       snapshot: …or every n-th commit back from HEAD
  --shared          hook install, uninstall: .claude/settings.json (committed) instead of settings.local.json
  --dir <folder>    hook: the folder Claude Code runs in (default: the git top-level, else the current folder)

Environment:
  ARCHRIFT_HOME     archrift's home folder (default ~/.config/archrift): the project list, and the results
                    of projects without a .archrift/ of their own
  ARCHRIFT_CACHE    every project's results and caches in $ARCHRIFT_CACHE/<name>/ instead, so nothing is
                    written into the project (a sandbox, a read-only checkout). Without it, a cache archrift
                    may not write is skipped with a warning, and the answer is the same, only slower
`

type Values = ReturnType<typeof parse>['values']

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      out: { type: 'string' },
      'no-cache': { type: 'boolean' },
      'no-history': { type: 'boolean' },
      dump: { type: 'string' },
      quiet: { type: 'boolean' },
      port: { type: 'string' },
      views: { type: 'string' },
      projects: { type: 'string' },
      open: { type: 'boolean' },
      watch: { type: 'boolean' },
      format: { type: 'string' },
      count: { type: 'string' },
      every: { type: 'string' },
      root: { type: 'string' },
      project: { type: 'string' },
      job: { type: 'string' },
      to: { type: 'string' },
      max: { type: 'string' },
      depth: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      strict: { type: 'boolean' },
      view: { type: 'string' },
      source: { type: 'boolean' },
      database: { type: 'string' },
      family: { type: 'string' },
      folder: { type: 'string' },
      name: { type: 'string' },
      summary: { type: 'string' },
      graph: { type: 'string' },
      claude: { type: 'string' },
      'ask-model': { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      shared: { type: 'boolean' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
}

/** Commands that find their project themselves (from the list, or the folder they're run in), by their arguments after the command. */
const OWN_PROJECT: Partial<Record<string, (values: Values, args: string[]) => Promise<number>>> = {
  query: (values, args) => query(values, args),
  describe: (values, args) => describe(values, args),
  diff: (values, args) => diff(values, args[0]),
  init: (values, args) => init(values, args[0]),
  export: (values, args) => exportPage(values, args),
  hook: (values, args) => hook(values, args),
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv)
  const [command, rootArg] = positionals
  if (values.version) {
    process.stdout.write(`${TOOL.version}\n`)
    return 0
  }
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return values.help ? 0 : 1
  }
  if (!['init', 'analyze', 'serve', 'check', 'snapshot', 'coherence', 'query', 'describe', 'diff', 'export', 'hook'].includes(command)) {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
    return 1
  }
  const formats = command === 'diff' || command === 'init' ? ['text', 'json', 'markdown'] : ['text', 'json']
  if (values.format !== undefined && !formats.includes(values.format)) {
    process.stderr.write(`unknown format: ${values.format} (${formats.join(', ')})\n`)
    return 1
  }
  const own = OWN_PROJECT[command]
  if (own) return own(values, positionals.slice(1))
  const log = values.quiet || command === 'check' || command === 'coherence' ? () => {} : (msg: string) => process.stderr.write(`${msg}\n`)
  if (command === 'serve') return serve(values, positionals.slice(1), log)

  const root = path.resolve(rootArg ?? '.')
  const config = loadConfig(root, values.config)
  const files = countFiles(root, config)
  const out = path.resolve(values.out ?? defaultOut(config.name ?? path.basename(root), root))
  if (command === 'snapshot') {
    const revs = positionals.slice(2)
    const count = Number(values.count ?? 10)
    const every = values.every === undefined ? undefined : Number(values.every)
    if (!Number.isInteger(count) || count < 1 || (every !== undefined && (!Number.isInteger(every) || every < 1))) {
      process.stderr.write('--count and --every take a whole number ≥ 1\n')
      return 1
    }
    const snapshotsDir = path.join(path.dirname(out), 'snapshots')
    const revisions = revs.length ? resolveRevisions(root, revs) : pickRevisions(root, count, every)
    const list = await takeSnapshots({ root, config, files, dir: snapshotsDir, revisions, log })
    log(`${list.length} snapshots in ${path.relative(process.cwd(), snapshotsDir)}:`)
    for (const s of list) log(`  ${new Date(s.time * 1000).toISOString().slice(0, 10)}  ${s.sha.slice(0, 8)}  ${String(s.files).padStart(5)} files  ${s.subject}`)
    return 0
  }

  const graph = await analyzeIsolated({
    root,
    config,
    files,
    cacheDir: values['no-cache'] ? false : path.join(path.dirname(out), 'cache'),
    history: !values['no-history'],
    log,
  })
  writeGraph(graph, out, values.dump)
  printSummary(graph, out, log)
  if (command === 'analyze') return 0
  if (command === 'coherence') {
    const model = coherenceOf(graph)
    await print(values.format === 'json' ? `${JSON.stringify(coherenceJson(graph, model), null, 2)}\n` : coherenceText(graph, model))
    return 0
  }
  const report = checkReport(graph)
  await print(values.format === 'json' ? `${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ...report }, null, 2)}\n` : checkText(graph))
  return report.errors ? 1 : 0
}

/**
 * `serve`: the folders given join the project list (the first with --config,
 * --out and --views) and the first one opens; without folders, the project
 * opened last (or the current directory, the first time).
 */
async function serve(values: Values, folders: string[], log: (msg: string) => void): Promise<number> {
  const list = new ProjectList(values.projects ? path.resolve(values.projects) : DEFAULT_PROJECTS)
  const own = { config: values.config, out: values.out, views: values.views }
  let first: string | undefined
  folders.forEach((folder, i) => {
    const project = list.add({ root: folder, ...(i === 0 ? own : {}) })
    first ??= project.name
  })
  first ??= list.active()?.name ?? list.add({ root: '.', ...own }).name

  const engine = findClaude(values.claude)
  const askModel = values['ask-model']?.trim() || undefined
  const hub = new ProjectHub(list, {
    ask: engine,
    askModel,
    watch: !!values.watch,
    cache: !values['no-cache'],
    history: !values['no-history'],
    dump: values.dump,
    log,
    report: (graph, project) => printSummary(graph, project.out, log),
  })
  const { graph, project } = await hub.load(first)
  const port = Number(values.port ?? 4300)
  await startServer({
    root: project.root,
    graph,
    port,
    viewsDir: project.views,
    snapshotsDir: project.snapshots,
    descriptions: project.descriptions,
    changes: (head, range) => hub.changes(head, range),
    commits: () => hub.commits(),
    ask: { status: { available: engine.available, engine: engine.engine && askModel ? `${engine.engine} (${askModel})` : engine.engine, why: engine.why }, run: (input, onProgress, signal) => hub.ask(input, onProgress, signal) },
    live: values.watch ? hub.live : undefined,
    projects: hub,
  })
  const url = `http://127.0.0.1:${port}/`
  process.stderr.write(`archrift serving ${graph.meta.name} at ${url}${values.watch ? ', watching for changes' : ''} (Ctrl+C to stop)\n`)
  if (values.open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
  return new Promise<number>(() => {}) // serve until interrupted
}

/** `query`: a fresh analysis (cached), one question answered; paths as typed from the current folder or the root. */
async function query(values: Values, args: string[]): Promise<number> {
  const [question, ...paths] = args
  if (!QUESTIONS.includes(question as Question)) {
    process.stderr.write(`archrift query: ask ${QUESTIONS.join(', ')} (archrift --help)\n`)
    return EXIT.usage
  }
  const max = values.max === undefined ? undefined : Number(values.max)
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
    process.stderr.write('--max takes a whole number ≥ 1\n')
    return EXIT.usage
  }
  const depth = values.depth === undefined ? undefined : Number(values.depth)
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) {
    process.stderr.write('--depth takes a whole number ≥ 1\n')
    return EXIT.usage
  }
  // the Ask bar's agent: the served graph and its project come in the environment
  const env = process.env
  const where = locate({ root: values.root ?? env.ARCHRIFT_QUERY_ROOT, project: values.project, config: values.config ?? env.ARCHRIFT_QUERY_CONFIG, out: values.out })
  const config = loadConfig(where.root, where.config)
  const out = path.resolve(where.out ?? defaultOut(config.name ?? path.basename(where.root), where.root))
  const graphFile = values.graph ?? env.ARCHRIFT_QUERY_GRAPH
  const graph = graphFile
    ? decodeGraph(JSON.parse(fs.readFileSync(path.resolve(graphFile), 'utf8')) as SerializedGraph, readSites(path.resolve(graphFile)))
    : await analyzeIsolated({
        root: where.root,
        config,
        files: countFiles(where.root, config),
        cacheDir: values['no-cache'] ? false : path.join(path.dirname(out), 'cache'),
        history: !values['no-history'],
      })
  const described = readDescriptionsFile(descriptionsPath(where.root, where.config)).data
  const q = queryFor(graph, config, readCoverage(where.root, config.coverage), resolveDescriptions(graph, described))
  const known = (rel: string) => ['file', 'folder'].includes(q.place(rel).kind)
  // a function or class as <path>#<name>: the path as typed from here
  const rel = (p: string) => (/^[^:]+#/.test(p) ? `${rootRelative(p.slice(0, p.indexOf('#')), where.root, process.cwd(), known)}${p.slice(p.indexOf('#'))}` : rootRelative(p, where.root, process.cwd(), known))
  const { text, code } = answer(q, {
    question: question as Question,
    paths: question === 'find' ? paths : paths.map(rel),
    job: values.job,
    to: values.to === undefined ? undefined : rel(values.to),
    max,
    depth,
    format: values.format === 'json' ? 'json' : 'text',
  })
  await print(text)
  return code
}

/** `describe`: the project's names and descriptions; a fresh analysis (cached) to check them against. */
async function describe(values: Values, args: string[]): Promise<number> {
  const [first, ...rest] = args
  const command = (DESCRIBE_COMMANDS as readonly string[]).includes(first ?? '') ? (first as DescribeCommand) : 'status'
  const paths = command === first ? rest : args
  if (command === 'status' && paths.length) {
    process.stderr.write(`archrift describe: ${DESCRIBE_COMMANDS.join(', ')} (archrift --help)\n`)
    return DESCRIBE_EXIT.usage
  }
  const max = values.max === undefined ? undefined : Number(values.max)
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
    process.stderr.write('--max takes a whole number ≥ 1\n')
    return DESCRIBE_EXIT.usage
  }
  const where = locate({ root: values.root, project: values.project, config: values.config, out: values.out })
  const config = loadConfig(where.root, where.config)
  const out = path.resolve(where.out ?? defaultOut(config.name ?? path.basename(where.root), where.root))
  const graph = await analyzeIsolated({
    root: where.root,
    config,
    files: countFiles(where.root, config),
    cacheDir: values['no-cache'] ? false : path.join(path.dirname(out), 'cache'),
    history: !values['no-history'],
  })
  // paths as typed from here, when here is inside the project
  const rel = (p: string) => (command === 'apply' || p === 'project' || /^(feature|[dfsx]):/.test(p) ? p : rootRelative(p, where.root, process.cwd(), r => graph.nodes.some(n => n.path === r)))
  const { text, code } = runDescribe({
    command,
    args: paths.map(rel),
    graph,
    root: where.root,
    file: descriptionsPath(where.root, where.config),
    name: values.name,
    summary: values.summary,
    max,
    format: values.format === 'json' ? 'json' : 'text',
    stdin: () => fs.readFileSync(0, 'utf8'),
  })
  await print(text)
  return code
}

/** `init`: the first look at a new project; progress on stderr, the report on stdout. */
async function init(values: Values, rootArg: string | undefined): Promise<number> {
  const { text, code } = await runInit({
    root: rootArg ?? '.',
    projects: values.projects ? path.resolve(values.projects) : DEFAULT_PROJECTS,
    force: !!values.force,
    dryRun: !!values['dry-run'],
    history: !values['no-history'],
    cache: !values['no-cache'],
    format: (values.format ?? 'text') as 'text' | 'json' | 'markdown',
    log: values.quiet ? () => {} : msg => process.stderr.write(`${msg}\n`),
  })
  await print(text)
  return code
}

/** `diff`: the change against its base; exits 1 on a new violation of an error rule (--strict: also on new drift). */
async function diff(values: Values, rootArg: string | undefined): Promise<number> {
  const where = locate({ root: rootArg ?? values.root, project: values.project, config: values.config, out: values.out })
  const config = loadConfig(where.root, where.config)
  const out = path.resolve(where.out ?? defaultOut(config.name ?? path.basename(where.root), where.root))
  const { text, code } = await runDiff({
    root: where.root,
    config,
    files: countFiles(where.root, config),
    out,
    args: { base: values.base, head: values.head, strict: !!values.strict, format: (values.format ?? 'text') as 'text' | 'json' | 'markdown' },
    log: values.quiet ? () => {} : msg => process.stderr.write(`${msg}\n`),
  })
  await print(text)
  return code
}

/** `export html`: the viewer with the project's graph in one file; progress on stderr, where it went and its size on stdout. */
async function exportPage(values: Values, args: string[]): Promise<number> {
  const [format, rootArg] = args
  if (format === 'archify') return exportArchifyFiles(values, args.slice(1))
  if (format !== 'html') {
    process.stderr.write(`archrift export: html or archify (archrift export html [root], archrift export archify <kind> [root])\n`)
    return 1
  }
  const where = locate({ root: rootArg ?? values.root, project: values.project, config: values.config })
  const log = values.quiet ? () => {} : (msg: string) => process.stderr.write(`${msg}\n`)
  const r = await runExport({
    root: where.root,
    config: where.config,
    graphOut: where.out,
    views: values.views ?? where.views,
    out: values.out,
    view: values.view,
    source: !!values.source,
    cache: !values['no-cache'],
    history: !values['no-history'],
    log,
  })
  const kb = (n: number) => `${Math.round(n / 1024).toLocaleString('en-US')} KB`
  const parts = Object.entries(r.parts).map(([k, v]) => `${k} ${kb(v)}`).join(' · ')
  const skipped = r.skipped.length ? `; ${r.skipped.length} files left out of the source (binary or too large)` : ''
  // relative to here when it's under here, else in full
  const shown = path.relative(process.cwd(), r.file).startsWith('..') ? r.file : path.relative(process.cwd(), r.file)
  await print(`${shown}: ${kb(r.bytes)} (${parts}), opens on ${r.view}${skipped}\n`)
  return 0
}

/** `export archify <kind>`: archify's JSON beside the project's graph, and the commands that render it, on stdout. */
async function exportArchifyFiles(values: Values, args: string[]): Promise<number> {
  const [kind, rootArg] = args
  if (!ARCHIFY_KINDS.includes(kind as ArchifyKind)) {
    process.stderr.write(`archrift export archify: ${ARCHIFY_KINDS.slice(0, -1).join(', ')} or ${ARCHIFY_KINDS.at(-1)} (archrift export archify <kind> [root])\n`)
    return 1
  }
  const where = locate({ root: rootArg ?? values.root, project: values.project, config: values.config })
  const written = await runExportArchify({
    root: where.root,
    config: where.config,
    kind: kind as ArchifyKind,
    graphOut: where.out,
    out: values.out,
    database: values.database,
    family: values.family,
    folder: values.folder,
    cache: !values['no-cache'],
    history: !values['no-history'],
    log: values.quiet ? () => {} : (msg: string) => process.stderr.write(`${msg}\n`),
  })
  await print(exportArchifyText(written))
  return 0
}

/**
 * `hook`: install, uninstall, status, or `pre-write`, the hook itself: Claude Code's JSON on
 * stdin, the notes (or nothing) on stdout, exit 0 whatever happens.
 */
async function hook(values: Values, args: string[]): Promise<number> {
  const [command] = args
  if (!HOOK_COMMANDS.includes(command as HookCommand)) {
    process.stderr.write(`archrift hook: ${HOOK_COMMANDS.join(', ')} (archrift --help)\n`)
    return 1
  }
  if (command === 'pre-write') {
    await print(await preWrite(readStdin())).catch(() => {})
    return 0
  }
  const dir = path.resolve(values.dir ?? defaultDir())
  const shared = !!values.shared
  try {
    await print(command === 'install' ? install({ dir, shared }) : command === 'uninstall' ? uninstall({ dir, shared }) : status({ dir }))
    return 0
  } catch (e) {
    process.stderr.write(`archrift hook ${command}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

/** All of stdin; nothing when there's none to read. */
function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** The sites written beside a graph (where each edge's references are), when they're there. */
function readSites(graphFile: string): SerializedSites | undefined {
  try {
    return JSON.parse(fs.readFileSync(sitesPath(graphFile), 'utf8')) as SerializedSites
  } catch {
    return undefined
  }
}

/** Writes a report to stdout and waits until it's out: exiting earlier cuts a piped report off at 64 KB. */
const print = (text: string) => new Promise<void>((resolve, reject) => process.stdout.write(text, e => (e ? reject(e) : resolve())))

/** Errors and warnings: the violations, and the rules that match nothing (each counts once, by its severity). */
function checkReport(graph: Graph) {
  const violations = graph.meta.violations ?? []
  const rules = graph.meta.rules ?? []
  const unmatched = (severity: string) => rules.filter(r => r.unmatched && r.severity === severity).length
  return {
    project: graph.meta.name,
    rules,
    errors: violations.filter(v => v.severity === 'error').length + unmatched('error'),
    warnings: violations.filter(v => v.severity === 'warn').length + unmatched('warn'),
    violations,
  }
}

/** Broken rules first (errors, then warnings), each with what breaks it; paths shown file by file. */
function checkText(graph: Graph): string {
  const rules = graph.meta.rules
  if (!rules?.length) return `${graph.meta.name}: no rules configured (add "rules" to the config)\n`
  const violations = graph.meta.violations ?? []
  const report = checkReport(graph)
  const nameOf = new Map(graph.nodes.map(n => [n.id, n.path ?? n.name]))
  const label = (id: string) => nameOf.get(id) ?? id
  const all = graph.meta.targets.length
  const broken = (r: (typeof rules)[number]) => !!r.unmatched || violations.some(v => v.rule === r.name)
  const rank = (r: (typeof rules)[number]) => (broken(r) ? (r.severity === 'error' ? 0 : 1) : 2)
  const lines = [`archrift check ${graph.meta.name}: ${report.errors} errors · ${report.warnings} warnings · ${rules.length} rules`]
  for (const rule of [...rules].sort((a, b) => rank(a) - rank(b))) {
    const vs = violations.filter(v => v.rule === rule.name)
    const mark = !broken(rule) ? '✓' : rule.severity === 'error' ? '✗' : '!'
    const what = [rule.unmatched && 'matches nothing', vs.length && `${vs.length}`].filter(Boolean).join(' · ')
    lines.push('', `${mark} ${rule.name}${what ? ` (${rule.severity}): ${what}` : ''}${rule.description ? `  ${rule.description}` : ''}`)
    for (const u of rule.unmatched ?? []) lines.push(`  ? ${u}`)
    for (const v of vs) {
      const where = v.targets.length < all ? `  [${v.targets.join(', ')}]` : ''
      if (v.measure) lines.push(`  ${v.message}`)
      else if (v.expects) lines.push(`  ${v.message}${where}`)
      else if (v.path && v.path.length > 2) {
        lines.push(`  ${label(v.to)}${where}${v.sources && v.sources.length > 1 ? `  (reached from ${v.sources.length} places, e.g.)` : ''}`)
        lines.push(`      ${v.path.map(label).join('\n    → ')}`)
      } else lines.push(`  ${label(v.from)} → ${label(v.to)}${where}`)
    }
  }
  return `${lines.join('\n')}\n`
}


main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => {
    process.stderr.write(`archrift: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  },
)
