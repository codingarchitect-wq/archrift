import { procedure, router } from '../trpc'

export const accountsRouter = router({
  list: procedure.query(async ({ ctx }) => ctx.prisma.account.findMany({ where: { userId: ctx.userId } })),
  create: procedure.input({ name: '' }).mutation(async ({ ctx, input }) => ctx.prisma.account.create({ data: input })),
})
