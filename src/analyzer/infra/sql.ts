// SQL files: `CREATE TABLE`, `VIEW`, `DATABASE` and `SCHEMA` statements as
// symbols. A table is tagged `table:<name>` (as JPA entities are, P3), and a
// database a file creates is a `datastore` fact, its engine taken from the
// file's folders (`db/migration/mysql/`), else plain `sql`. The schema changes
// its statements make (ddl.ts) are a `schema` fact, applied in migration
// order when the graph is assembled (plugins/schemas.ts).
import { symbolId } from '../../core/ids.ts'
import type { DatastoreFact } from '../plugins/datastore-facts.ts'
import type { DdlFact } from '../plugins/schema-facts.ts'
import { countLoc, lineStarts } from './common.ts'
import { blankComments, parseDdl } from './ddl.ts'
import type { InfraFile } from './model.ts'

const NAME = String.raw`(?:[\x60"\[]?[\w$-]+[\x60"\]]?)(?:\.[\x60"\[]?[\w$-]+[\x60"\]]?)?`
const CREATE = new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?(TABLE|VIEW|DATABASE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`, 'gi')
const DATABASE = new RegExp(String.raw`\bCREATE\s+(DATABASE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`, 'gi')
const MONGO_USE = /(?:^|[\s;])use\s+([\w-]+)|getSiblingDB\(\s*["']([\w-]+)["']\s*\)/g

const unquote = (name: string) => name.replace(/[\x60"[\]]/g, '')

/** Databases a piece of SQL (or a mongosh script) creates, with their offsets. */
export function createdDatabases(text: string, engine: string): { name: string; offset: number }[] {
  const out: { name: string; offset: number }[] = []
  if (engine === 'mongodb') {
    for (const m of text.matchAll(MONGO_USE)) {
      const name = m[1] ?? m[2]
      if (name !== 'admin' && name !== 'local' && name !== 'config') out.push({ name, offset: m.index + m[0].indexOf(name) })
    }
    return out
  }
  for (const m of blankComments(text).matchAll(DATABASE))
    if (m[1].toUpperCase() === 'DATABASE' || engine === 'mysql' || engine === 'mariadb') out.push({ name: unquote(m[2]), offset: m.index + m[0].lastIndexOf(m[2]) })
  return out
}

/** The engine a SQL file's folder names, else plain `sql`. */
export function engineOfPath(p: string): string {
  const m = /(^|[/._-])(mysql|mariadb|postgres(?:ql)?|pg|sqlserver|mssql|oracle|h2|sqlite)([/._-]|$)/i.exec(p)
  if (!m) return 'sql'
  const e = m[2].toLowerCase()
  return e === 'pg' || e.startsWith('postgres') ? 'postgres' : e === 'mariadb' ? 'mariadb' : e === 'mssql' ? 'sqlserver' : e
}

export function readSql(file: InfraFile, text: string): void {
  const clean = blankComments(text)
  const starts = lineStarts(text)
  const lineAt = (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const engine = engineOfPath(file.path)
  for (const m of clean.matchAll(CREATE)) {
    const what = m[1].toLowerCase()
    const name = unquote(m[2])
    const id = symbolId(file.path, name)
    if (file.decls.some(d => d.id === id)) continue
    const start = m.index
    const semi = clean.indexOf(';', start)
    const end = semi < 0 ? clean.length : semi + 1
    const line = lineAt(start)
    const endLine = lineAt(end - 1)
    file.decls.push({
      id,
      kind: 'symbol',
      name,
      subkind: what,
      parent: `f:${file.path}`,
      range: [line, start - starts[line - 1] + 1, endLine, end - starts[endLine - 1] + 1],
      signature: `CREATE ${m[1].toUpperCase()} ${name}`,
      tags: what === 'table' ? [`table:${name.slice(name.lastIndexOf('.') + 1).toLowerCase()}`] : [],
      loc: countLoc(text, line, endLine),
      complexity: 1,
    })
    // a schema is a database in MySQL only (in PostgreSQL it is a namespace inside one)
    if (what === 'database' || (what === 'schema' && (engine === 'mysql' || engine === 'mariadb'))) {
      const fact: DatastoreFact = { type: 'declare', owner: id, engine, name, module: '', site: [line, start - starts[line - 1] + 1] }
      ;(file.facts.datastore ??= []).push(fact)
    }
  }
  schemaFact(file, text, clean, engine)
}

/** The schema changes the file's statements make, applied in migration order when the graph is assembled. */
function schemaFact(file: InfraFile, text: string, clean: string, engine: string) {
  const ops = parseDdl(text, engine, clean)
  if (!ops.length) return
  const fact: DdlFact = { type: 'ddl', engine, ops }
  ;(file.facts.schema ??= []).push(fact)
}
