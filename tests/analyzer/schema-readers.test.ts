import { describe, expect, it } from 'vitest'
import { parseSchema } from '../../src/analyzer/plugins/prisma.ts'
import { parseStores } from '../../src/analyzer/plugins/schema-dexie.ts'
import { prismaDatabases } from '../../src/analyzer/plugins/schema-prisma.ts'
import type { TableMeta } from '../../src/core/model.ts'

/** A table's columns as `name type flags`, the way an ERD lists them. */
const columns = (t: TableMeta) =>
  t.columns.map(c => [c.name, c.type ?? '', ...(['pk', 'nullable', 'unique', 'generated', 'virtual'] as const).filter(f => c[f]), c.target ? `-> ${c.target}` : ''].filter(Boolean).join(' '))

describe('Prisma attributes', () => {
  it('reads keys, maps, defaults, relations with their referential actions, and block attributes', () => {
    const text = [
      'datasource db {',
      '  provider = "mysql"',
      '}',
      'model Post {',
      '  id       String @id @default(uuid()) @db.Char(36)',
      '  title    String @default("a // b") // a comment',
      '  authorId Int    @map("author_id")',
      '  author   Author @relation("Writes", fields: [authorId], references: [id], onDelete: SetNull)',
      '  @@unique([title, authorId], where: { title: { not: "" } }, map: "post_title")',
      '  @@map("posts")',
      '}',
      'model Author {',
      '  id    Int    @id @default(autoincrement()) @map("author_id")',
      '  posts Post[] @relation("Writes")',
      '}',
    ].join('\n')
    const [d] = prismaDatabases('schema.prisma', text, parseSchema(text), '')
    expect(d).toMatchObject({ id: 'db:prisma:db', engine: 'mysql' })
    const posts = d.tables.find(t => t.name === 'posts')!
    expect(columns(posts)).toEqual(['id String pk generated', 'title String', 'author_id Int', 'author Author virtual -> Author'])
    expect(posts.references).toEqual([{ columns: ['author_id'], table: 'Author', to: ['author_id'], onDelete: 'SetNull' }])
    expect(posts.indexes).toEqual([{ columns: ['title', 'author_id'], unique: true, name: 'post_title' }])
  })
})

describe('Dexie stores', () => {
  it('reads the key and the indexes the way Dexie does', () => {
    expect(parseStores('++id, &email, *tags, [first+last], address.city')).toEqual({
      columns: [{ name: 'id', pk: true, generated: true }, { name: 'email' }, { name: 'tags' }, { name: 'first' }, { name: 'last' }, { name: 'address.city' }],
      indexes: [{ columns: ['email'], unique: true }, { columns: ['tags'], multiEntry: true }, { columns: ['first', 'last'] }, { columns: ['address.city'] }],
    })
    expect(parseStores('[a+b], c').columns.filter(c => c.pk).map(c => c.name)).toEqual(['a', 'b'])
    expect(parseStores(', at').columns).toEqual([{ name: 'at' }])
  })
})
