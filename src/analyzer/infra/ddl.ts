// SQL DDL (MySQL and MariaDB, PostgreSQL, H2 and what shares their syntax):
// the schema changes a file's statements make, as DdlOps for
// plugins/schemas.ts to apply in migration order. Read: CREATE TABLE (column
// definitions, inline and table constraints, MySQL KEY lines), CREATE VIEW,
// CREATE INDEX, ALTER TABLE (ADD/DROP/MODIFY/CHANGE/ALTER/RENAME COLUMN,
// constraints, indexes, the primary key, RENAME TO), DROP TABLE/VIEW/INDEX
// and RENAME TABLE. Everything else (data, triggers, procedures, grants) is
// skipped, as is a statement the parser can't follow: a schema with a gap
// beats a guess.
//
// The text is split into statements by a small lexer that knows quotes
// (', ", `, [ ]), PostgreSQL's dollar quoting and MySQL's DELIMITER lines,
// then each statement is read token by token.
import type { ForeignKeyMeta, IndexMeta } from '../../core/model.ts'
import type { DdlColumn, DdlOp } from '../plugins/schema-facts.ts'
import { lineStarts } from './common.ts'

export interface Tok {
  /** id: a word; qid: a quoted name; str: a string; num; p: punctuation. */
  k: 'id' | 'qid' | 'str' | 'num' | 'p'
  /** The text, a quoted name or string without its quotes. */
  v: string
  /** A word in upper case (keywords), '' for anything quoted. */
  up: string
  at: number
  end: number
}

const MYSQL = new Set(['mysql', 'mariadb'])

/** Comments blanked, positions kept. */
export function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])--[^\n]*|(^|\s)#[^\n]*/g, m => m.replace(/[^\n]/g, ' '))
}

/** The schema changes of a SQL text, in order (`clean`: the text with its comments blanked, when the caller has it). */
export function parseDdl(text: string, engine: string, clean = blankComments(text)): DdlOp[] {
  const starts = lineStarts(clean)
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
  const ops: DdlOp[] = []
  for (const tokens of statements(clean, engine)) {
    try {
      ops.push(...statementOps(new Cursor(tokens, clean, lineAt)))
    } catch {
      // a statement the parser can't follow is skipped
    }
  }
  return ops
}

// ── lexer ──

/** The statements of a SQL text, each as tokens. */
export function statements(text: string, engine: string): Tok[][] {
  const lex = new Lexer(text, MYSQL.has(engine))
  const out: Tok[][] = []
  let current: Tok[] = []
  const end = () => {
    if (current.length) out.push(current)
    current = []
  }
  while (lex.more()) {
    if (lex.delimiterLine() || lex.delimiter()) {
      end()
      continue
    }
    current.push(lex.token())
  }
  end()
  return out
}

class Lexer {
  private i = 0
  private delim = ';'
  private readonly s: string
  private readonly mysql: boolean
  constructor(s: string, mysql: boolean) {
    this.s = s
    this.mysql = mysql
  }

  more(): boolean {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++
    return this.i < this.s.length
  }

  /** MySQL's client command `DELIMITER $$` at the start of a line: statements end at that instead. */
  delimiterLine(): boolean {
    if (this.s[this.i] !== 'd' && this.s[this.i] !== 'D') return false
    const lineStart = this.s.lastIndexOf('\n', this.i - 1) + 1
    if (!/^[ \t]*$/.test(this.s.slice(lineStart, this.i))) return false
    const m = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(this.s.slice(this.i, this.i + 80))
    if (!m) return false
    this.delim = m[1]
    this.i += m[0].length
    return true
  }

  delimiter(): boolean {
    if (!this.s.startsWith(this.delim, this.i)) return false
    this.i += this.delim.length
    return true
  }

  token(): Tok {
    return this.quote() ?? this.match('id', WORD) ?? this.match('num', NUMBER) ?? this.take('p', this.s[this.i], 1)
  }

  private quote(): Tok | undefined {
    const c = this.s[this.i]
    const head = this.s.slice(this.i, this.i + 130)
    // a double quote names in standard SQL, but is a string in MySQL
    const q = c === '"' && this.mysql ? (['"', 'str'] as const) : QUOTES[c]
    if (q && (c !== '[' || BRACKETED.test(head))) return this.quoted(q[0], q[1])
    const dollar = c === '$' && !this.mysql ? DOLLAR.exec(head) : null
    return dollar ? this.dollar(dollar[0]) : undefined
  }

