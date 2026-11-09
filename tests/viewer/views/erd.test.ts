import { describe, expect, it } from 'vitest'
import type { DatabaseMeta, TableMeta } from '../../../src/core/model.ts'
import type { FileDetails } from '../../../src/server/views.ts'
import { focusOn } from '../../../src/viewer/views/diagram-kit/scene.ts'
import { cardFor } from '../../../src/viewer/views/erd/decoration.ts'
import { databasesShown, erdScene, headingOf, tableCard } from '../../../src/viewer/views/erd/model.ts'
import type { ErdScene } from '../../../src/viewer/views/erd/model.ts'
import { usesOf } from '../../../src/viewer/views/erd/uses.ts'

// ── a made-up schema: users, their accounts and transactions, a category tree, and many tables owned by a user ──

const table = (name: string, columns: TableMeta['columns'], references: TableMeta['references'] = [], extra: Partial<TableMeta> = {}): TableMeta => ({
  name,
  kind: 'table',
  nodes: [`s:prisma/schema.prisma#${name}`],
  columns,
  references,
  indexes: [],
  ...extra,
})
const id = { name: 'id', type: 'String', pk: true }
const owned = (name: string) => table(name, [id, { name: 'userId', type: 'String' }], [{ columns: ['userId'], table: 'User', to: ['id'] }])

const shop: DatabaseMeta = {
  id: 'db:prisma:db',
  name: 'db',
  engine: 'postgres',
  sources: ['prisma'],
  module: '',
  tables: [
    table('User', [id, { name: 'email', type: 'String', unique: true }, { name: 'accounts', type: 'Account[]', virtual: true, target: 'Account' }]),
    table('Account', [id, { name: 'userId', type: 'String' }, { name: 'iban', type: 'String?', nullable: true }], [{ columns: ['userId'], table: 'User', to: ['id'] }]),
    table(
      'Transaction',
      [id, { name: 'accountId', type: 'String' }, { name: 'categoryId', type: 'String?', nullable: true }, { name: 'userId', type: 'String' }],
      [
        { columns: ['accountId'], table: 'Account', to: ['id'] },
        { columns: ['categoryId'], table: 'Category', to: ['id'] },
        { columns: ['userId'], table: 'User', to: ['id'] },
      ],
    ),
    table('Category', [id, { name: 'parentId', type: 'String?', nullable: true }, { name: 'userId', type: 'String' }], [
      { columns: ['parentId'], table: 'Category', to: ['id'] },
      { columns: ['userId'], table: 'User', to: ['id'] },
    ]),
    table('Session', [id, { name: 'userId', type: 'String', unique: true }], [{ columns: ['userId'], table: 'User', to: ['id'] }]),
    owned('Budget'),
    owned('Goal'),
    table('MagicLink', [id, { name: 'token', type: 'String' }], [], { indexes: [{ columns: ['token'], unique: true }] }),
  ],
}

const local: DatabaseMeta = {
  id: 'db:dexie:AppDB',
  name: 'AppDB',
  engine: 'indexeddb',
  sources: ['dexie'],
  module: '',
  tables: [table('accounts', [{ name: 'id', pk: true }, { name: 'iban', unique: true }], [], { nodes: ['s:src/local/db.ts#AppDB.accounts'], entity: 'LocalAccount' })],
}

const orders: DatabaseMeta = { id: 'x:db:mysql:orders', name: 'orders', engine: 'mysql', sources: ['sql', 'jpa'], module: 'order-service', node: 'x:db:mysql:orders', tables: [table('orders', [{ name: 'id', type: 'BIGINT', pk: true }])] }

const scene = (o: Partial<Parameters<typeof erdScene>[1]> = {}) => erdScene([orders, shop, local], { database: null, relations: false, aspect: 1.6, ...o })
const titles = (s: ErdScene) => s.cards.map(c => c.content.title)
const link = (s: ErdScene, k: number) => `${s.cards[s.links[k].from].content.title} → ${s.cards[s.links[k].to].content.title}`

