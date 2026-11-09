// `archrift export archify <architecture|erd|class>`: archify's JSON from the
// analysis (src/core/archify/), written beside the project's results, with the
// archify command that renders each file into a standalone HTML diagram.
// archrift never runs archify itself: it stays a separate install.
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../analyzer/config.ts'
import { analyzeIsolated } from '../analyzer/isolated.ts'
import { archifyArchitecture } from '../core/archify/architecture.ts'
import { archifyClass } from '../core/archify/classes.ts'
import { archifyErd } from '../core/archify/erd.ts'
import { familyDiagram, folderDiagram, typeFamilies } from '../core/classes.ts'
import type { ClassDiagram } from '../core/classes.ts'
import type { DatabaseMeta, Graph } from '../core/model.ts'
import { countFiles } from './output.ts'
import { defaultOut, slug } from './projects.ts'

export const ARCHIFY_KINDS = ['architecture', 'erd', 'class'] as const
export type ArchifyKind = (typeof ARCHIFY_KINDS)[number]

export interface ExportArchifyOptions {
  graph: Graph
  kind: ArchifyKind
  project: string
  /** The folder the JSON goes into. */
  dir: string
  /** erd: one database (its id or name); without it, every database gets a file. */
  database?: string
  /** class: a type family (its root type's name or id); without it or a folder, the first family (the biggest with classes). */
  family?: string
  /** class: a folder's own types instead of a family. */
  folder?: string
}

export interface Written {
  file: string
  kind: ArchifyKind
  quality: 'standard' | 'showcase'
  /** In words: "27 tables, 31 relationships". */
  what: string
}

export function exportArchify(o: ExportArchifyOptions): Written[] {
  fs.mkdirSync(o.dir, { recursive: true })
  if (o.kind === 'architecture') {
    const doc = archifyArchitecture(o.graph, { project: o.project })
    return [write(o, doc, `${count(doc.components.length, 'component')}, ${count(doc.connections.length, 'connection')}`)]
  }
  if (o.kind === 'class') {
    const doc = archifyClass(classDiagramOf(o.graph, o), { project: o.project })
    return [write(o, doc, `${count(doc.types.length, 'type')}, ${count(doc.relationships.length, 'relationship')}`)]
  }
  return databasesOf(o.graph, o.database).map(db => {
    const doc = archifyErd(db, { project: o.project })
    return write(o, doc, `${count(doc.entities.length, 'table')}, ${count(doc.relationships.length, 'relationship')}`)
  })
}

function classDiagramOf(graph: Graph, o: { family?: string; folder?: string }): ClassDiagram {
  if (o.folder !== undefined) {
    const d = folderDiagram(graph, o.folder.replace(/^\.\/|\/$/g, ''))
    if (!d.types.length) throw new Error(`no types declared in ${o.folder}'s own files`)
    return d
  }
  const families = typeFamilies(graph)
  if (!families.length) throw new Error('no types here extend or implement each other: try --folder <path>')
  const family = o.family === undefined ? families[0] : families.find(f => f.id === o.family || f.name === o.family)
  if (!family) throw new Error(`no type family ${o.family}; the biggest are: ${families.slice(0, 8).map(f => f.name).join(', ')}`)
  return familyDiagram(graph, family.id)
}

function databasesOf(graph: Graph, wanted: string | undefined): DatabaseMeta[] {
  const all = graph.meta.databases ?? []
  if (!all.length) throw new Error('no database schema found in this project (archrift reads Prisma, Dexie, SQL files, JPA and Mongo entities)')
  if (wanted === undefined) return all
  const db = all.find(d => d.id === wanted || d.name === wanted)
  if (!db) throw new Error(`no database ${wanted}; there are: ${all.map(d => d.name).join(', ')}`)
  return [db]
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`

/** Named after the HTML archify will write (its meta.output), so the two sit side by side. */
function write(o: ExportArchifyOptions, doc: { meta: { output: string; quality_profile: 'standard' | 'showcase' } }, what: string): Written {
  const file = path.join(o.dir, doc.meta.output.replace(/\.html$/, '.json'))
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  return { file, kind: o.kind, quality: doc.meta.quality_profile, what }
}

/** What to tell the user: each file, and the archify command that renders it. */
export function exportArchifyText(written: readonly Written[], cwd = process.cwd()): string {
  const rel = (f: string) => {
    const r = path.relative(cwd, f)
    return r.startsWith('..') ? f : r
  }
  const lines = written.map(w => `wrote ${rel(w.file)} (${w.what})`)
  lines.push('', 'render with archify (github.com/tt-a1i/archify), from its checkout or install:')
  for (const w of written) lines.push(`  node <archify>/bin/archify.mjs finalize ${w.kind} ${rel(w.file)} ${rel(w.file.replace(/\.json$/, '.html'))} --quality ${w.quality}`)
  return `${lines.join('\n')}\n`
}

export interface RunExportArchifyOptions {
  root: string
  config?: string
  kind: ArchifyKind
  /** Where the project's graph goes: its cache is beside it, and the JSON too unless `out` says. */
  graphOut?: string
  /** The folder for the JSON. */
  out?: string
  database?: string
  family?: string
  folder?: string
  cache?: boolean
  history?: boolean
  log?: (msg: string) => void
}

/** Analyzes the project (cached) and writes archify's JSON for it. */
export async function runExportArchify(o: RunExportArchifyOptions): Promise<Written[]> {
  const root = path.resolve(o.root)
  const config = loadConfig(root, o.config)
  const name = config.name ?? path.basename(root)
  const dir = path.dirname(path.resolve(o.graphOut ?? defaultOut(name, root)))
  const graph = await analyzeIsolated({
    root,
    config,
    files: countFiles(root, config),
    cacheDir: o.cache === false ? false : path.join(dir, 'cache'),
    history: o.history !== false,
    log: o.log ?? (() => {}),
  })
  return exportArchify({ graph, kind: o.kind, project: slug(name), dir: path.resolve(o.out ?? dir), database: o.database, family: o.family, folder: o.folder })
}