  private match(k: 'id' | 'num', re: RegExp): Tok | undefined {
    const m = re.exec(this.s.slice(this.i, this.i + 256))
    return m ? this.take(k, m[0], m[0].length) : undefined
  }

  private take(k: Tok['k'], v: string, length: number): Tok {
    const at = this.i
    this.i += length
    return { k, v, up: k === 'id' ? v.toUpperCase() : k === 'p' ? v : '', at, end: this.i }
  }

  /** A quoted name or string; a doubled quote is one, and MySQL strings escape with a backslash. */
  private quoted(close: string, k: 'str' | 'qid'): Tok {
    const at = this.i
    const backslash = this.mysql && k === 'str'
    let v = ''
    let j = at + 1
    while (j < this.s.length) {
      const ch = this.s[j]
      if (backslash && ch === '\\') {
        v += this.s[j + 1] ?? ''
        j += 2
        continue
      }
      if (ch !== close) {
        v += ch
        j++
        continue
      }
      if (this.s[j + 1] !== close || close === ']') break
      v += close
      j += 2
    }
    this.i = Math.min(j + 1, this.s.length)
    return { k, v, up: '', at, end: this.i }
  }

  private dollar(tag: string): Tok {
    const at = this.i
    const close = this.s.indexOf(tag, this.i + tag.length)
    const end = close < 0 ? this.s.length : close + tag.length
    this.i = end
    return { k: 'str', v: this.s.slice(at + tag.length, close < 0 ? end : close), up: '', at, end }
  }
}

