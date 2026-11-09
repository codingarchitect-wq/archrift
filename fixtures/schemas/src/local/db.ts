import { Dexie, type Table } from '../lib/fake-dexie'
import { DB_NAME } from './names'

export interface Item {
  id: string
  name: string
  email: string
  tags: string[]
}
export interface Draft {
  at: number
}
export interface Old {
  id: string
}

export class ShopDB extends Dexie {
  items!: Table<Item>
  drafts!: Table<Draft, number>
  old!: Table<Old>

  constructor() {
    super(DB_NAME)
    const v1 = {
      items: '++id, name',
      old: 'id',
    }
    this.version(1).stores(v1)
    const v2 = { ...v1, items: 'id, &email, *tags, [name+email]' }
    this.version(2).stores(v2).upgrade(() => {})
    this.version(3).stores({ old: null })
  }
}

export const db = new ShopDB()
// a later version, declared outside the class
db.version(4).stores({ drafts: '++, at', settings: 'key' })

export async function firstItem() {
  return db.items.get('1')
}
