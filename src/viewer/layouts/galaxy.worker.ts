// Runs the galaxy simulation off the main thread, reporting progress.
import { simulateGalaxy } from './galaxy.ts'
import type { GalaxyInput } from './galaxy.ts'

const scope = globalThis as unknown as { postMessage(message: unknown): void; onmessage: ((e: MessageEvent) => void) | null }

scope.onmessage = (e: MessageEvent<{ id: number; input: GalaxyInput }>) => {
  const { id, input } = e.data
  const positions = simulateGalaxy(input, done => scope.postMessage({ id, progress: done }))
  scope.postMessage({ id, positions })
}