/** What opens a quote: its closing character and what it quotes. */
const QUOTES: Record<string, [string, 'str' | 'qid']> = { "'": ["'", 'str'], '"': ['"', 'qid'], '`': ['`', 'qid'], '[': [']', 'qid'] }
const WORD = /^[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/
const NUMBER = /^\d+(?:\.\d+)?/
const BRACKETED = /^\[[A-Za-z_][\w $-]*\]/
const DOLLAR = /^\$([A-Za-z_]\w*)?\$/

// ── cursor ──

const isName = (t: Tok | undefined): t is Tok => t?.k === 'id' || t?.k === 'qid'

class Cursor {
  i = 0
  readonly t: Tok[]
  readonly lineAt: (offset: number) => number
  private readonly text: string
  constructor(t: Tok[], text: string, lineAt: (offset: number) => number) {
    this.t = t
    this.text = text
    this.lineAt = lineAt
  }

  peek(o = 0): Tok | undefined {
    return this.t[this.i + o]
  }
  done(): boolean {
    return this.i >= this.t.length
  }
  /** The next tokens are these words (unquoted, any case). */
  is(...words: string[]): boolean {
    return words.every((w, k) => this.t[this.i + k]?.k === 'id' && this.t[this.i + k].up === w)
  }
  accept(...words: string[]): boolean {
    if (!this.is(...words)) return false
    this.i += words.length
    return true
  }
  isP(c: string): boolean {
    const x = this.peek()
    return x?.k === 'p' && x.v === c
  }
  /** A name, possibly qualified: `a`.`b` → a.b */
  name(): string | undefined {
    if (!isName(this.peek())) return undefined
    const parts = [this.t[this.i++].v]
    while (this.isP('.') && isName(this.peek(1))) {
      this.i++
      parts.push(this.t[this.i++].v)
    }
    return parts.join('.')
  }
  /** The tokens inside the parentheses that start here; the cursor moves past them. */
  group(): Tok[] {
    if (!this.isP('(')) return []
    const start = this.i
    let depth = 0
    for (; this.i < this.t.length; this.i++) {
      const x = this.t[this.i]
      if (x.k === 'p' && x.v === '(') depth++
      else if (x.k === 'p' && x.v === ')' && --depth === 0) return this.t.slice(start + 1, this.i++)
    }
    return this.t.slice(start + 1)
  }
  rest(): Tok[] {
    const r = this.t.slice(this.i)
    this.i = this.t.length
    return r
  }
  /** The source text from token `from` up to (not including) the cursor, on one line, without spaces inside parentheses (`varchar (36)` → `varchar(36)`). */
  textFrom(from: number): string {
    return this.text
      .slice(this.t[from].at, this.t[this.i - 1].end)
      .replace(/\s+/g, ' ')
      .replace(/ ?\( ?/g, '(')
      .replace(/ \)/g, ')')
  }
  sub(tokens: Tok[]): Cursor {
    return new Cursor(tokens, this.text, this.lineAt)
  }
  line(): number {
    return this.lineAt(this.peek()?.at ?? this.t[this.t.length - 1]?.end ?? 0)
  }
}

/** Splits tokens at the commas outside parentheses. */
function splitTop(tokens: Tok[]): Tok[][] {
  const out: Tok[][] = [[]]
  let depth = 0
  for (const t of tokens) {
    if (t.k === 'p' && t.v === '(') depth++
    else if (t.k === 'p' && t.v === ')') depth--
    if (t.k === 'p' && t.v === ',' && depth === 0) out.push([])
    else out[out.length - 1].push(t)
  }
  return out.filter(p => p.length)
}

// ── statements ──

function statementOps(c: Cursor): DdlOp[] {
  const line = c.line()
  if (c.accept('CREATE')) return create(c, line)
  if (c.accept('ALTER', 'TABLE')) return alterTable(c)
  if (c.accept('DROP')) return drop(c)
  if (c.accept('RENAME', 'TABLE')) return renameTables(c)
  return []
}

const CREATED = new Set(['TABLE', 'VIEW', 'INDEX'])
const NOT_A_TABLE = new Set(['TRIGGER', 'FUNCTION', 'PROCEDURE', 'SEQUENCE', 'TYPE', 'EXTENSION', 'DATABASE', 'SCHEMA', 'USER', 'ROLE', 'EVENT', 'DOMAIN', 'POLICY', 'RULE'])

/** CREATE [OR REPLACE] [TEMPORARY | UNIQUE | ALGORITHM=… …] TABLE | VIEW | INDEX */
function create(c: Cursor, line: number): DdlOp[] {
  const unique = skipCreateModifiers(c)
  if (unique === undefined) return []
  if (c.accept('TABLE')) return createTable(c, line)
  if (c.accept('VIEW')) return createView(c, line)
  return c.accept('INDEX') ? createIndex(c, unique) : []
}

/** Skips to TABLE, VIEW or INDEX; whether UNIQUE was among the words skipped, undefined when something else is created. */
function skipCreateModifiers(c: Cursor): boolean | undefined {
  let unique = false
  for (let k = 0; k < 16 && !c.done(); k++, c.i++) {
    const t = c.peek()!
    if (t.k === 'id' && CREATED.has(t.up)) return unique
    if (t.k === 'id' && NOT_A_TABLE.has(t.up)) return undefined
    unique ||= t.up === 'UNIQUE'
  }
  return undefined
}

function createTable(c: Cursor, line: number): DdlOp[] {
  const ifNotExists = c.accept('IF', 'NOT', 'EXISTS')
  const table = c.name()
  if (!table) return []
  const op: Extract<DdlOp, { op: 'create' }> = { op: 'create', table, kind: 'table', ...(ifNotExists ? { ifNotExists } : {}), columns: [], pk: [], references: [], indexes: [], line }
  for (const element of splitTop(c.group())) tableElement(c.sub(element), op)
  return [op]
}

function tableElement(d: Cursor, op: Extract<DdlOp, { op: 'create' }>) {
  if (startsConstraint(d)) {
    const k = constraint(d)
    if (k?.kind === 'pk') {
      op.pk = k.columns
      if (k.name) op.pkName = k.name
    } else if (k?.kind === 'fk') op.references.push(k.fk)
    else if (k?.kind === 'index') op.indexes.push(k.index)
    return
  }
  const def = columnDef(d)
  if (!def) return
  op.columns.push(def.column)
  if (def.column.pk) op.pk.push(def.column.name)
}

/** CREATE VIEW name [(columns)] AS … : a view, with the columns when they are listed. */
function createView(c: Cursor, line: number): DdlOp[] {
  c.accept('IF', 'NOT', 'EXISTS')
  const table = c.name()
  if (!table) return []
  const columns: DdlColumn[] = c.isP('(') ? namesIn(c.group()).map(name => ({ name })) : []
  return [{ op: 'create', table, kind: 'view', columns, pk: [], references: [], indexes: [], line }]
}

/** CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON table [USING m] (columns) */
function createIndex(c: Cursor, unique: boolean): DdlOp[] {
  c.accept('CONCURRENTLY')
  c.accept('IF', 'NOT', 'EXISTS')
  const name = c.is('ON') ? undefined : c.name()
  skipUsing(c)
  if (!c.accept('ON')) return []
  c.accept('ONLY')
  const table = c.name()
  if (!table) return []
  return [{ op: 'add-index', table, index: indexMeta(indexColumns(c), unique, name) }]
}

function drop(c: Cursor): DdlOp[] {
  c.accept('TEMPORARY')
  if (c.accept('TABLE') || c.accept('VIEW') || c.accept('MATERIALIZED', 'VIEW')) {
    c.accept('IF', 'EXISTS')
    return splitTop(c.rest()).flatMap(part => {
      const table = c.sub(part).name()
      return table ? [{ op: 'drop' as const, table }] : []
    })
  }
  if (!c.accept('INDEX')) return []
  c.accept('CONCURRENTLY')
  c.accept('IF', 'EXISTS')
  const name = c.name()
  if (!name) return []
  const table = c.accept('ON') ? c.name() : undefined
  return [{ op: 'drop-named', name: lastPart(name), what: 'index', ...(table ? { table } : {}) }]
}

/** RENAME TABLE a TO b [, c TO d] */
function renameTables(c: Cursor): DdlOp[] {
  return splitTop(c.rest()).flatMap(part => {
    const d = c.sub(part)
    const table = d.name()
    const to = d.accept('TO') ? d.name() : undefined
    return table && to ? [{ op: 'rename' as const, table, to }] : []
  })
}

// ── ALTER TABLE ──

function alterTable(c: Cursor): DdlOp[] {
  c.accept('IF', 'EXISTS')
  c.accept('ONLY')
  const table = c.name()
  if (!table) return []
  return splitTop(c.rest()).flatMap(action => alterAction(c.sub(action), table))
}

const ACTIONS: [string, (d: Cursor, table: string) => DdlOp[]][] = [
  ['ADD', addAction],
  ['DROP', dropAction],
  ['MODIFY', modifyAction],
  ['CHANGE', changeAction],
  ['ALTER', alterColumnAction],
  ['RENAME', renameAction],
]

function alterAction(d: Cursor, table: string): DdlOp[] {
  const action = ACTIONS.find(([word]) => d.is(word))
  if (!action) return []
  d.i++
  return action[1](d, table)
}

function addAction(d: Cursor, table: string): DdlOp[] {
  const column = d.accept('COLUMN')
  if (!column && startsConstraint(d)) return constraintOps(table, constraint(d))
  const ifNotExists = d.accept('IF', 'NOT', 'EXISTS')
  // MySQL: ADD (a INT, b INT)
  const defs = d.isP('(') ? splitTop(d.group()).map(part => columnDef(d.sub(part))) : [columnDef(d)]
  return defs.flatMap(def =>
    def ? [{ op: 'add-column' as const, table, column: def.column, ...(def.after ? { after: def.after } : {}), ...(def.first ? { first: true } : {}), ...(ifNotExists ? { ifNotExists } : {}) }] : [],
  )
}

function constraintOps(table: string, k: Constraint | undefined): DdlOp[] {
  if (k?.kind === 'pk') return [{ op: 'add-pk', table, columns: k.columns, ...(k.name ? { name: k.name } : {}) }]
  if (k?.kind === 'fk') return [{ op: 'add-fk', table, fk: k.fk }]
  if (k?.kind === 'index') return [{ op: 'add-index', table, index: k.index }]
  return []
}

function dropAction(d: Cursor, table: string): DdlOp[] {
  if (d.accept('PRIMARY', 'KEY')) return [{ op: 'drop-pk', table }]
  if (d.accept('CHECK')) return []
  const what = droppedKind(d)
  d.accept('IF', 'EXISTS')
  if (!what) d.accept('COLUMN')
  d.accept('IF', 'EXISTS')
  const name = d.name()
  if (!name) return []
  return what ? [{ op: 'drop-named', table, name, what }] : [{ op: 'drop-column', table, column: name }]
}

/** DROP FOREIGN KEY | INDEX | KEY | CONSTRAINT: what a named drop removes (undefined: a column). */
function droppedKind(d: Cursor): 'fk' | 'index' | 'constraint' | undefined {
  if (d.accept('FOREIGN', 'KEY')) return 'fk'
  if (d.accept('INDEX') || d.accept('KEY')) return 'index'
  return d.accept('CONSTRAINT') ? 'constraint' : undefined
}

/** MySQL MODIFY [COLUMN] definition: the column's whole definition is replaced. */
function modifyAction(d: Cursor, table: string): DdlOp[] {
  d.accept('COLUMN')
  const def = columnDef(d)
  return def ? [{ op: 'replace-column', table, from: def.column.name, column: def.column }] : []
}

/** MySQL CHANGE [COLUMN] old definition: renamed and redefined. */
function changeAction(d: Cursor, table: string): DdlOp[] {
  d.accept('COLUMN')
  const from = d.name()
  const def = from && columnDef(d)
  return from && def ? [{ op: 'replace-column', table, from, column: def.column }] : []
}

/** ALTER [COLUMN] x SET NOT NULL | DROP NOT NULL | [SET DATA] TYPE t | ADD GENERATED … AS IDENTITY | SET DEFAULT … */
function alterColumnAction(d: Cursor, table: string): DdlOp[] {
  d.accept('COLUMN')
  const column = d.name()
  const change = column && COLUMN_CHANGES.find(([words]) => d.is(...words))
  if (!column || !change) return []
  d.i += change[0].length
  const what = change[1](d)
  return what ? [{ op: 'alter-column', table, column, ...what }] : []
}

type ColumnChange = Partial<Pick<Extract<DdlOp, { op: 'alter-column' }>, 'nullable' | 'type' | 'generated'>>

const typeChange = (d: Cursor): ColumnChange | undefined => {
  const from = d.i
  while (!d.done() && !d.is('USING') && !d.is('COLLATE')) skipOne(d)
  return d.i > from ? { type: d.textFrom(from) } : undefined
}

const COLUMN_CHANGES: [string[], (d: Cursor) => ColumnChange | undefined][] = [
  [['SET', 'NOT', 'NULL'], () => ({ nullable: false })],
  [['DROP', 'NOT', 'NULL'], () => ({ nullable: true })],
  [['ADD', 'GENERATED'], () => ({ generated: true })],
  [['DROP', 'IDENTITY'], () => ({ generated: false })],
  [['SET', 'DATA', 'TYPE'], typeChange],
  [['TYPE'], typeChange],
]

/** RENAME COLUMN a TO b | RENAME INDEX|KEY a TO b | RENAME [TO|AS] new | PostgreSQL's RENAME a TO b (a column) | MySQL's RENAME new (TO is optional). */
function renameAction(d: Cursor, table: string): DdlOp[] {
  if (d.accept('TO') || d.accept('AS')) return renamedTable(d, table)
  if (d.accept('INDEX') || d.accept('KEY')) return renamed(d, (from, to) => ({ op: 'rename-index', table, from, to }))
  const column = (from: string, to: string): DdlOp => ({ op: 'rename-column', table, from, to })
  if (d.accept('COLUMN')) return renamed(d, column)
  return d.peek(1)?.up === 'TO' ? renamed(d, column) : renamedTable(d, table)
}

function renamed(d: Cursor, op: (from: string, to: string) => DdlOp): DdlOp[] {
  const from = d.name()
  const to = d.accept('TO') ? d.name() : undefined
  return from && to ? [op(from, to)] : []
}

function renamedTable(d: Cursor, table: string): DdlOp[] {
  const to = d.name()
  return to ? [{ op: 'rename', table, to }] : []
}

// ── column definitions ──

/** Words that end a column's type: the constraints and options after it. */
const COLUMN_WORDS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'GENERATED', 'CHECK', 'CONSTRAINT',
  'COLLATE', 'CHARSET', 'COMMENT', 'ON', 'AS', 'STORED', 'VIRTUAL', 'VISIBLE', 'INVISIBLE', 'KEY', 'FIRST', 'AFTER', 'COLUMN_FORMAT', 'STORAGE', 'SRID',
])
const SERIAL = /^(small|big)?serial\d?\b/i
const GENERATING = new Set(['NEXTVAL', 'GEN_RANDOM_UUID', 'UUID_GENERATE_V1', 'UUID_GENERATE_V4', 'NEWID', 'NEWSEQUENTIALID', 'UUID', 'RANDOM_UUID', 'UUID_TO_BIN'])

