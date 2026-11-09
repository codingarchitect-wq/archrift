import { Dexie, type Table } from '../lib/fake-libs'

export class AppDB extends Dexie {
  accounts!: Table<{ id: string; name: string }>

  constructor() {
    super('app')
  }
}

export const db = new AppDB()
