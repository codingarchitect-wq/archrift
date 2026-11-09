import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyzer/analyze.ts'
import { ConfigSchema } from '../../src/analyzer/config.ts'
import { archifyArchitecture } from '../../src/core/archify/architecture.ts'
import { archifyClass, attributeOf, methodOf } from '../../src/core/archify/classes.ts'
import { Ids } from '../../src/core/archify/common.ts'
import { archifyErd } from '../../src/core/archify/erd.ts'
import type { ClassDiagram } from '../../src/core/classes.ts'
import type { DatabaseMeta, TableMeta } from '../../src/core/model.ts'
import { archifyProblems, archifySchema } from '../helpers/archify-schema.ts'
import { FIXTURES } from '../helpers/fixtures.ts'

const table = (name: string, t: Partial<TableMeta>): TableMeta => ({ name, kind: 'table', nodes: [`s:prisma/schema.prisma#${name}`], columns: [], references: [], indexes: [], ...t })

/** A small schema with the cases an ERD has to tell apart. */
const db: DatabaseMeta = {
  id: 'db:prisma:db',
  name: 'db',
  engine: 'postgres',
  sources: ['prisma'],
  module: '',
  tables: [
    table('Account', { columns: [{ name: 'id', type: 'String', pk: true }, { name: 'iban', type: 'String', unique: true }, { name: 'transactions', type: 'Transaction[]', virtual: true, target: 'Transaction' }] }),
    table('Transaction', {
      columns: [{ name: 'id', type: 'String', pk: true }, { name: 'accountId', type: 'String' }, { name: 'amount', type: 'Decimal' }],
      references: [{ columns: ['accountId'], table: 'Account', to: ['id'] }],
    }),
    // a tree: categories under categories
    table('Category', { columns: [{ name: 'id', type: 'String', pk: true }, { name: 'parentId', type: 'String?', nullable: true }], references: [{ columns: ['parentId'], table: 'Category', to: ['id'] }] }),
    // one budget per category
    table('Budget', {
      columns: [{ name: 'id', type: 'String', pk: true }, { name: 'categoryId', type: 'String', unique: true }],
      references: [{ columns: ['categoryId'], table: 'Category', to: ['id'] }, { columns: ['id'], table: 'Elsewhere', to: ['id'] }],
    }),
    // a junction table keyed by its two foreign keys
    table('GoalAccount', {
      columns: [{ name: 'goalId', type: 'String', pk: true }, { name: 'accountId', type: 'String', pk: true }],
      references: [{ columns: ['accountId'], table: 'Account', to: ['id'] }],
    }),
  ],
}

describe('archify ERD', () => {
  const erd = archifyErd(db, { project: 'shop' })

  it('is valid archify JSON', () => {
    expect(archifySchema('erd').safeParse(erd).error?.issues).toBeUndefined()
    expect(archifyProblems(erd)).toEqual([])
  })

  it('draws the stored columns with their key roles, relation fields left out', () => {
    expect(erd.meta).toEqual({ title: 'db · PostgreSQL', subtitle: '5 tables, read by archrift from prisma', output: 'shop.db.erd.html', quality_profile: 'showcase' })
    expect(erd.entities.find(e => e.id === 'Account')!.attributes).toEqual([{ name: 'id', type: 'String', key: 'pk' }, { name: 'iban', type: 'String', key: 'uk' }])
    expect(erd.entities.find(e => e.id === 'GoalAccount')!.attributes[1]).toEqual({ name: 'accountId', type: 'String', key: ['pk', 'fk'], references: 'Account.id' })
  })

  it('reads each foreign key child to parent: many or one, optional when nullable, identifying when part of the key', () => {
    const rel = (from: string, to: string) => erd.relationships.find(r => r.from === from && r.to === to)
    expect(rel('Transaction', 'Account')).toMatchObject({ fromCardinality: 'many', toCardinality: 'one', identifying: false })
    expect(rel('Budget', 'Category')).toMatchObject({ fromCardinality: 'one', toCardinality: 'one' })
    expect(rel('GoalAccount', 'Account')).toMatchObject({ identifying: true })
    // archify joins two tables: a table's key to itself, and one to another database, go into cards
    expect(rel('Category', 'Category')).toBeUndefined()
    expect(erd.cards).toEqual([
      { dot: 'violet', title: 'Foreign keys to their own table', items: ['Category.parentId → Category'] },
      { dot: 'slate', title: 'Foreign keys to tables outside this database', items: ['Budget.id → Elsewhere'] },
    ])
  })

  it('puts tables that point at each other side by side, the most connected first', () => {
    const at = (id: string) => erd.entities.find(e => e.id === id)!
    expect([at('Account').row, at('Account').col]).toEqual([0, 0])
    expect(at('Transaction').row).toBe(0)
  })

  it('refuses an empty database', () => {
    expect(() => archifyErd({ ...db, tables: [] }, { project: 'x' })).toThrow(/has no tables/)
  })
})

