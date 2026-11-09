// Spring for the JVM reader (docs/POLYGLOT.md, P3–P4): what the annotations
// and supertypes say. Pass A gives stereotypes their kind (controller,
// service, repository, entity …) and marks framework-managed types as
// entrypoints. Pass B, once constants resolve, records the HTTP handlers
// (`http` facts, `http:GET /path` tags), the Kafka listeners and senders
// (`messaging` facts, resolved to topics by plugins/messaging.ts), and links
// repository methods to the entity they store (`queries`).
import type { HttpHandlerFact } from '../plugins/http-facts.ts'
import type { MessagingFact } from '../plugins/messaging-facts.ts'
import { entityFact } from './entities.ts'
import type { JvmIndex, Scope } from './index.ts'
import type { Annotation, JvmDecl, TypeRef } from './model.ts'

/** Stereotype annotations, strongest first: a type gets the first one it has. */
const STEREOTYPES: [string, string][] = [
  ['RestController', 'controller'],
  ['Controller', 'controller'],
  ['RestControllerAdvice', 'controller'],
  ['ControllerAdvice', 'controller'],
  ['Repository', 'repository'],
  ['Service', 'service'],
  ['SpringBootApplication', 'application'],
  ['Configuration', 'configuration'],
  ['AutoConfiguration', 'configuration'],
  ['Component', 'component'],
  ['Entity', 'entity'],
  ['Document', 'entity'],
]
const REPOSITORY_SUPER = /^(Jpa|Crud|PagingAndSorting|ListCrud|ListPagingAndSorting|Mongo|ReactiveMongo|ReactiveCrud|Coroutine(Crud|SortingRepository)|Kotlin)?Repository$|Repository$/
const MAPPINGS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
  RequestMapping: '*',
}
const LISTENERS = new Set(['KafkaListener', 'KafkaHandler', 'StreamListener'])
const READS = /^(find|get|read|query|count|exists|search|stream|load|fetch|is|has|list|select|lookup)/i
const WRITES = /^(save|delete|remove|update|insert|create|persist|merge|flush|set|put|add|upsert|mark|increment|decrement|clear|truncate)/i
/** Calls that look a topic up by channel name (a project's own topic properties). */
const TOPIC_LOOKUP = /^(getTopicForChannel|topicForChannel|getTopicName|getTopic|topicFor)$/
const SENDS = /^(send|sendDefault|publish|produce)$/

const simple = (name: string) => name.slice(name.lastIndexOf('.') + 1)
const annotation = (d: { annotations?: Annotation[] }, ...names: string[]) => d.annotations?.find(a => names.includes(simple(a.name)))

/** Pass A: a type's stereotype from its annotations and supertypes. */
export function springKinds(decl: JvmDecl) {
  const names = new Set((decl.annotations ?? []).map(a => simple(a.name)))
  const stereotype = STEREOTYPES.find(([a]) => names.has(a))
  if (stereotype) decl.subkind = stereotype[1]
  const superNames = (decl.supers ?? []).map(s => s.type.name[s.type.name.length - 1])
  if (decl.type === 'interface' && superNames.some(n => REPOSITORY_SUPER.test(n) && n !== 'Repository')) decl.subkind = 'repository'
  // @Table alone marks an entity, but not on an @Embeddable (whose columns live in its owner's table)
  if (names.has('Entity') || (names.has('Table') && !names.has('Embeddable'))) decl.tags.push('entity', 'db:sql')
  else if (names.has('Document')) decl.tags.push('entity', 'db:mongodb')
  else if (decl.subkind === 'repository') {
    const store = superNames.find(n => REPOSITORY_SUPER.test(n))
    if (store) decl.tags.push(/Mongo/.test(store) ? 'db:mongodb' : 'db:sql')
  }
  // the framework creates and calls these: their exports are never "dead"
  if (stereotype && stereotype[1] !== 'entity') decl.tags.push('spring', 'entrypoint')
}

export interface SpringPass {
  index: JvmIndex
  /** The module the file is in (messaging resolves topics in its configuration). */
  module: string
  emit(channel: string, fact: unknown): void
  tag(id: string, tag: string): void
  edge(source: string, target: string, kind: 'queries', subkind: string, site: [number, number]): void
}

