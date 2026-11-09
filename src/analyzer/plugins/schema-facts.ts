// The `schema` fact channel: what the schema readers find while they extract
// a file (cached with it), for plugins/schemas.ts to assemble into
// `meta.databases`. Dexie classes and their stores() calls come from the
// TypeScript plugin, JPA entities and Mongo documents from the JVM reader's
// second pass, SQL statements from the config reader. Prisma schemas are read
// when the graph is assembled, as the Prisma plugin always has.
import type { ColumnMeta, ForeignKeyMeta, IndexMeta } from '../../core/model.ts'

/** A column as a reader found it; `entity` names the class a virtual column leads to, which becomes its table's name when assembled. */
export interface FactColumn extends ColumnMeta {
  entity?: string
}

/** A foreign key whose target may be known only by its class (JPA): the table and its key columns are filled in when assembled. */
export interface FactForeignKey extends Omit<ForeignKeyMeta, 'table' | 'to'> {
  table?: string
  to?: string[]
  entity?: string
}

/** A JPA entity or a Mongo document, with its names as the code writes them (the module's naming strategy is applied when assembled). */
export interface EntityFact {
  type: 'entity'
  source: 'jpa' | 'mongo'
  /** The entity class. */
  owner: string
  /** The table or collection. */
  name: string
  /** The class's name. */
  entity: string
  /** Single-table inheritance: the root entity whose table this subclass's rows are in. */
  sharesTableOf?: string
  columns: FactColumn[]
  references: FactForeignKey[]
  indexes: IndexMeta[]
}

/** A `class … extends Dexie`: its database name and its table members. */
export interface DexieClassFact {
  type: 'dexie-class'
  /** The class. */
  id: string
  /** The `super('name')` string, else the class's name. */
  name: string
  tables: { name: string; entity?: string; node: string; line: number }[]
}

/** One `version(n).stores({…})` call of a Dexie class, its spreads and constants resolved; a table set to null is deleted. */
export interface DexieStoresFact {
  type: 'dexie-stores'
  /** The class the call belongs to. */
  db: string
  version: number
  stores: Record<string, string | null>
  /** Where each table's entry is written, when in this file. */
  lines: Record<string, number>
}

/** A column definition in a CREATE TABLE or ALTER TABLE, as written. */
export interface DdlColumn extends ColumnMeta {
  /** REFERENCES written on the column itself. */
  references?: ForeignKeyMeta
}

/** One schema change a SQL statement makes, in the file's order. Table names are as written, unquoted (`audit.log`). */
export type DdlOp =
  | { op: 'create'; table: string; kind: 'table' | 'view'; ifNotExists?: boolean; columns: DdlColumn[]; pk: string[]; pkName?: string; references: ForeignKeyMeta[]; indexes: IndexMeta[]; line: number }
  | { op: 'drop'; table: string }
  | { op: 'rename'; table: string; to: string }
  | { op: 'add-column'; table: string; column: DdlColumn; after?: string; first?: boolean; ifNotExists?: boolean }
  | { op: 'drop-column'; table: string; column: string }
  /** MySQL MODIFY (from = column) and CHANGE (from = old name): the whole definition is replaced. */
  | { op: 'replace-column'; table: string; from: string; column: DdlColumn }
  /** PostgreSQL ALTER COLUMN: only what it says changes. */
  | { op: 'alter-column'; table: string; column: string; nullable?: boolean; type?: string; generated?: boolean }
  | { op: 'rename-column'; table: string; from: string; to: string }
  | { op: 'add-pk'; table: string; columns: string[]; name?: string }
  | { op: 'drop-pk'; table: string }
  | { op: 'add-fk'; table: string; fk: ForeignKeyMeta }
  | { op: 'add-index'; table: string; index: IndexMeta }
  /** DROP INDEX (table unknown in PostgreSQL), DROP FOREIGN KEY, DROP CONSTRAINT: whatever has that name. */
  | { op: 'drop-named'; table?: string; name: string; what: 'index' | 'fk' | 'constraint' }
  | { op: 'rename-index'; table: string; from: string; to: string }

/** The schema statements of one SQL file, its engine as its folders name it (`sql` when they don't). */
export interface DdlFact {
  type: 'ddl'
  engine: string
  ops: DdlOp[]
}

export type SchemaFact = EntityFact | DexieClassFact | DexieStoresFact | DdlFact
