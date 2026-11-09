// Runs the coherence clouds' layout off the main thread, reporting progress.
import { simulateCloud } from './cloud.ts'
import type { CloudInput } from './cloud.ts'

const scope = globalThis as unknown as { postMessage(message: unknown): void; onmessage: ((e: MessageEvent) => void) | null }

scope.onmessage = (e: MessageEvent<{ id: number; input: CloudInput }>) => {
  const { id, input } = e.data
  const positions = simulateCloud(input, done => scope.postMessage({ id, progress: done }))
  scope.postMessage({ id, positions })
}
