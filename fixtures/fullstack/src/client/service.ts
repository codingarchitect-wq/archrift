import { trpc } from './trpc'

export class CloudService {
  getAccounts() {
    return trpc.accounts.list.query()
  }

  createAccount(name: string) {
    return trpc.accounts.create.mutate({ name })
  }
}