interface ColumnDef {
  column: DdlColumn
  after?: string
  first?: boolean
}

const endsType = (d: Cursor) => {
  const t = d.peek()!
  if (t.k !== 'id') return false
  // CHARACTER SET is an option, CHARACTER VARYING a type
  return COLUMN_WORDS.has(t.up) || (t.up === 'CHARACTER' && d.peek(1)?.up === 'SET')
}

/** `name type [constraints…] [FIRST | AFTER x]` */
function columnDef(d: Cursor): ColumnDef | undefined {
  const nameTok = d.peek()
  if (!isName(nameTok)) return undefined
  d.i++
  const column: DdlColumn = { name: nameTok.v, line: d.lineAt(nameTok.at) }
  const type = columnType(d)
  if (type) column.type = type
  const def: ColumnDef = { column }
  let notNull = false
  while (!d.done()) notNull = columnOption(d, def) || notNull
  if (type && SERIAL.test(type)) column.generated = true
  if (!notNull && !column.pk) column.nullable = true
  return def
}

/** The type as written: everything up to the first constraint or option. */
function columnType(d: Cursor): string | undefined {
  const from = d.i
  while (!d.done() && !endsType(d)) skipOne(d)
  return d.i > from ? d.textFrom(from) : undefined
}

/** Reads one constraint or option of a column definition; true when it is NOT NULL. */
function columnOption(d: Cursor, def: ColumnDef): boolean {
  const step = COLUMN_OPTIONS.find(([words]) => d.is(...words))
  if (!step) {
    d.isP('(') ? d.group() : d.i++
    return false
  }
  d.i += step[0].length
  return step[1](d, def) === true
}

