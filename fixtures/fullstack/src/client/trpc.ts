import type { Procedure } from '../server/trpc'
import type { appRouter } from '../server/routers'

type Client<R> = {
  [K in keyof R]: R[K] extends Procedure<infer I, infer O> ? { query(input?: I): Promise<Awaited<O>>; mutate(input: I): Promise<Awaited<O>> } : Client<R[K]>
}

export const trpc = {} as Client<typeof appRouter>
