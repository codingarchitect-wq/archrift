// Everything the viewer asks for, in one place: here, the client for the
// archrift server's API (src/server/api.ts). An exported page (`archrift export
// html`) answers the same calls from the data embedded in it: its build swaps
// this module for api.static.ts (vite.static.ts), so the rest of the viewer
// never asks which one it talks to, only what it can do (`capabilities`).
import type { Graph } from '../core/model.ts'
import { decodeGraph } from '../core/serialize.ts'
import type { SerializedGraph } from '../core/serialize.ts'
import type { SnapshotInfo } from '../core/snapshot-index.ts'
import type { ProjectSummary } from '../server/projects.ts'
import type { ClassChoices, FileDetails, Info, SearchHit, SourceLines } from '../server/views.ts'
import type { ClassDiagram } from '../core/classes.ts'
import type { ResolvedDescriptions } from '../core/descriptions.ts'
import type { ChangesRange, ChangesReport, CommitInfo } from '../core/changes.ts'
import type { Answer, AskContext } from '../core/ask.ts'
import type { Options } from './url-state.ts'

export type { Answer, AskContext, ChangesReport, ClassChoices, FileDetails, Info, ProjectSummary, ResolvedDescriptions, SearchHit, SnapshotInfo, SourceLines }

export interface ProjectList {
  active?: string
  opening?: string
  projects: ProjectSummary[]
}

/** A named snapshot of what the viewer shows (a lens). */
export interface SavedView {
  name: string
  state: {
    options: Partial<Options>
    selected: string | null
    camera?: { position: [number, number, number]; target: [number, number, number] }
  }
}

/** What the other end can do besides answering about the graph; the panels leave out what it can't. */
export interface Capabilities {
  /** The project switcher: list, open, add and remove projects. */
  projects: boolean
  /** The timeline over snapshots from `archrift snapshot`. */
  snapshots: boolean
  /** Saving and deleting views (the saved ones can always be opened). */
  saveViews: boolean
  /** Watch mode and project switches pushed as events. */
  live: boolean
  /** The source of the graph's files (the inspector's source panel). */
  source: boolean
  /** The change in progress against its base (the Changes panel). */
  changes: boolean
  /** Questions to the coding agent on the server's machine (the Ask bar); /api/info says whether it has one. */
  ask: boolean
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

async function send<T = unknown>(method: 'POST' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    // the server's own message when it has one ("not a folder: …")
    let message = `${url}: HTTP ${res.status} ${text}`
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message
    } catch {
      // not JSON
    }
    throw new Error(message)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

/** The snapshot the graph requests are about ('' = now), set when the timeline moves. */
let snapshot = ''
const at = () => (snapshot ? `&snapshot=${snapshot}` : '')

export const api = {
  capabilities: { projects: true, snapshots: true, saveViews: true, live: true, source: true, changes: true, ask: true } as Capabilities,
  setSnapshot: (sha: string) => void (snapshot = sha),
  info: () => get<Info>('/api/info'),
  overview: async (sha = ''): Promise<Graph> => decodeGraph(await get<SerializedGraph>(`/api/overview${sha ? `?snapshot=${sha}` : ''}`)),
  snapshots: () => get<SnapshotInfo[]>('/api/snapshots'),
  file: (id: string) => get<FileDetails>(`/api/file?id=${encodeURIComponent(id)}${at()}`),
  search: (q: string, signal?: AbortSignal) => get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}${at()}`, signal),
  /** The type families and folders with types, for the Classes view's pickers. */
  classChoices: () => get<ClassChoices>(`/api/classes?${at().slice(1)}`),
  /** One family's (its root's id) or folder's (a path, '' for the root) class diagram. */
  classDiagram: (q: { family: string } | { folder: string }) =>
    get<ClassDiagram>(`/api/classes?${'family' in q ? `family=${encodeURIComponent(q.family)}` : `folder=${encodeURIComponent(q.folder)}`}${at()}`),
  source: (path: string, start: number, end: number) =>
    get<SourceLines>(`/api/source?path=${encodeURIComponent(path)}&start=${start}&end=${end}${at()}`),
  /** The names and descriptions written for the code (`archrift describe`), stale ones marked. */
  descriptions: () => get<ResolvedDescriptions>(`/api/descriptions?${at().slice(1)}`),
  /** The working tree (or `range.head`, a revision) against its base, as `archrift diff` compares them (each revision is analyzed once: seconds). */
  changes: (fresh = '', range: ChangesRange = {}) => {
    const q = new URLSearchParams({ ...(range.base ? { base: range.base } : {}), ...(range.head ? { head: range.head } : {}), ...(fresh ? { fresh } : {}) }).toString()
    return get<ChangesReport>(`/api/changes${q ? `?${q}` : ''}`)
  },
  /** The latest commits, to pick a range of them for Changes. */
  commits: () => get<CommitInfo[]>('/api/commits'),
  /** A question for the agent: its steps as it works (`onProgress`), then the answer. Aborting stops the agent. */
  ask: async (input: { question: string; context?: AskContext }, onProgress: (text: string) => void, signal?: AbortSignal): Promise<Answer> => {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal })
    if (!res.ok || !res.body) {
      const text = await res.text()
      let message = `/api/ask: HTTP ${res.status}`
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message
      } catch {
        // not JSON
      }
      throw new Error(message)
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, nl)) as { type: 'progress'; text: string } | { type: 'answer'; answer: Answer } | { type: 'error'; error: string }
        buffer = buffer.slice(nl + 1)
        if (m.type === 'progress') onProgress(m.text)
        else if (m.type === 'answer') return m.answer
        else throw new Error(m.error)
      }
    }
    throw new Error('the answer stopped short')
  },
  views: () => get<SavedView[]>('/api/views'),
  saveView: (view: SavedView) => send('POST', '/api/views', view),
  deleteView: (name: string) => send('DELETE', `/api/views?name=${encodeURIComponent(name)}`),
  projects: () => get<ProjectList>('/api/projects'),
  openProject: (name: string) => send('POST', '/api/projects/open', { name }),
  addProject: (input: { root: string; name?: string; config?: string }) => send<ProjectSummary>('POST', '/api/projects', input),
  removeProject: (name: string) => send<ProjectList>('DELETE', `/api/projects?name=${encodeURIComponent(name)}`),
}

/** The calls an exported page answers too (api.static.ts implements it). */
export type Api = typeof api