const generated = (_d: Cursor, def: ColumnDef) => void (def.column.generated = true)
const skipOne = (d: Cursor) => void (d.isP('(') ? d.group() : d.i++)

const COLUMN_OPTIONS: [string[], (d: Cursor, def: ColumnDef) => boolean | void][] = [
  [['NOT', 'NULL'], () => true],
  [['NULL'], () => {}],
  [['PRIMARY', 'KEY'], (_d, def) => void (def.column.pk = true)],
  [['UNIQUE'], (d, def) => void (d.accept('KEY'), (def.column.unique = true))],
  [['KEY'], (_d, def) => void (def.column.pk = true)],
  [['REFERENCES'], (d, def) => void (d.i--, setReference(d, def))],
  [['AUTO_INCREMENT'], generated],
  [['AUTOINCREMENT'], generated],
  [['IDENTITY'], (d, def) => void (d.group(), (def.column.generated = true))],
  [['GENERATED'], (d, def) => void (skipUntil(d, 'AS'), d.accept('AS'), d.accept('IDENTITY'), d.group(), (def.column.generated = true))],
  [['AS'], (d, def) => void (d.group(), (def.column.generated = true))],
  [['DEFAULT'], (d, def) => void (defaultValue(d) && (def.column.generated = true))],
  [['ON', 'UPDATE'], d => void (skipOne(d), d.group())],
  [['CONSTRAINT'], d => void (isName(d.peek()) && !COLUMN_WORDS.has(d.peek()!.up) && d.i++)],
  [['CHECK'], d => void d.group()],
  [['COLLATE'], skipOne],
  [['CHARSET'], skipOne],
  [['CHARACTER', 'SET'], skipOne],
  [['COMMENT'], skipOne],
  [['FIRST'], (_d, def) => void (def.first = true)],
  [['AFTER'], (d, def) => void (def.after = d.name())],
]

