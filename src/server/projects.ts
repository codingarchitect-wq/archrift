// The project switcher's side of the API: what the server asks of the
// project hub (src/cli/hub.ts), and what the hub reports back.
import type { Graph } from '../core/model.ts'

export interface ProjectSummary {
  name: string
  root: string
  config?: string
  active: boolean
  /** When its graph was last written (ISO), if ever. */
  analyzedAt?: string
}

export type ProjectEvent =
  | { type: 'progress'; name: string; message: string }
  | { type: 'switched'; name: string; root: string; graph: Graph; views: string; snapshots: string; descriptions: string }
  | { type: 'failed'; name: string; error: string }

export interface ProjectsHandle {
  list(): { active?: string; opening?: string; projects: ProjectSummary[] }
  /** Starts opening a project; progress, then `switched` or `failed`, come as events. */
  open(name: string): void
  /** Adds a folder (throws with a readable message when it can't). */
  add(input: { root: string; name?: string; config?: string }): ProjectSummary
  remove(name: string): void
  subscribe(fn: (e: ProjectEvent) => void): () => void
}
