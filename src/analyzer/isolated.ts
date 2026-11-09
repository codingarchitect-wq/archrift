// Analysis runs on a worker thread sized for it. Type-checking a large
// project needs more heap than Node's default (M0: 5.5 GB at 10k files), and
// some code makes TypeScript's checker recurse deeper than the default ~1 MB
// stack allows (a Next.js app of 1,800 files did). A worker gets both
// limits set properly, on every platform, without re-running the process.
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Graph } from '../core/model.ts'
import type { AnalyzeOptions } from './analyze.ts'

/** The analysis worker beside this module: `.ts` in a checkout, `.js` in the built package. */
const WORKER = new URL(`./analyze.worker${path.extname(import.meta.filename)}`, import.meta.url)

const STACK_MB = 64

/** Heap for about `files` source files: 0.8 MB each over a 1 GB base, at least 4 GB, at most ¾ of the memory. */
export const heapFor = (files: number) => Math.round(Math.min(Math.max(4096, 1024 + files * 0.8), (os.totalmem() / 2 ** 20) * 0.75))

export interface AnalysisSession {
  /** Runs the analysis again; calls queue up, one run at a time. */
  update(): Promise<{ graph: Graph; ms: number }>
  close(): Promise<void>
}

/**
 * A worker that keeps its analysis state between runs (watch mode): the first
 * graph, and a session that re-analyzes only what changed.
 */
export async function startSession(options: AnalyzeOptions & { files?: number }): Promise<{ graph: Graph; session: AnalysisSession }> {
  const { log, files = 0, ...data } = options
  const worker = new Worker(WORKER, {
    workerData: { ...data, watch: true },
    resourceLimits: { stackSizeMb: STACK_MB, maxOldGenerationSizeMb: heapFor(files) },
  })
  type Reply = { log?: string; graph?: Graph; ms?: number; error?: string }
  let waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | undefined
  worker.on('message', (m: Reply) => {
    if (m.log !== undefined) return void log?.(m.log)
    const w = waiting
    waiting = undefined
    if (m.error) w?.reject(new Error(m.error))
    else w?.resolve(m)
  })
  worker.on('error', err => waiting?.reject(err))
  worker.on('exit', code => waiting?.reject(new Error(`analysis stopped (worker exit code ${code})`)))
  const next = () => new Promise<Reply>((resolve, reject) => (waiting = { resolve, reject }))

  const first = await next()
  // one run at a time: the worker answers in order
  let queue: Promise<unknown> = Promise.resolve()
  const update = () => {
    const run = queue.then(async () => {
      const reply = next()
      worker.postMessage({ type: 'update' })
      const r = await reply
      return { graph: r.graph!, ms: r.ms ?? 0 }
    })
    queue = run.catch(() => undefined)
    return run
  }
  return { graph: first.graph!, session: { update, close: () => worker.terminate().then(() => undefined) } }
}

export function analyzeIsolated(options: AnalyzeOptions & { files?: number }): Promise<Graph> {
  const { log, files = 0, ...data } = options
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: data,
      resourceLimits: { stackSizeMb: STACK_MB, maxOldGenerationSizeMb: heapFor(files) },
    })
    let done = false
    worker.on('message', (m: { log?: string; graph?: Graph }) => {
      if (m.log !== undefined) log?.(m.log)
      if (m.graph) {
        done = true
        resolve(m.graph)
        void worker.terminate()
      }
    })
    worker.on('error', reject)
    worker.on('exit', code => {
      if (!done) reject(new Error(`analysis stopped (worker exit code ${code})`))
    })
  })
}