function setReference(d: Cursor, def: ColumnDef) {
  const fk = references(d, [def.column.name])
  if (fk) def.column.references = fk
}

function skipUntil(d: Cursor, word: string) {
  while (!d.done() && !d.is(word)) d.i++
}

/** Skips a DEFAULT's value; true when the database generates it (a sequence, a UUID function). */
function defaultValue(d: Cursor): boolean {
  const first = d.peek()
  const inner = d.isP('(') ? d.peek(1) : undefined
  skipOne(d)
  if (d.isP('(')) d.group()
  while (!d.done() && !endsType(d)) skipOne(d)
  return GENERATING.has(first?.up ?? '') || GENERATING.has(inner?.up ?? '')
}

// ── constraints ──

type Constraint = { kind: 'pk'; columns: string[]; name?: string } | { kind: 'fk'; fk: ForeignKeyMeta } | { kind: 'index'; index: IndexMeta }

const CONSTRAINT_START = [['CONSTRAINT'], ['PRIMARY', 'KEY'], ['UNIQUE'], ['FOREIGN', 'KEY'], ['KEY'], ['INDEX'], ['FULLTEXT'], ['SPATIAL'], ['CHECK'], ['EXCLUDE']]
const startsConstraint = (d: Cursor) => CONSTRAINT_START.some(words => d.is(...words))

