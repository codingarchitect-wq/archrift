// §3 Context view, part 1: which packages talk to something outside the
// system. A generic catalog of well-known packages, each mapped to the
// neighbor system it reaches (several packages may reach one: pg and Prisma
// both reach the SQL database) with the kind of neighbor and the channel in
// between. Packages it doesn't know are libraries: code that runs inside the
// system, not a neighbor of it. Pure: no scene, no store.

/** How a neighbor is drawn. */
export type NeighborKind = 'person' | 'database' | 'browser-db' | 'service' | 'desktop' | 'files' | 'scheduler' | 'processes' | 'clients' | 'monitor'

/** Where it stands around the system: callers on the left, services the system calls on the right and at the back, data stores in front. */
export type Side = 'in' | 'out' | 'store'

export interface SystemInfo {
  /** Neighbors with the same key are one neighbor. */
  key: string
  name: string
  kind: NeighborKind
  side: Side
  /** What travels in between. */
  channel: string
  /** What the neighbor is, in a few words. */
  about: string
  /** Among packages reaching the same neighbor, the most specific one names it (a driver over an ORM). */
  rank: number
}

interface Entry extends SystemInfo {
  match: RegExp
}

const sql = (name: string, rank: number, match: RegExp): Entry => ({ key: 'sql', name, kind: 'database', side: 'store', channel: 'SQL', about: 'database', rank, match })
const service = (key: string, name: string, about: string, match: RegExp, channel = 'HTTPS'): Entry => ({ key, name, kind: 'service', side: 'out', channel, about, rank: 1, match })

/**
 * npm package names (`@scope/name`), node built-ins as `node:<module>`, JVM
 * packages as `jvm:<group>` (`jvm:org.springframework.kafka`), Go modules as
 * `go:<path>` (`go:github.com/confluentinc/confluent-kafka-go`).
 */
const CATALOG: Entry[] = [
  // SQL databases: a driver names the database, an ORM alone doesn't
  sql('PostgreSQL', 3, /^(pg|postgres|pg-promise|@prisma\/adapter-pg|@prisma\/adapter-neon|@neondatabase\/serverless|@vercel\/postgres|@supabase\/supabase-js|jvm:org\.postgresql|go:github\.com\/(lib\/pq|jackc\/pgx))$/),
  sql('MySQL', 3, /^(mysql|mysql2|@prisma\/adapter-planetscale|@planetscale\/database|jvm:com\.mysql|jvm:org\.mariadb|go:github\.com\/go-sql-driver\/mysql)$/),
  sql('SQLite', 3, /^(sqlite3|better-sqlite3|@libsql\/client|@prisma\/adapter-libsql)$/),
  sql('SQL Server', 3, /^(mssql|tedious)$/),
  sql('Database', 1, /^(prisma|@prisma\/client|drizzle-orm|typeorm|sequelize|knex|kysely|objection|@mikro-orm\/core|jvm:org\.hibernate|jvm:jakarta\.persistence|jvm:javax\.persistence|go:gorm\.io\/gorm)$/),
  { key: 'mongodb', name: 'MongoDB', kind: 'database', side: 'store', channel: 'MongoDB wire', about: 'document database', rank: 1, match: /^(mongodb|mongoose|jvm:org\.mongodb|jvm:com\.mongodb|go:go\.mongodb\.org\/mongo-driver)$/ },
  { key: 'redis', name: 'Redis', kind: 'database', side: 'store', channel: 'Redis protocol', about: 'key-value store', rank: 1, match: /^(redis|ioredis|@upstash\/redis|@vercel\/kv|jvm:redis\.clients|jvm:io\.lettuce|go:github\.com\/(redis\/go-redis|go-redis\/redis))$/ },
  { key: 'indexeddb', name: 'IndexedDB (browser)', kind: 'browser-db', side: 'store', channel: 'IndexedDB', about: 'storage in the browser', rank: 1, match: /^(dexie|idb|idb-keyval|localforage)$/ },
  { key: 'fs', name: 'File system', kind: 'files', side: 'store', channel: 'files', about: 'local files', rank: 1, match: /^(node:fs|node:fs\/promises|fs-extra|graceful-fs)$/ },
  { key: 'spreadsheets', name: 'Spreadsheet files', kind: 'files', side: 'store', channel: 'import / export', about: 'files people bring and take', rank: 1, match: /^(xlsx|exceljs|papaparse|csv-parse|csv-stringify|@fast-csv\/parse)$/ },
  { key: 'blob', name: 'Object storage', kind: 'database', side: 'store', channel: 'HTTPS', about: 'file storage', rank: 1, match: /^(@aws-sdk\/client-s3|@vercel\/blob|@azure\/storage-blob|jvm:com\.azure\.storage|go:github\.com\/Azure\/azure-storage-blob-go)$/ },
  // services the system calls
  service('stripe', 'Stripe', 'payments', /^(stripe|@stripe\/stripe-js|@stripe\/react-stripe-js)$/),
  { key: 'smtp', name: 'Mail server', kind: 'service', side: 'out', channel: 'SMTP', about: 'email', rank: 1, match: /^(nodemailer|emailjs|smtp-client|jvm:org\.springframework\.mail|jvm:jakarta\.mail|jvm:javax\.mail)$/ },
  service('resend', 'Resend', 'email', /^resend$/),
  service('sendgrid', 'SendGrid', 'email', /^(@sendgrid\/mail|jvm:com\.sendgrid)$/),
  service('postmark', 'Postmark', 'email', /^postmark$/),
  service('mailgun', 'Mailgun', 'email', /^(mailgun\.js|mailgun-js)$/),
  service('twilio', 'Twilio', 'messaging', /^twilio$/),
  service('aws', 'AWS', 'cloud services', /^(aws-sdk|@aws-sdk\/.+|jvm:software\.amazon\.awssdk|jvm:com\.amazonaws|go:github\.com\/aws\/.+)$/),
  service('gcp', 'Google Cloud', 'cloud services', /^(@google-cloud\/.+|jvm:com\.google\.cloud|go:cloud\.google\.com\/.+)$/),
  service('firebase', 'Firebase', 'cloud services', /^(firebase|firebase-admin)$/),
  service('azure', 'Azure', 'cloud services', /^(@azure\/.+|jvm:com\.azure|jvm:com\.microsoft\.azure|go:github\.com\/Azure\/.+)$/),
  service('sentry', 'Sentry', 'error tracking', /^(@sentry\/.+|jvm:io\.sentry|go:github\.com\/getsentry\/sentry-go)$/),
  service('posthog', 'PostHog', 'product analytics', /^(posthog-js|posthog-node)$/),
  service('openai', 'OpenAI', 'language models', /^openai$/),
  service('anthropic', 'Anthropic', 'language models', /^@anthropic-ai\/sdk$/),
  service('http', 'HTTP APIs', 'web services', /^(axios|node-fetch|undici|got|ky|superagent|cross-fetch|isomorphic-fetch|jvm:okhttp3|jvm:com\.squareup\.okhttp3|jvm:io\.ktor\.client|jvm:org\.apache\.httpcomponents)$/),
  service('websocket', 'WebSocket peers', 'live connections', /^(ws|socket\.io-client|socket\.io)$/, 'WebSocket'),
  service('amqp', 'Message broker', 'queues', /^(amqplib|kafkajs|bullmq|@aws-sdk\/client-sqs|jvm:org\.apache\.kafka|jvm:org\.springframework\.kafka|jvm:io\.confluent|jvm:org\.springframework\.amqp|jvm:com\.rabbitmq|go:github\.com\/(confluentinc\/confluent-kafka-go|segmentio\/kafka-go|IBM\/sarama|Shopify\/sarama))$/, 'queue'),
  { key: 'desktop', name: 'Desktop OS', kind: 'desktop', side: 'out', channel: 'IPC', about: 'windows, files, dialogs', rank: 1, match: /^(@tauri-apps\/.+|electron)$/ },
  { key: 'processes', name: 'Processes', kind: 'processes', side: 'out', channel: 'exec', about: 'other programs', rank: 1, match: /^(node:child_process|execa|cross-spawn)$/ },
]