/** Pass B, per declaration: handlers, listeners, entity tables, repository methods. */
export function springDecl(decl: JvmDecl, scope: Scope, pass: SpringPass) {
  const { index } = pass
  const strings = (a: Annotation | undefined, ...names: string[]): string[] => {
    if (!a) return []
    const args = a.args.filter(x => (x.name === undefined && names.includes('')) || (x.name !== undefined && names.includes(x.name)))
    return args.flatMap(x => index.evaluate(x.value, scope) ?? [])
  }
  if (decl.type) {
    const table = annotation(decl, 'Table')
    const doc = annotation(decl, 'Document')
    const tableName = strings(table, 'name', '')[0] ?? strings(doc, 'collection', 'value', '')[0]
    if (decl.tags.includes('entity')) {
      pass.tag(decl.id, `table:${tableName ?? decl.name}`)
      // its columns and keys, for meta.databases (plugins/schemas.ts)
      pass.emit('schema', entityFact(decl, index))
    }
    const listener = annotation(decl, ...LISTENERS)
    if (listener) subscribe(decl, listener)
    return
  }
  if (decl.kind !== 'member') return
  const owner = index.decls.get(decl.parent)
  // a repository's methods read or write its entity
  if (owner?.subkind === 'repository') {
    const entity = repositoryEntity(owner, index)
    if (entity) pass.edge(decl.id, entity.id, 'queries', READS.test(decl.name) ? 'read' : WRITES.test(decl.name) ? 'write' : 'read', [decl.range[0], decl.range[1]])
  }
  const listener = annotation(decl, ...LISTENERS)
  if (listener) subscribe(decl, listener)
  const mapping = decl.annotations?.find(a => MAPPINGS[simple(a.name)] !== undefined)
  if (!mapping || !owner) return
  const ownerScope = index.scopeOf(owner)
  const prefixes = (() => {
    const a = annotation(owner, 'RequestMapping')
    if (!a) return ['']
    const p = a.args.filter(x => x.name === undefined || x.name === 'value' || x.name === 'path').flatMap(x => index.evaluate(x.value, ownerScope) ?? [])
    return p.length ? p : ['']
  })()
  let method = MAPPINGS[simple(mapping.name)]
  if (method === '*') {
    const m = mapping.args.find(x => x.name === 'method')
    const names = m ? refsOf(m.value) : []
    if (names.length) method = names.map(n => n[n.length - 1]).join('|')
  }
  const paths = mapping.args.filter(x => x.name === undefined || x.name === 'value' || x.name === 'path').flatMap(x => index.evaluate(x.value, scope) ?? ['{}'])
  for (const prefix of prefixes)
    for (const p of paths.length ? paths : ['']) {
      const full = joinPath(prefix, p)
      for (const m of method.split('|')) {
        const fact: HttpHandlerFact = { type: 'handler', owner: decl.id, method: m, path: full, site: mapping.site }
        pass.emit('http', fact)
        pass.tag(decl.id, `http:${m === '*' ? 'ANY' : m} ${full}`)
      }
    }

  function subscribe(d: JvmDecl, a: Annotation) {
    const topics = a.args.filter(x => x.name === undefined || x.name === 'topics' || x.name === 'value' || x.name === 'topicPattern').flatMap(x => index.evaluate(x.value, scope) ?? [])
    const fact: MessagingFact = { type: 'subscribe', owner: d.id, topics, module: pass.module, site: a.site }
    if (topics.length) pass.emit('messaging', fact)
    pass.tag(d.id, 'kafka-listener')
  }
}

/** Pass B, per call: a topic looked up by channel or named in a send: the caller publishes to it. */
export function springCall(call: { owner: string; name: string; args: string[][]; receiverType?: string; site: [number, number]; inListener: boolean; inConfiguration: boolean }, pass: SpringPass) {
  const first = call.args[0]
  if (!first?.length) return
  if (TOPIC_LOOKUP.test(call.name)) {
    const fact: MessagingFact = {
      type: call.inListener || call.inConfiguration ? 'declare' : 'publish',
      owner: call.owner,
      channels: first,
      module: pass.module,
      site: call.site,
    }
    pass.emit('messaging', fact)
  } else if ((SENDS.test(call.name) && /KafkaTemplate|KafkaProducer|Producer$/.test(call.receiverType ?? '')) || call.name === 'ProducerRecord') {
    const fact: MessagingFact = { type: 'publish', owner: call.owner, topics: first, module: pass.module, site: call.site }
    pass.emit('messaging', fact)
  }
}

/** A call to a method a repository inherits (save, findById …): it reads or writes the repository's entity. */
export function repositoryQuery(repo: JvmDecl, method: string, index: JvmIndex): { entity: JvmDecl; op: string } | undefined {
  if (repo.subkind !== 'repository') return undefined
  const entity = repositoryEntity(repo, index)
  return entity ? { entity, op: WRITES.test(method) ? 'write' : 'read' } : undefined
}

/** The entity a repository stores: the first type argument of its Spring Data supertype. */
function repositoryEntity(repo: JvmDecl, index: JvmIndex): JvmDecl | undefined {
  const sup = repo.supers?.find(s => REPOSITORY_SUPER.test(s.type.name[s.type.name.length - 1]) && s.type.args?.length)
  const arg: TypeRef | undefined = sup?.type.args?.[0]
  return arg ? index.resolveType(arg.name, index.scopeOf(repo))[0] : undefined
}

function refsOf(e: import('./model.ts').Expr): string[][] {
  if ('ref' in e) return [e.ref]
  if ('arr' in e) return e.arr.flatMap(refsOf)
  return []
}

/** `/projects` + `{id}` → `/projects/{id}`; one slash between, a leading one, none at the end. */
export function joinPath(prefix: string, path: string): string {
  const joined = `/${[prefix, path].map(p => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`
  return joined
}
