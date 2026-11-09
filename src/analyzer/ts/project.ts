// Finds the TypeScript projects under a root (tsconfig files and their
// project references, or a synthesized JS/TS project when there is none),
// and the set of source files the config asks to analyze.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { matcher } from '../../core/glob.ts'
import type { Matcher } from '../../core/glob.ts'
import { DEFAULT_EXCLUDE } from '../config.ts'
import type { Config } from '../config.ts'
import { absPathOf, relPathOf } from '../mounts.ts'
import type { Mount } from '../mounts.ts'

export interface TsProject {
  /** Absolute tsconfig path, or undefined for a synthesized project. */
  configFile?: string
  options: ts.CompilerOptions
  /** Absolute paths of the project's root files that pass include/exclude. */
  fileNames: string[]
}

export interface ProjectSet {
  projects: TsProject[]
  /** Absolute path → index of the first project that owns it. */
  owner: Map<string, number>
  excluded: Matcher
  rel: (abs: string) => string
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
export const isSourceFile = (p: string) => SOURCE_EXTENSIONS.some(e => p.endsWith(e))

const SYNTHESIZED_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  resolveJsonModule: true,
  skipLibCheck: true,
}

export function loadProjects(root: string, config: Config, mounts: readonly Mount[] = []): ProjectSet {
  const rel = (abs: string) => relPathOf(root, mounts, abs)
  const excluded = matcher([...DEFAULT_EXCLUDE, ...config.exclude])
  const included = config.include ? matcher(config.include) : () => true
  const keep = (abs: string) => {
    const r = rel(abs)
    return !r.startsWith('..') && included(r) && !excluded(r)
  }

  const configured = config.tsconfig === undefined ? [] : [config.tsconfig].flat()
  const tsconfigs = configured.length
    ? configured.map(c => (path.isAbsolute(c) ? c : absPathOf(root, mounts, c)))
    : fs.existsSync(path.join(root, 'tsconfig.json'))
      ? [path.join(root, 'tsconfig.json')]
      : []

  const projects: TsProject[] = []
  const seen = new Set<string>()
  const parse = (file: string) => {
    const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: d => {
        throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
      },
    })
    if (!parsed) throw new Error(`cannot read ${file}`)
    return parsed
  }
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    if (isDirectory(file)) {
      projects.push(folderProject(file))
      return
    }
    const parsed = parse(file)
    projects.push({ configFile: file, options: parsed.options, fileNames: parsed.fileNames.map(f => path.resolve(f)).filter(keep) })
    for (const ref of parsed.projectReferences ?? []) visit(ts.resolveProjectReferencePath(ref))
  }
  /**
   * A folder named instead of a tsconfig: a light project of every JS/TS file
   * under it, with its tsconfig's options when it has one. The packages they
   * import are left unloaded (noResolve): imports still point at them, and
   * references between the folder's own files resolve, but a package's types
   * stay unknown. For script folders whose libraries are huge (a Pulumi
   * project loads 25k declaration files of @pulumi/azure-native).
   */
  const folderProject = (dir: string): TsProject => {
    const own = path.join(dir, 'tsconfig.json')
    const options = fs.existsSync(own) ? parse(own).options : SYNTHESIZED_OPTIONS
    const files: string[] = []
    walkFolder(dir, rel, excluded, files)
    return {
      configFile: fs.existsSync(own) ? own : undefined,
      options: { ...options, allowJs: true, noResolve: true, types: [], noEmit: true, skipLibCheck: true },
      fileNames: files.filter(keep),
    }
  }
  tsconfigs.forEach(visit)

  if (!projects.length) {
    const files: string[] = []
    walk(root, root, excluded, files)
    projects.push({ options: SYNTHESIZED_OPTIONS, fileNames: files.filter(keep) })
  }

  const owner = new Map<string, number>()
  projects.forEach((p, i) => p.fileNames.forEach(f => owner.has(f) || owner.set(f, i)))
  return { projects, owner, excluded, rel }
}

const isDirectory = (p: string) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Source files under a folder, by graph path (a mount's too). */
function walkFolder(dir: string, rel: (abs: string) => string, excluded: Matcher, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!excluded(`${rel(abs)}/_`)) walkFolder(abs, rel, excluded, out)
    } else if (entry.isFile() && isSourceFile(entry.name) && !entry.name.endsWith('.d.ts')) out.push(abs)
  }
}

function walk(root: string, dir: string, excluded: Matcher, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const r = path.relative(root, abs).split(path.sep).join('/')
    if (entry.isDirectory()) {
      if (!excluded(`${r}/_`)) walk(root, abs, excluded, out)
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(abs)
    }
  }
}
