import { describe, expect, it } from 'vitest'
import { snakeCase } from '../../src/analyzer/plugins/schema-entities.ts'
import { dumpGraph } from '../../src/core/dump.ts'
import type { DatabaseMeta, TableMeta } from '../../src/core/model.ts'
import { analyzeFixture, node } from '../helpers/fixtures.ts'

const ORDERS = 'services/orders/src/main/kotlin/com/acme/orders'
const MIGRATIONS = 'services/orders/src/main/resources/db/migration/mysql'

/** A table's columns as `name type flags`, the way an ERD lists them. */
const columns = (t: TableMeta) =>
  t.columns.map(c => [c.name, c.type ?? '', ...(['pk', 'nullable', 'unique', 'generated', 'virtual'] as const).filter(f => c[f]), c.target ? `-> ${c.target}` : ''].filter(Boolean).join(' '))

describe('schemas fixture: meta.databases', async () => {
  const g = await analyzeFixture('schemas')
  const dbs = g.meta.databases ?? []
  const db = (id: string): DatabaseMeta => {
    const found = dbs.find(d => d.id === id)
    if (!found) throw new Error(`no database ${id} in ${dbs.map(d => d.id).join(', ')}`)
    return found
  }
  const table = (dbId: string, name: string): TableMeta => {
    const found = db(dbId).tables.find(t => t.name === name)
    if (!found) throw new Error(`no table ${name} in ${dbId}: ${db(dbId).tables.map(t => t.name).join(', ')}`)
    return found
  }

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/schemas.txt')
  })

  it('finds one database per Prisma datasource, Dexie class and service store, and nothing from tests or Prisma migrations', () => {
    expect(dbs.map(d => `${d.id} ${d.engine} ${d.sources.join('+')}`)).toEqual([
      'db:dexie:shop-local indexeddb dexie',
      'db:prisma:db postgres prisma',
      'db:sql:services/billing postgres sql',
      'x:db:mongodb:order-events mongodb mongo',
      'x:db:mysql:orders mysql sql+jpa',
    ])
    const tables = dbs.flatMap(d => d.tables.map(t => t.name))
    expect(tables).not.toContain('test_only_entity')
    expect(g.meta.counts).toMatchObject({ databases: 5, tables: 21, foreignKeys: 7 })
  })

  it('Prisma: mapped names, keys, defaults the database fills, relations and indexes', () => {
    const users = table('db:prisma:db', 'users')
    expect(users).toMatchObject({ entity: 'User', kind: 'table', nodes: ['s:prisma/schema.prisma#User'] })
    expect(columns(users)).toEqual(['id Int pk generated', 'email_address String unique', 'homepage String? nullable', 'accounts Account[] virtual -> Account', 'created_at DateTime'])
    const account = table('db:prisma:db', 'Account')
    expect(account.references).toEqual([{ columns: ['user_id'], table: 'users', to: ['id'], name: 'fk_account_user', onDelete: 'Cascade' }])
    expect(account.indexes).toEqual([
      { columns: ['user_id', 'number'], unique: true, name: 'account_user_number_key' },
      { columns: ['user_id', 'kind'] },
    ])
    expect(columns(table('db:prisma:db', 'Posting')).slice(0, 2)).toEqual(['accountId String pk', 'seq Int pk'])
    expect(table('db:prisma:db', 'Balance').kind).toBe('view')
    expect(db('db:prisma:db').tables.map(t => t.name)).not.toContain('AccountKind')
    // the column's line is the field's
    expect(users.columns.find(c => c.name === 'email_address')?.line).toBe(11)
  })

  it("Dexie: the database's name through a constant, each table's last stores() across versions, a deleted one gone", () => {
    const shop = db('db:dexie:shop-local')
    expect(shop.tables.map(t => t.name)).toEqual(['drafts', 'items', 'settings'])
    const items = table('db:dexie:shop-local', 'items')
    expect(items).toMatchObject({ entity: 'Item', nodes: ['s:src/local/db.ts#ShopDB.items'] })
    // version 2 replaced `++id, name`
    expect(columns(items)).toEqual(['id pk', 'email unique', 'tags', 'name'])
    expect(items.indexes).toEqual([{ columns: ['email'], unique: true }, { columns: ['tags'], multiEntry: true }, { columns: ['name', 'email'] }])
    // `++, at` (version 4, outside the class): an outbound key, no key column
    expect(columns(table('db:dexie:shop-local', 'drafts'))).toEqual(['at'])
    // a table declared only in stores() has no member: the class stands for it
    expect(table('db:dexie:shop-local', 'settings').nodes).toEqual(['s:src/local/db.ts#ShopDB'])
  })

  it('SQL migrations: applied in Flyway order, ALTERs and later indexes included, a view, the test engine and the snapshot left out', () => {
    const orders = db('x:db:mysql:orders')
    expect(orders).toMatchObject({ name: 'orders', node: 'x:db:mysql:orders', module: 'services/orders' })
    expect(orders.tables.map(t => t.name)).toEqual(['audit_entry', 'audit_log', 'customer', 'customer_tag', 'open_orders', 'parcel_shipment', 'payment', 'purchase_order', 'refund', 'shipment'])
    const po = table('x:db:mysql:orders', 'purchase_order')
    // V1_1 adds note after number, V2 widens number, V10 (after V2) makes it unique
    expect(columns(po).slice(0, 6)).toEqual(['id BIGINT pk generated', 'version BIGINT', 'customer_id BIGINT', 'number VARCHAR(40) unique', 'note VARCHAR(200) nullable', 'placed_at DATETIME(6)'])
    expect(po.references).toEqual([{ columns: ['customer_id'], table: 'customer', to: ['id'], name: 'FK_Order_Customer', onDelete: 'CASCADE' }])
    expect(po.indexes).toEqual([
      { columns: ['placed_at'], name: 'IX_Order_Placed' },
      { columns: ['number'], unique: true, name: 'UK_Order_Number' },
    ])
    // CHANGE renamed name; V10 dropped version and added it again, at the end
    expect(table('x:db:mysql:orders', 'customer').columns.map(c => c.name)).toEqual(['id', 'display_name', 'street_name', 'town', 'version', 'orders', 'tags'])
    expect(table('x:db:mysql:orders', 'open_orders')).toMatchObject({ kind: 'view', nodes: [`s:${MIGRATIONS}/R__views.sql#open_orders`] })
  })

  it('SQL scripts: used when a module has no migrations; PostgreSQL quoting, the public schema, a key to a primary key', () => {
    const billing = db('db:sql:services/billing')
    expect(billing).toMatchObject({ name: 'billing', engine: 'postgres', module: 'services/billing' })
    expect(billing.node).toBeUndefined()
    const invoice = table('db:sql:services/billing', 'invoice')
    expect(columns(invoice)).toEqual(['id SERIAL pk generated', 'amount NUMERIC(10, 2)', 'account_id TEXT', 'issued_at TIMESTAMP WITH TIME ZONE nullable'])
    expect(invoice.references).toEqual([{ columns: ['account_id'], table: 'account', to: ['id'], onDelete: 'SET NULL' }])
    expect(table('db:sql:services/billing', 'account').nodes).toEqual(['s:services/billing/src/main/resources/db/schema-postgres.sql#public.account'])
  })

  it("JPA: an entity joins its SQL table (entity first), Spring's snake_case names, inherited and embedded columns, virtual relations", () => {
    const customer = table('x:db:mysql:orders', 'customer')
    expect(customer).toMatchObject({ entity: 'Customer', nodes: [`s:${ORDERS}/Customer.kt#Customer`, `s:${MIGRATIONS}/V1__init.sql#customer`] })
    // the SQL's columns; a column the entity declares points at its property
    expect(customer.columns.find(c => c.name === 'display_name')?.line).toBe(15)
    // an embedded column, also one the embeddable inherits from its mapped superclass (Place.city, renamed town)
    expect(customer.columns.filter(c => c.line === 17).map(c => c.name)).toEqual(['street_name', 'town'])
    expect(columns(customer).slice(-2)).toEqual(['orders MutableList<PurchaseOrder> virtual -> purchase_order', 'tags MutableSet<String> virtual -> customer_tag'])
    // an element collection's own table, the type as written without the space
    expect(columns(table('x:db:mysql:orders', 'customer_tag'))).toEqual(['customer_id BIGINT', 'tags VARCHAR(50)'])
    // no CREATE TABLE: the entity's own columns, a mapped superclass's first, a join column with its key
    const log = table('x:db:mysql:orders', 'audit_log')
    expect(log.nodes).toEqual([`s:${ORDERS}/AuditLog.kt#AuditLog`])
    expect(columns(log)).toEqual(['id pk generated', 'version Long', 'message String', 'order_id nullable'])
    expect(log.references).toEqual([{ columns: ['order_id'], table: 'purchase_order', to: ['id'] }])
    // a library's entity joins the table of the service that has it
    expect(table('x:db:mysql:orders', 'audit_entry').nodes[0]).toBe('s:libs/audit/src/main/kotlin/com/acme/audit/AuditEntry.kt#AuditEntry')
    expect(dbs.some(d => d.module === 'libs/audit')).toBe(false)
  })

  it('JPA inheritance: single-table subclasses share the root\u2019s table, joined ones have their own with the root\u2019s key', () => {
    const payment = table('x:db:mysql:orders', 'payment')
    expect(payment.nodes).toEqual([`s:${ORDERS}/Payment.kt#Payment`, `s:${ORDERS}/Payment.kt#CardPayment`, `s:${MIGRATIONS}/V1__init.sql#payment`])
    expect(payment.entity).toBe('Payment')
    // the subclass's own column, from the SQL, points at its property
    expect(payment.columns.find(c => c.name === 'card_number')?.line).toBe(15)
    expect(columns(table('x:db:mysql:orders', 'shipment'))).toEqual(['id pk generated', 'version Long', 'carrier String'])
    const parcel = table('x:db:mysql:orders', 'parcel_shipment')
    expect(columns(parcel)).toEqual(['id pk', 'weight Int'])
    expect(parcel.references).toEqual([{ columns: ['id'], table: 'shipment', to: ['id'] }])
    // an @Embeddable with @Table is no entity
    expect(node(g, `s:${ORDERS}/Payment.kt#Money`).tags ?? []).not.toContain('entity')
  })

  it('JPA entity facts, read on their own: embedded overrides, transient and computed properties left out', () => {
    // the entity-only view of Customer, before the SQL wins: what the reader made of its annotations
    const customer = g.nodes.find(n => n.id === `s:${ORDERS}/Customer.kt#Customer`)!
    expect(customer.tags?.filter(t => t.startsWith('table:'))).toEqual(['table:Customer'])
    expect(table('x:db:mysql:orders', 'customer').columns.map(c => c.name)).not.toContain('cached')
    expect(table('x:db:mysql:orders', 'customer').columns.map(c => c.name)).not.toContain('upper')
  })

  it('Mongo: collections named by @Document or the class, `_id` keys, @Field names, @DBRef virtual, indexes', () => {
    const events = table('x:db:mongodb:order-events', 'order_events')
    expect(events).toMatchObject({ kind: 'collection', entity: 'OrderEvent' })
    expect(columns(events)).toEqual(['_id String pk', 'order String', 'sequence Long unique', 'profile CustomerProfile? virtual -> customerProfile', 'at Instant', 'correlation UUID'])
    expect(events.indexes).toEqual([{ columns: ['sequence'], unique: true }, { columns: ['order', 'at'], name: 'by_order_time' }])
    expect(columns(table('x:db:mongodb:order-events', 'customerProfile'))).toEqual(['_id String pk', 'name String? nullable'])
  })

  it('readers and writers stay the queries edges into the tables’ nodes', () => {
    const po = table('x:db:mysql:orders', 'purchase_order')
    const queried = g.edges.filter(e => e.kind === 'queries' && po.nodes.includes(e.target)).map(e => e.source)
    expect(queried).toContain(`s:${ORDERS}/Repositories.kt#OrderRepository.findByNumber`)
    expect(node(g, `s:src/local/db.ts#ShopDB.items`).subkind).toBe('table')
    expect(g.edges.some(e => e.kind === 'queries' && e.target === 's:src/local/db.ts#ShopDB.items')).toBe(true)
  })
})

describe('JPA naming', () => {
  it("is Hibernate's CamelCaseToUnderscores, explicit names too", () => {
    expect(['orderItem', 'OrderItem', 'createdBy_id', 'ORDER_LINE', 'URLPath', 'version2Name', 'a.b'].map(snakeCase)).toEqual([
      'order_item',
      'order_item',
      'created_by_id',
      'order_line',
      'urlpath',
      'version2_name',
      'a_b',
    ])
  })
})

describe('a project without schemas', async () => {
  const g = await analyzeFixture('plain-ts')
  it('has meta.databases, empty: read, none found', () => {
    expect(g.meta.databases).toEqual([])
    expect(g.meta.counts.databases).toBeUndefined()
  })
})
