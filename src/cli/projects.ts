// The projects the viewer can switch between (`projects.json` in archrift's
// home folder, ~/.config/archrift: it holds local paths). `serve <folder>` and
// `init` add a folder; the viewer can add and remove them too. Each project's
// graph, cache, snapshots and saved views go next to its config when that is in
// the project (`<root>/.archrift/`, as `init` writes it), else to
// `~/.config/archrift/projects/<name>/`, unless its entry says otherwise.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectDir } from '../analyzer/config.ts'

/** archrift's own folder: the checkout, or the installed package. */
export const TOOL_DIR = path.resolve(import.meta.dirname, '../..')

/**
 * archrift's folder in the user's home: the project list, and the results (and a config kept
 * outside its project) of each project without a `.archrift/` of its own. `ARCHRIFT_HOME` moves
 * it; else `$XDG_CONFIG_HOME/archrift`, else `~/.config/archrift`.
 */
export const homeDir = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()) =>
  env.ARCHRIFT_HOME ? path.resolve(env.ARCHRIFT_HOME) : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'archrift')
export const HOME_DIR = homeDir()
export const DEFAULT_PROJECTS = path.join(HOME_DIR, 'projects.json')

/** As stored: paths absolute, or relative to the file (when edited by hand). */
export interface ProjectEntry {
  name: string
  root: string
  config?: string
  out?: string
  views?: string
}

interface ProjectsFile {
  /** The project opened last; `serve` with no folder opens it again. */
  active?: string
  projects: ProjectEntry[]
}

/** An entry with every path absolute and every default filled in. */
export interface Project {
  name: string
  root: string
  config?: string
  /** graph.json; the cache and snapshots go next to it. */
  out: string
  views: string
  snapshots: string
  cache: string
  /** The names and descriptions written for its code (descriptionsPath). */
  descriptions: string
}

/** A project's name as a file or folder name. */
export const slug = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'

/**
 * Where a project's names and descriptions are written (`archrift describe`): beside its
 * config, to be committed with it: `<root>/.archrift/descriptions.json`, or for a config
 * kept elsewhere its `descriptions.json` (`app.json` → `app.descriptions.json`) beside it.
 */
export function descriptionsPath(root: string, config?: string): string {
  if (!config) return path.join(projectDir(root), 'descriptions.json')
  const abs = path.resolve(config)
  const base = path.basename(abs)
  return path.join(path.dirname(abs), base === 'config.json' ? 'descriptions.json' : `${base.replace(/\.json$/, '')}.descriptions.json`)
}

/**
 * Where a project's graph goes by default: the project's `.archrift/` when its config is there
 * (results stay with the project, as `init` sets it up), else ~/.config/archrift/projects/<name>/.
 */
export const defaultOut = (name: string, root?: string) =>
  root !== undefined && fs.existsSync(path.join(projectDir(root), 'config.json')) ? path.join(projectDir(root), 'graph.json') : path.join(HOME_DIR, 'projects', slug(name), 'graph.json')

/** `~/x` and relative paths, made absolute. */
export function expandPath(p: string, base = process.cwd()) {
  const home = p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
  return path.resolve(base, home)
}

export class ProjectList {
  readonly file: string

  constructor(file: string = DEFAULT_PROJECTS) {
    this.file = file
  }

  private read(): ProjectsFile {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ProjectsFile>
      return { active: data.active, projects: Array.isArray(data.projects) ? data.projects.filter(p => p && typeof p.name === 'string' && typeof p.root === 'string') : [] }
    } catch {
      return { projects: [] }
    }
  }

  private write(data: ProjectsFile) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`)
  }

  private resolve(e: ProjectEntry): Project {
    const base = path.dirname(this.file)
    const root = expandPath(e.root, base)
    const out = e.out ? expandPath(e.out, base) : defaultOut(e.name, root)
    return {
      name: e.name,
      root,
      config: e.config ? expandPath(e.config, base) : undefined,
      out,
      views: e.views ? expandPath(e.views, base) : path.join(path.dirname(out), 'views'),
      snapshots: path.join(path.dirname(out), 'snapshots'),
      cache: path.join(path.dirname(out), 'cache'),
      descriptions: descriptionsPath(root, e.config ? expandPath(e.config, base) : undefined),
    }
  }

  all(): Project[] {
    return this.read().projects.map(e => this.resolve(e))
  }

  get(name: string): Project | undefined {
    return this.all().find(p => p.name === name)
  }

  active(): Project | undefined {
    const data = this.read()
    const name = data.active ?? data.projects[0]?.name
    return name === undefined ? undefined : this.get(name)
  }

  setActive(name: string) {
    const data = this.read()
    if (data.active !== name) this.write({ ...data, active: name })
  }

  /**
   * Adds a folder, or updates the entry that already has it (only the fields
   * given). A new entry is named after the folder, made unique. The folder must
   * exist; the config too, when given.
   */
  add(input: { root: string; name?: string; config?: string; out?: string; views?: string }): Project {
    const root = expandPath(input.root)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`not a folder: ${root}`)
    const config = input.config === undefined ? undefined : expandPath(input.config)
    if (config && !fs.existsSync(config)) throw new Error(`config not found: ${config}`)
    const data = this.read()
    const existing = data.projects.find(e => this.resolve(e).root === root)
    const fields = {
      ...(config ? { config } : {}),
      ...(input.out ? { out: expandPath(input.out) } : {}),
      ...(input.views ? { views: expandPath(input.views) } : {}),
    }
    if (existing) {
      Object.assign(existing, fields)
      this.write(data)
      return this.resolve(existing)
    }
    const wanted = slug(input.name?.trim() || path.basename(root))
    let name = wanted
    for (let i = 2; data.projects.some(e => e.name === name); i++) name = `${wanted}-${i}`
    const entry: ProjectEntry = { name, root, ...fields }
    data.projects.push(entry)
    this.write(data)
    return this.resolve(entry)
  }

  /** Forgets a project (its outputs stay where they are). */
  remove(name: string) {
    const data = this.read()
    if (!data.projects.some(e => e.name === name)) throw new Error(`no project named ${name}`)
    this.write({ active: data.active === name ? undefined : data.active, projects: data.projects.filter(e => e.name !== name) })
  }
}
