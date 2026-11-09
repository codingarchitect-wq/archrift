import { db } from './db'

export async function localAccounts() {
  return db.accounts.where('name').toArray()
}

export async function saveAccount(name: string) {
  return db.accounts.put({ id: name, name })
}