/** The neighbor a package reaches, or undefined for a library. `name` is the package name, or `node:<module>` for a built-in. */
export function systemOf(name: string): SystemInfo | undefined {
  const hit = CATALOG.find(e => e.match.test(name))
  if (!hit) return undefined
  const info: SystemInfo = { key: hit.key, name: hit.name, kind: hit.kind, side: hit.side, channel: hit.channel, about: hit.about, rank: hit.rank }
  // Tauri or Electron names the desktop shell
  if (info.key === 'desktop') return { ...info, name: name === 'electron' ? 'Desktop OS (Electron)' : 'Desktop OS (Tauri)' }
  return info
}

/** The package an external node stands for (`x:npm:stripe` → `stripe`, `x:node:fs` → `node:fs`, `x:jvm:a.b` → `jvm:a.b`, `x:go:p` → `go:p`); undefined for anything else. */
export function packageOf(id: string): string | undefined {
  if (id.startsWith('x:npm:')) return id.slice(6)
  if (id.startsWith('x:node:')) return `node:${id.slice(7)}`
  if (id.startsWith('x:jvm:') || id.startsWith('x:go:')) return id.slice(2)
  return undefined
}

/** A message topic (`x:kafka:…`): the broker carrying it, which the code's topics name. */
export const BROKER: SystemInfo = { key: 'amqp', name: 'Kafka', kind: 'service', side: 'out', channel: 'topics', about: 'message broker', rank: 2 }

/** A database node (`x:db:<engine>:<name>`, from configuration and scripts): the store of its engine. */
export function databaseSystem(engine: string | undefined): SystemInfo {
  const byEngine: Record<string, string> = { mysql: 'mysql', mariadb: 'mysql', postgres: 'pg', mongodb: 'mongodb', redis: 'redis', sqlite: 'sqlite3', sqlserver: 'mssql' }
  return systemOf(byEngine[engine ?? ''] ?? 'prisma')!
}

/** A file the config excludes that is a generated database client (Prisma's, say) reaches the database too. */
export function excludedSystem(id: string): SystemInfo | undefined {
  if (!id.startsWith('x:excluded:')) return undefined
  return /(^|\/)(generated\/)?prisma(\/|$)|prisma\/client/.test(id.slice(11)) ? systemOf('@prisma/client') : undefined
}
