// The archrift API answered in the browser, for an exported page: the same
// calls as src/viewer/api.ts, answered from a graph the page carries with the
// same functions the server uses (src/server/views.ts), so a page and
// `archrift serve` show the same thing. What needs a server (the project list,
// snapshots, saving views, live updates) says so and the panels leave it out
// (`capabilities`). Pure: tests run it in Node.
import { NO_DESCRIPTIONS } from '../../core/descriptions.ts'
import type { ResolvedDescriptions } from '../../core/descriptions.ts'
import { GraphIndex } from '../../core/graph-index.ts'
import type { Graph } from '../../core/model.ts'
import { decodeGraph, encodeGraph } from '../../core/serialize.ts'
import type { SerializedGraph } from '../../core/serialize.ts'
import { NO_SOURCE } from '../../server/embed.ts'
import { classes, fileDetails, overview, search, sourceLines } from '../../server/views.ts'
import type { ClassChoices } from '../../server/views.ts'
import type { ClassDiagram } from '../../core/classes.ts'
import type { Api, Info, SavedView } from '../api.ts'

export interface StaticData {
  info: Info
  views: SavedView[]
  /** The whole graph, sites included (loaded once, on the first call that needs it). */
  graph: () => Promise<Graph>
  /** The files' text by path, when the export has it (loaded on the first source request). */
  sources?: () => Promise<Record<string, string>>
  /** The names and descriptions written for the code, as they were at export. */
  descriptions?: ResolvedDescriptions
}

interface Served {
  index: GraphIndex
  /** Encoded once, decoded per call: every caller gets objects of its own, as from the server's JSON. */
  overview: SerializedGraph
}

/** A copy as JSON would carry it (the server's answers are JSON). */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const needsServer = (what: string) => () => Promise.reject(new Error(`${what} needs \`archrift serve\`: this page is an export`))

export function createStaticApi(data: StaticData): Api {
  let served: Promise<Served> | undefined
  const ready = () =>
    (served ??= data.graph().then(graph => {
      const index = new GraphIndex(graph)
      return { index, overview: encodeGraph(overview(index)).graph }
    }))
  let texts: Promise<Record<string, string>> | undefined

  return {
    capabilities: { projects: false, snapshots: false, saveViews: false, live: false, source: !!data.sources, changes: false, ask: false },
    setSnapshot: () => {},
    info: async () => wire(data.info),
    overview: async (sha = '') => {
      if (sha) throw new Error(`no such snapshot: ${sha}`)
      return decodeGraph((await ready()).overview)
    },
    snapshots: async () => [],
    file: async (id: string) => {
      const details = fileDetails((await ready()).index, id)
      if (!details) throw new Error(`no such file node: ${id}`)
      return wire(details)
    },
    search: async (q: string) => search((await ready()).index, q, 30, data.descriptions),
    descriptions: async () => wire(data.descriptions ?? NO_DESCRIPTIONS),
    classChoices: async () => wire(classes((await ready()).index.graph, {}) as ClassChoices),
    classDiagram: async q => wire(classes((await ready()).index.graph, q) as ClassDiagram),
    source: async (path: string, start: number, end: number) => {
      if (!data.sources) throw new Error(NO_SOURCE)
      const all = await (texts ??= data.sources())
      if (!Object.hasOwn(all, path)) throw new Error(`unknown file: ${path}`)
      return sourceLines(path, all[path], start, end)
    },
    changes: needsServer('Comparing the change in progress'),
    commits: needsServer('Listing the commits'),
    ask: needsServer('Asking about the code'),
    views: async () => wire(data.views),
    saveView: needsServer('Saving a view'),
    deleteView: needsServer('Deleting a view'),
    projects: needsServer('The project list'),
    openProject: needsServer('Opening a project'),
    addProject: needsServer('Adding a project'),
    removeProject: needsServer('Removing a project'),
  }
}