const diagram: ClassDiagram = {
  title: 'OrderStore',
  types: [
    { id: 's:src/lib/order-store.ts#OrderStore', name: 'OrderStore', kind: 'interface', path: 'src/lib/order-store.ts', members: [{ id: 'm1', name: 'getAccounts', kind: 'method', signature: 'getAccounts(): Promise<Account[]>' }] },
    { id: 's:src/lib/cloud.ts#CloudOrderStore', name: 'CloudOrderStore', kind: 'class', path: 'src/lib/cloud.ts', members: [{ id: 'm2', name: 'client', kind: 'property', signature: 'private readonly client: TrpcClient' }] },
    { id: 's:src/lib/local.ts#LocalOrderStore', name: 'LocalOrderStore', kind: 'class', members: [] },
    { id: 's:src/lib/local.parts.ts#LocalOrderStoreParts', name: 'LocalOrderStoreParts', kind: 'class', members: [{ id: 'm3', name: 'constructor', kind: 'constructor', signature: 'constructor(db: ShopDB)' }] },
    { id: 's:src/types/index.ts#Account', name: 'Account', kind: 'interface', members: [] },
  ],
  relations: [
    { from: 's:src/lib/cloud.ts#CloudOrderStore', to: 's:src/lib/order-store.ts#OrderStore', kind: 'implements' },
    { from: 's:src/lib/local.ts#LocalOrderStore', to: 's:src/lib/order-store.ts#OrderStore', kind: 'implements' },
    { from: 's:src/lib/local.ts#LocalOrderStore', to: 's:src/lib/local.parts.ts#LocalOrderStoreParts', kind: 'extends' },
    { from: 's:src/lib/order-store.ts#OrderStore', to: 's:src/types/index.ts#Account', kind: 'association', label: 'accounts', many: true },
  ],
}

describe('archify class diagram', () => {
  const doc = archifyClass(diagram, { project: 'shop' })
  const type = (name: string) => doc.types.find(t => t.label === name)!

  it('is valid archify JSON', () => {
    expect(archifySchema('class').safeParse(doc).error?.issues).toBeUndefined()
    expect(archifyProblems(doc)).toEqual([])
  })

  it('draws implementing classes as realizations and a subclass as inheritance', () => {
    expect(doc.relationships.map(r => [r.from, r.kind, r.to, r.label])).toEqual([
      ['s-src-lib-cloud-ts-CloudOrderStore', 'realization', 's-src-lib-order-store-ts-OrderStore', undefined],
      ['s-src-lib-local-ts-LocalOrderStore', 'realization', 's-src-lib-order-store-ts-OrderStore', undefined],
      ['s-src-lib-local-ts-LocalOrderStore', 'inheritance', 's-src-lib-local-parts-ts-LocalOrderStoreParts', undefined],
      ['s-src-lib-order-store-ts-OrderStore', 'association', 's-src-types-index-ts-Account', 'accounts [*]'],
    ])
  })

  it('puts supertypes in rows above their subtypes', () => {
    expect(type('OrderStore').row).toBe(0)
    expect(type('LocalOrderStoreParts').row).toBe(0)
    expect(type('CloudOrderStore').row).toBe(1)
    expect(type('LocalOrderStore').row).toBe(1)
  })

  it('reads attributes and methods from the signatures', () => {
    expect(type('OrderStore').methods).toEqual([{ name: 'getAccounts', returns: 'Promise<Account[]>', abstract: true }])
    expect(type('CloudOrderStore').attributes).toEqual([{ name: 'client', type: 'TrpcClient', visibility: 'private' }])
    expect(type('LocalOrderStoreParts').methods).toEqual([{ name: 'constructor', parameters: 'db: ShopDB' }])
    expect(methodOf({ id: 'x', name: 'load', kind: 'method', signature: 'static async load(id: string, opts?: { force: boolean }): Promise<Map<string, number>>' }, 'class')).toEqual({
      name: 'load',
      parameters: 'id: string, opts?: { force: boolean }',
      returns: 'Promise<Map<string, number>>',
      static: true,
    })
    expect(attributeOf({ id: 'x', name: 'ttl', kind: 'property', signature: 'protected static ttl?: number = 30' })).toEqual({ name: 'ttl', type: 'number', visibility: 'protected', static: true })
  })
})

describe('archify architecture', () => {
  it('draws the blocks a row per layer they keep, UI blocks as frontends, imports between them as connections', async () => {
    const graph = await analyze({
      root: path.join(FIXTURES, 'vite-app'),
      config: ConfigSchema.parse({ exclude: ['src/generated/**', 'public/**'], entrypoints: ['src/main.tsx', 'scripts/seed.ts'] }),
      cacheDir: false,
      history: false,
    })
    const doc = archifyArchitecture(graph, { project: 'vite-app' })
    expect(archifySchema('architecture').safeParse(doc).error?.issues).toBeUndefined()
    expect(archifyProblems(doc)).toEqual([])
    const rowOf = (label: string) => doc.components.find(c => c.label === label)!.row
    // main.tsx → App → pages → components and hooks → lib
    expect(rowOf('src (top files)')).toBeLessThan(rowOf('pages'))
    expect(rowOf('pages')).toBeLessThan(rowOf('components'))
    expect(rowOf('components')).toBeLessThan(rowOf('lib'))
    expect(doc.components.find(c => c.label === 'pages')).toMatchObject({ type: 'frontend', sublabel: 'src/pages · 1 file' })
    expect(doc.components.find(c => c.label === 'lib')!.type).toBe('backend')
    expect(doc.connections.map(c => `${c.from} → ${c.to}`)).toContain('src-pages → src-components')
  })
})

describe('archify ids', () => {
  it('are made from names, the same name always the same id, never two alike', () => {
    const ids = new Ids()
    expect([ids.of('src/lib'), ids.of('2fa'), ids.of('src lib'), ids.of('src/lib')]).toEqual(['src-lib', 't-2fa', 'src-lib-2', 'src-lib'])
  })
})
