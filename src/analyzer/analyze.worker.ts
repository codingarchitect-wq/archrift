// analyze() on a worker thread (see isolated.ts): progress goes back as log
// messages, then the graph. With `watch`, the worker stays and runs again on
// every `update` message, reusing what it can from the previous run.
import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { analyze } from './analyze.ts'
import type { AnalyzeOptions } from './analyze.ts'
import { ConfigSchema } from './config.ts'

const { watch, ...options } = workerData as Omit<AnalyzeOptions, 'log'> & { watch?: boolean }
// The config came parsed by the process that started this worker. A long-running `serve` parsed it with
// the schema it started with, while this worker runs the code on disk: parse it again here, so a block
// added since then gets its defaults.
if (options.config) options.config = ConfigSchema.parse(options.config)
const session = watch ? new Map<string, unknown>() : undefined
const run = () => analyze({ ...options, session, log: msg => parentPort!.postMessage({ log: msg }) })

parentPort!.postMessage({ graph: await run() })
if (watch)
  parentPort!.on('message', async () => {
    const t0 = performance.now()
    try {
      parentPort!.postMessage({ graph: await run(), ms: Math.round(performance.now() - t0) })
    } catch (err) {
      parentPort!.postMessage({ error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
    }
  })