describe('the ERD’s boards', () => {
  it('is one board per database, the root module’s first, each headed by its name, engine and sources, its module and size above', () => {
    const s = scene()
    expect(s.boards.map(b => b.heading)).toEqual(['AppDB · IndexedDB · Dexie', 'db · PostgreSQL · Prisma', 'orders · MySQL · SQL, JPA'])
    expect(s.boards.map(b => b.caption)).toEqual(['Entity–relationship diagram · 1 table', 'Entity–relationship diagram · 8 tables', 'Entity–relationship diagram · order-service · 1 table'])
    expect(headingOf(orders)).toBe('orders · MySQL · SQL, JPA')
    // nothing overlaps: boards, and the cards on each
    for (const [i, a] of s.boards.entries())
      for (const b of s.boards.slice(i + 1)) expect(a.u + a.w <= b.u || b.u + b.w <= a.u || a.v + a.h <= b.v || b.v + b.h <= a.v).toBe(true)
    for (const c of s.cards) {
      const b = s.boards[c.board]
      expect(c.u >= b.u && c.v >= b.v && c.u + c.shape.w <= b.u + b.w && c.v + c.shape.h <= b.v + b.h, c.content.title).toBe(true)
    }
    expect(scene()).toEqual(s)
  })

  it('shows one database when asked, and says how many it left out', () => {
    const s = scene({ database: 'db:dexie:AppDB' })
    expect(titles(s)).toEqual(['accounts'])
    expect(s.hidden).toBe(2)
    expect(databasesShown([orders, shop], null).map(d => d.name)).toEqual(['db', 'orders'])
  })
})

describe('a table’s card', () => {
  it('has a row per stored column: a key for the primary key, FK and UQ tags, the type with a nullable one quiet', () => {
    const card = tableCard(shop.tables[2], false)
    expect(card.title).toBe('Transaction')
    expect(card.sections[0].map(r => [r.key ? 'key' : r.tag ?? '', r.name, r.detail, r.quiet ? 'quiet' : ''])).toEqual([
      ['key', 'id', 'String', ''],
      ['FK', 'accountId', 'String', ''],
      ['FK', 'categoryId', 'String?', 'quiet'],
      ['FK', 'userId', 'String', ''],
    ])
    // a column with a node of its own selects it (the view checks the viewer knows it)
    expect(card.sections[0][1].id).toBe('s:prisma/schema.prisma#Transaction.accountId')
    // unique by its own flag or by a one-column unique index
    expect(tableCard(shop.tables[0], false).sections[0][1].tag).toBe('UQ')
    expect(tableCard(shop.tables[7], false).sections[0][1].tag).toBe('UQ')
  })

  it('shows relation fields only when asked, quiet, leading to their table', () => {
    expect(tableCard(shop.tables[0], false).sections[0].map(r => r.name)).toEqual(['id', 'email'])
    expect(tableCard(shop.tables[0], true).sections[0][2]).toMatchObject({ name: 'accounts', detail: '→ Account', quiet: true })
    // the entity's name, when the table's differs
    expect(tableCard(local.tables[0], false).aside).toBe('LocalAccount')
  })

  it('shows its first rows and "+N more"; selected, it opens with all of them', () => {
    const wide = table('Wide', [id, ...Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, type: 'Int' }))])
    const s = erdScene([{ ...orders, tables: [wide] }], { database: null, relations: false, aspect: 1.6 })
    const rows = s.cards[0].shape.sections[0].rows
    expect(rows).toHaveLength(12)
    expect(rows[11].more).toBe(10)
    expect(s.cards[0].full?.sections[0].rows).toHaveLength(21)
  })
})

