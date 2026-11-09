// Watch mode's link between the analysis and the API: the CLI publishes each
// new graph, the API turns it into a patch for the viewers listening.
import type { Graph } from '../core/model.ts'

export interface LiveUpdate {
  graph: Graph
  /** How long the re-analysis took. */
  ms: number
}

export class LiveGraph {
  private readonly listeners = new Set<(u: LiveUpdate) => void>()

  subscribe(fn: (u: LiveUpdate) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  publish(update: LiveUpdate) {
    for (const fn of this.listeners) fn(update)
  }
}
