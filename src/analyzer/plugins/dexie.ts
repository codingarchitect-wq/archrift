// Dexie: the tables of a `class … extends Dexie` become members of
// kind `table`, and code that reads or writes them (`db.accounts.where(…)`,
// `this.db.accounts.put(…)`) gets `queries` edges instead of plain references.
// The class and its `version(n).stores({…})` calls are recorded as schema
// facts (schema-dexie.ts) for meta.databases.
import ts from 'typescript'
import { dexieClass, dexieStores, extendsDexie, isTable } from './schema-dexie.ts'
import type { Plugin } from './types.ts'
import { nextAccess } from './syntax.ts'

const READ = new Set(['get', 'where', 'toArray', 'filter', 'orderBy', 'count', 'each', 'bulkGet', 'toCollection', 'limit', 'offset', 'reverse', 'first', 'last', 'sortBy'])
const WRITE = new Set(['add', 'bulkAdd', 'put', 'bulkPut', 'update', 'bulkUpdate', 'delete', 'bulkDelete', 'clear', 'modify', 'upsert'])

export const dexie: Plugin = {
  name: 'dexie',
  version: 2,

  memberKind(member) {
    return isTable(member) ? { subkind: 'table', tags: ['dexie'] } : undefined
  },

  refKind(id, decl) {
    if (!isTable(decl)) return undefined
    const op = nextAccess(id)
    if (op && WRITE.has(op)) return { kind: 'queries', subkind: 'write' }
    if (op && READ.has(op)) return { kind: 'queries', subkind: 'read' }
    return undefined
  },

  visit(node, api) {
    if (extendsDexie(node)) dexieClass(node, api)
    else if (ts.isCallExpression(node)) dexieStores(node, api)
  },
}