/** [CONSTRAINT name] PRIMARY KEY (…) | UNIQUE [KEY|INDEX] [name] (…) | FOREIGN KEY [name] (…) REFERENCES … | [FULLTEXT|SPATIAL] KEY|INDEX [name] (…) */
function constraint(d: Cursor): Constraint | undefined {
  const named = d.accept('CONSTRAINT') && !startsConstraint(d) ? d.name() : undefined
  if (d.accept('PRIMARY', 'KEY')) return { kind: 'pk', columns: indexColumns(d), ...(named ? { name: named } : {}) }
  if (d.accept('FOREIGN', 'KEY')) {
    const fk = references(d.sub(d.rest()), [], named, true)
    return fk ? { kind: 'fk', fk } : undefined
  }
  return indexConstraint(d, named)
}

/** UNIQUE [KEY|INDEX], [FULLTEXT|SPATIAL] KEY|INDEX: an index, unique or not. */
function indexConstraint(d: Cursor, named: string | undefined): Constraint | undefined {
  const unique = d.accept('UNIQUE')
  const keyword = d.accept('FULLTEXT') || d.accept('SPATIAL')
  const index = d.accept('KEY') || d.accept('INDEX')
  if (!unique && !keyword && !index) return undefined
  const name = named ?? optionalName(d)
  return { kind: 'index', index: indexMeta(indexColumns(d), unique, name) }
}

/** An index's or key's own name, when one is written before its columns. */
function optionalName(d: Cursor): string | undefined {
  return isName(d.peek()) && !d.is('USING') ? d.name() : undefined
}

function skipUsing(d: Cursor) {
  if (d.accept('USING')) d.i++
}

/**
 * REFERENCES table [(columns)] [MATCH …] [ON DELETE action] [ON UPDATE action]; for a table
 * constraint (`own`) the key's own name and columns come first: `[name] (a, b) REFERENCES …`.
 */
function references(d: Cursor, columns: string[], name?: string, own = false): ForeignKeyMeta | undefined {
  const keyName = own ? (name ?? optionalName(d)) : name
  const keyColumns = own ? namesIn(d.group()) : columns
  if (!d.accept('REFERENCES')) return undefined
  const table = d.name()
  if (!table) return undefined
  const to = d.isP('(') ? namesIn(d.group()) : []
  const onDelete = referentialActions(d)
  return { columns: keyColumns, table, to, ...(keyName ? { name: keyName } : {}), ...(onDelete ? { onDelete } : {}) }
}

/** ON DELETE / ON UPDATE (and MATCH, DEFERRABLE …) after a reference: what deleting the referenced row does. */
function referentialActions(d: Cursor): string | undefined {
  let onDelete: string | undefined
  while (!d.done()) {
    if (d.accept('ON', 'DELETE')) onDelete = action(d)
    else if (d.accept('ON', 'UPDATE')) action(d)
    else if (endsType(d)) break
    else skipOne(d)
  }
  return onDelete
}

/** CASCADE | RESTRICT | NO ACTION | SET NULL | SET DEFAULT */
function action(d: Cursor): string | undefined {
  for (const words of [['NO', 'ACTION'], ['SET', 'NULL'], ['SET', 'DEFAULT'], ['CASCADE'], ['RESTRICT']]) if (d.accept(...words)) return words.join(' ')
  return undefined
}

/** The columns of an index or key: `(a, b(10) DESC)` → a, b; an expression (`lower(email)`) is kept as written. */
function indexColumns(d: Cursor): string[] {
  skipUsing(d)
  return splitTop(d.group()).map(indexColumn)
}

function indexColumn(part: Tok[]): string {
  const [first, second, third] = part
  const call = second?.k === 'p' && second.v === '('
  // MySQL's prefix length, `name(10)`, still indexes the column
  if (isName(first) && (!call || third?.k === 'num')) return first.v
  return part.map(t => t.v).join('')
}

/** The plain names in a parenthesized list. */
function namesIn(tokens: Tok[]): string[] {
  return splitTop(tokens).flatMap(part => (isName(part[0]) ? [part[0].v] : []))
}

function indexMeta(columns: string[], unique: boolean, name: string | undefined): IndexMeta {
  return { columns, ...(unique ? { unique: true } : {}), ...(name ? { name } : {}) }
}

const lastPart = (name: string) => name.slice(name.lastIndexOf('.') + 1)