describe('foreign keys', () => {
  const s = scene()
  const shopLinks = s.links.map((_, k) => link(s, k))

  it('join the referencing row to the referenced one, parents left of the tables referencing them', () => {
    // the most referenced tables come first; a table referencing itself loops on its side
    expect(shopLinks).toEqual(['Category → Category', 'Transaction → Account', 'Transaction → Category'])
    const [tx, account] = [s.links[1].from, s.links[1].to].map(i => s.cards[i])
    expect(account.u + account.shape.w).toBeLessThan(tx.u)
    const line = s.links[1].points
    // out of Transaction's left side at its accountId row, into Account's right side at its id row
    expect(line[0][0]).toBeCloseTo(tx.u)
    expect(line[0][1]).toBeGreaterThan(tx.v + tx.shape.band + 1.5)
    expect(line[line.length - 1][0]).toBeCloseTo(account.u + account.shape.w)
  })

  it('end in crow’s feet: many unless the key is unique, optional when it may be null', () => {
    expect(s.links.map(l => `${l.start} ${l.end}`)).toEqual(['crow-ring bar-ring', 'crow-ring bar', 'crow-ring bar-ring'])
    // a session per user: one to one
    const session = s.arcs.find(a => s.cards[a.from].content.title === 'Session')!
    expect([session.start, session.end]).toEqual(['bar-ring', 'bar'])
  })

  it('to a table nearly every other one references are arcs, shown while one end is selected', () => {
    expect(s.arcs.map(a => `${s.cards[a.from].content.title} → ${s.cards[a.to].content.title}`).sort()).toEqual([
      'Account → User',
      'Budget → User',
      'Category → User',
      'Goal → User',
      'Session → User',
      'Transaction → User',
    ])
    const user = titles(s).indexOf('User')
    const focus = focusOn(s, user)!
    expect([...focus.cards].map(i => s.cards[i].content.title).sort()).toEqual(['Account', 'Budget', 'Category', 'Goal', 'Session', 'Transaction', 'User'])
    expect(focus.arcs.size).toBe(6)
    expect(focus.links.size).toBe(0)
  })

  it('light the selected table’s neighbors and the connectors between them; a column selects its table', () => {
    const account = cardFor(s, 's:prisma/schema.prisma#Account')!
    expect(s.cards[account].content.title).toBe('Account')
    expect(cardFor(s, 's:prisma/schema.prisma#Account.iban')).toBe(account)
    expect(cardFor(s, 's:src/local/db.ts#AppDB.accounts')).toBe(titles(s).indexOf('accounts'))
    expect(cardFor(s, 'f:prisma/schema.prisma')).toBeUndefined()
    const focus = focusOn(s, account)!
    expect([...focus.cards].map(i => s.cards[i].content.title).sort()).toEqual(['Account', 'Transaction', 'User'])
    expect([...focus.links].map(k => link(s, k))).toEqual(['Transaction → Account'])
  })
})

describe('who reads and writes a table', () => {
  const edge = (source: string, target: string, subkind: string | undefined, count = 1) => ({ source, target, kind: 'queries' as const, subkind, count, targets: ['web'], confidence: 'exact' as const, sites: [] })
  const details = (edges: ReturnType<typeof edge>[]): FileDetails => ({ file: 'f:prisma/schema.prisma', symbols: [], edges, endpoints: [] })

  it('are the files querying any of its nodes, by what they do, the most references first', () => {
    const nodes = new Set(['s:prisma/schema.prisma#Account'])
    const d = details([
      edge('s:src/server/routers/accounts.ts#accountsRouter.list', 's:prisma/schema.prisma#Account', 'read', 2),
      edge('s:src/server/routers/accounts.ts#accountsRouter.create', 's:prisma/schema.prisma#Account', 'write'),
      edge('s:src/server/routers/accounts.ts#accountsRouter.update', 's:prisma/schema.prisma#Account', 'write'),
      edge('s:src/lib/seed.ts#seed', 's:prisma/schema.prisma#Account', 'write', 4),
      edge('s:src/lib/stats.ts#count', 's:prisma/schema.prisma#Account', 'read'),
      edge('s:src/lib/stats.ts#count', 's:prisma/schema.prisma#User', 'read'),
      edge('f:scripts/raw.ts', 's:prisma/schema.prisma#Account', undefined),
    ])
    // the same edge arrives with each file's details it touches: counted once
    const uses = usesOf([d, d], nodes)
    expect(uses.reads.map(u => `${u.name} ${u.count}`)).toEqual(['accounts.ts 2', 'stats.ts 1'])
    expect(uses.writes.map(u => `${u.folder}/${u.name} ${u.count}`)).toEqual(['src/lib/seed.ts 4', 'src/server/routers/accounts.ts 2'])
    expect(uses.other.map(u => u.file)).toEqual(['f:scripts/raw.ts'])
  })
})
