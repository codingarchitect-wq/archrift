// A tiny stand-in for tRPC with the same shape: routers of procedures.
export interface Procedure<I, O> {
  type: 'query' | 'mutation'
  resolve: (opts: { ctx: Context; input: I }) => O
}

export interface Context {
  prisma: typeof prisma
  userId: string
}

export const prisma = {
  account: {
    findMany: async (_args?: unknown) => [] as { id: string; name: string }[],
    create: async (args: { data: { name: string } }) => ({ id: '1', ...args.data }),
  },
  user: { findUnique: async (_args: unknown) => null },
}

const builder = {
  input<I>(_schema: I) {
    return {
      mutation<O>(resolve: (opts: { ctx: Context; input: I }) => O): Procedure<I, O> {
        return { type: 'mutation', resolve }
      },
    }
  },
  query<O>(resolve: (opts: { ctx: Context; input: void }) => O): Procedure<void, O> {
    return { type: 'query', resolve }
  },
}

export const procedure = builder

export function router<T extends Record<string, unknown>>(routes: T): T {
  return routes
}
