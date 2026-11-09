// What Go code says about HTTP and Kafka (docs/POLYGLOT.md, P5), recognized
// per call and composite literal during pass B and recorded as facts:
//
// - HTTP handlers (`http` facts, `http:GET /path` tags on the handler):
//   net/http and ServeMux `HandleFunc`/`Handle` (Go 1.22 "GET /p" patterns
//   too), gorilla `r.HandleFunc("/p", h).Methods("GET")`, chi `r.Get("/p", h)`
//   and `r.Method("GET", "/p", h)`, gin and echo `r.GET("/p", h)`, `Any`,
//   `Handle("GET", "/p", h)`, with `g := r.Group("/v1")` prefixes. A call
//   counts when its receiver isn't a project type, the path is a known
//   string starting with `/` and the handler is a function (a func literal,
//   a function or method value). The fact's owner is the handler when it
//   resolves into the project, else the registering function.
// - HTTP requests (`http` facts): `http.NewRequest(method, url, …)`,
//   `NewRequestWithContext`, `httptest.NewRequest`, `http.Get/Head/Post/PostForm`,
//   with the path taken from a literal, a concatenation or a Sprintf format
//   (unknown parts `{}`, a leading base URL dropped).
// - Kafka (`messaging` facts), by the name of the call, since every client
//   (confluent-kafka-go, sarama, segmentio, a project's own wrapper) names
//   them alike: Consume/Subscribe/ReadMessage/Listen/New…Consumer… subscribe;
//   Produce/Send/Publish/WriteMessages/New…Producer… publish; CreateTopic(s)
//   declare. The topic is an argument that is
//     - a configuration selector chain with a `Topic` segment
//       (`configuration.Kafka.Topic.Resized.Name` → property
//       kafka.topic.resized.name, resolved by the messaging plugin through the
//       module's application*.yml),
//     - or a string (literal, constant, string local) when the callee is a
//       Kafka package's, a Kafka-only name (Subscribe, SubscribeTopics,
//       ConsumePartition, CreateTopic), a `[]string{…}` topic list, or a
//       constant named like a topic,
//     - or anything passed for a project callee's parameter named `topic…`.
//   Composite literals of a Kafka package's types with a `Topic` field say
//   it too: TopicSpecification/TopicConfig declare, ReaderConfig subscribes,
//   ProducerMessage/Message/Writer publish. The owner is the enclosing
//   function; a call without a known topic (the wrapper inside, handed the
//   topic as a parameter) records nothing, its caller does.
import type { Node } from '../tree-sitter.ts'
import { named, siteOf } from '../tree-sitter.ts'
import { joinPath } from '../jvm/spring.ts'
import type { HttpHandlerFact, HttpRequestFact } from '../plugins/http-facts.ts'
import type { MessagingFact } from '../plugins/messaging-facts.ts'
import type { FileScope } from './index.ts'
import type { GoDecl } from './model.ts'

export interface Arg {
  node: Node
  /** The project function or method it names. */
  handler?: GoDecl
  /** A function value: a func literal, a function or method, a value of a function type. */
  isFunc: boolean
}

export interface CallInfo {
  /** The callee's last name. */
  name: string
  site: [number, number]
  /** The callee, when it is a project function or method. */
  decl?: GoDecl
  /** The callee, when it is an outside package's member (`http.HandleFunc`). */
  ext?: { path: string; name: string }
  /** The receiver is a value of a project type (then a GET method is the project's own). */
  projectReceiver: boolean
  /** The receiver's router group prefix. */
  prefix?: string
  args: Arg[]
  /** gorilla/mux: `.Methods("GET", …)` called on the result. */
  chainedMethods?: string[]
  /** A project callee's parameter names. */
  params?: string[]
}

export interface FrameworkPass {
  /** The go.mod folder. */
  module: string
  owner(): string
  emit(channel: string, fact: unknown): void
  tag(id: string, tag: string): void
  /** The string(s) an expression holds, when known. */
  strings(n: Node): string[] | undefined
  /** The configuration property a selector chain reads; with `topic`, only when a segment names a topic. */
  property(n: Node, topic: boolean): string | undefined
  scope: FileScope
}

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']
/** chi's methods: Get, Post … */
const CHI = new Map(VERBS.map(v => [v[0] + v.slice(1).toLowerCase(), v]))
const HTTP_PACKAGES = new Set(['net/http', 'net/http/httptest'])
/** Client calls of net/http: [method or index of the method argument, index of the URL argument]. */
const REQUESTS: Record<string, [string | number, number]> = {
  NewRequest: [0, 1],
  NewRequestWithContext: [1, 2],
  Get: ['GET', 0],
  Head: ['HEAD', 0],
  Post: ['POST', 0],
  PostForm: ['POST', 0],
}

const SUBSCRIBE = /^(Consume|ConsumePartition|ConsumeClaim|Subscribe|SubscribeTopics|ReadMessage|FetchMessage|Listen|NewReader|NewConsumer|NewConsumerGroup|New\w*(Consumer|Listener|Reader|Subscriber)\w*)$/
const PUBLISH = /^(Produce|ProduceChannel|Send|SendMessage|SendMessages|Publish|WriteMessages|NewWriter|NewProducer|NewSyncProducer|NewAsyncProducer|New\w*(Producer|Publisher|Writer|Sender)\w*)$/
const DECLARE = /^CreateTopics?$/
/** Names only Kafka clients use: a string argument is a topic. */
const KAFKA_ONLY = /^(Subscribe|SubscribeTopics|ConsumePartition|CreateTopics?)$/
const KAFKA_PACKAGE = /kafka|sarama|franz-go/i
/** Composite literals of a Kafka package's types that name a topic. */
const KAFKA_LITERALS: Record<string, MessagingFact['type']> = {
  TopicSpecification: 'declare',
  TopicConfig: 'declare',
  ReaderConfig: 'subscribe',
  ProducerMessage: 'publish',
  Message: 'publish',
  Writer: 'publish',
  WriterConfig: 'publish',
}
const TOPIC_KEYS = new Set(['Topic', 'Topics', 'GroupTopics'])

/** `Kafka` → kafka, `AutoCreateTopics` → autoCreateTopics, `HTTPClient` → httpClient, `URL` → url. */
export const lowerCamel = (s: string) => s.replace(/^[A-Z]+(?=[A-Z][a-z]|\d|$)|^[A-Z]/, m => m.toLowerCase())

/** A route as the http channel writes it: gin's `:id` and `*path`, Go 1.22's `{id...}` become `{id}`. */
export function routePath(p: string): string {
  return p
    .split('/')
    .map(seg => (/^[:*]\w+$/.test(seg) ? `{${seg.slice(1)}}` : seg.replace(/^\{(\w+)\.\.\.\}$/, '{$1}').replace(/^\{\$\}$/, '')))
    .join('/')
}

export function httpCall(c: CallInfo, pass: FrameworkPass) {
  if (c.decl) return
  if (c.ext && HTTP_PACKAGES.has(c.ext.path)) {
    if (c.ext.name in REQUESTS) return request(c, pass)
    if (c.ext.name !== 'HandleFunc' && c.ext.name !== 'Handle') return
  } else if (c.projectReceiver) return
  const n = c.args.length
  if (n < 2) return
  let method: string | undefined
  let pathAt = 0
  const first = pass.strings(c.args[0].node)?.[0]
  if ((c.name === 'Handle' || c.name === 'Method' || c.name === 'MethodFunc') && n >= 3 && first && VERBS.includes(first.toUpperCase())) {
    method = first.toUpperCase()
    pathAt = 1
  } else if (c.name === 'HandleFunc' || c.name === 'Handle' || c.name === 'Any') method = '*'
  else if (VERBS.includes(c.name)) method = c.name
  else method = CHI.get(c.name)
  if (!method) return
  const handler = c.args[n - 1]
  if (!handler.isFunc && c.name !== 'Handle') return
  let path = pass.strings(c.args[pathAt].node)?.[0]
  if (path === undefined) return
  const pattern = /^([A-Z]+)\s+(\S+)$/.exec(path)
  if (pattern && method === '*') {
    method = pattern[1]
    path = pattern[2]
  }
  if (!path.startsWith('/')) return
  const full = joinPath(c.prefix ?? '', routePath(path))
  const owner = handler.handler?.id ?? pass.owner()
  const methods = c.chainedMethods?.length ? c.chainedMethods.map(m => m.toUpperCase()) : [method]
  for (const m of methods) {
    const fact: HttpHandlerFact = { type: 'handler', owner, method: m, path: full, site: c.site }
    pass.emit('http', fact)
    pass.tag(owner, `http:${m === '*' ? 'ANY' : m} ${full}`)
  }
}

function request(c: CallInfo, pass: FrameworkPass) {
  const [m, urlAt] = REQUESTS[c.ext!.name]
  const methodNode = typeof m === 'number' ? c.args[m]?.node : undefined
  const method = typeof m === 'string' ? m : methodNode && (pass.strings(methodNode)?.[0]?.toUpperCase() ?? /\bMethod([A-Z][a-z]+)$/.exec(methodNode.text)?.[1].toUpperCase())
  const urlNode = c.args[urlAt]?.node
  const path = urlNode && urlPath(urlNode, pass)
  if (!method || !path) return
  const fact: HttpRequestFact = { type: 'request', owner: pass.owner(), method, path, site: c.site }
  pass.emit('http', fact)
}

/** The path of a URL expression: a literal, `base + "/x/" + id`, `fmt.Sprintf("%s/x/%d", base, id)`; unknown parts `{}`. */
function urlPath(n: Node, pass: FrameworkPass): string | undefined {
  const text = (x: Node, depth: number): string => {
    const s = pass.strings(x)
    if (s?.length === 1) return s[0]
    if (depth < 8 && x.type === 'binary_expression' && x.childForFieldName('operator')?.type === '+') {
      const l = x.childForFieldName('left')
      const r = x.childForFieldName('right')
      return (l ? text(l, depth + 1) : '{}') + (r ? text(r, depth + 1) : '{}')
    }
    if (x.type === 'call_expression' && /(^|\.)Sprintf$/.test(x.childForFieldName('function')?.text ?? '')) {
      const format = named(x.childForFieldName('arguments') ?? x)[0]
      const f = format && pass.strings(format)?.[0]
      if (f !== undefined) return f.replace(/%[-+# 0-9.]*[a-zA-Z]/g, '{}')
    }
    return '{}'
  }
  let p = text(n, 0)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/[?#].*$/, '')
  if (p.startsWith('{}/')) p = p.slice(2)
  return p.startsWith('/') ? routePath(p) : undefined
}

export function kafkaCall(c: CallInfo, pass: FrameworkPass) {
  const type: MessagingFact['type'] | undefined = SUBSCRIBE.test(c.name) ? 'subscribe' : PUBLISH.test(c.name) ? 'publish' : DECLARE.test(c.name) ? 'declare' : undefined
  if (!type) return
  const kafkaApi = (c.ext && KAFKA_PACKAGE.test(c.ext.path)) || (!c.decl && !c.projectReceiver && KAFKA_ONLY.test(c.name))
  const topics: string[] = []
  const properties: string[] = []
  c.args.forEach((a, i) => {
    // past the last parameter: a variadic one (topics ...string)
    const byParam = /topic/i.test(c.params?.length ? c.params[Math.min(i, c.params.length - 1)] : '')
    const list = a.node.type === 'composite_literal' && a.node.childForFieldName('type')?.type === 'slice_type'
    const elements = list ? named(a.node.childForFieldName('body') ?? a.node).flatMap(e => (e.type === 'literal_element' ? named(e).slice(0, 1) : [])) : [a.node]
    for (const e of elements) {
      const prop = pass.property(e, !byParam)
      if (prop) {
        properties.push(prop)
        continue
      }
      if (!byParam && !kafkaApi && !list && !/topic/i.test(e.text)) continue
      const s = pass.strings(e)
      if (s) topics.push(...s)
    }
  })
  emit(type, topics, properties, c.site, pass)
}

/** `kafka.TopicSpecification{Topic: …}` and the like. */
export function kafkaLiteral(typeNode: Node, body: Node | null, pass: FrameworkPass) {
  if (!body) return
  // []kafka.TopicSpecification{{Topic: …}, …}: each element is one
  const elementType = typeNode.type === 'slice_type' || typeNode.type === 'array_type' ? typeNode.childForFieldName('element') : undefined
  const head = elementType ?? typeNode
  if (head.type !== 'qualified_type') return
  const q = head.childForFieldName('package')?.text ?? ''
  const name = head.childForFieldName('name')?.text ?? ''
  const imp = pass.scope.names.get(q)
  const type = KAFKA_LITERALS[name]
  if (!type || imp?.kind !== 'external' || !KAFKA_PACKAGE.test(imp.path)) return
  const topics: string[] = []
  const properties: string[] = []
  const read = (lit: Node) => {
    for (const el of named(lit)) {
      if (el.type !== 'keyed_element') continue
      const key = named(el.childForFieldName('key') ?? el)[0]?.text ?? ''
      const value = named(el.childForFieldName('value') ?? el)[0]
      if (!value) continue
      if (key === 'TopicPartition') {
        // confluent: Message{TopicPartition: kafka.TopicPartition{Topic: &topic}}
        const inner = value.type === 'composite_literal' ? value.childForFieldName('body') : value.type === 'literal_value' ? value : null
        if (inner) read(inner)
        continue
      }
      if (!TOPIC_KEYS.has(key)) continue
      const list = value.type === 'composite_literal' ? named(value.childForFieldName('body') ?? value).flatMap(e => (e.type === 'literal_element' ? named(e).slice(0, 1) : [])) : [value]
      for (const v of list) {
        const prop = pass.property(v, false)
        if (prop) properties.push(prop)
        else topics.push(...(pass.strings(v) ?? []))
      }
    }
  }
  if (elementType) for (const el of named(body)) {
    const inner = el.type === 'literal_element' ? named(el)[0] : undefined
    if (inner?.type === 'literal_value') read(inner)
  }
  else read(body)
  emit(type, topics, properties, siteOf(typeNode), pass)
}

function emit(type: MessagingFact['type'], topics: string[], properties: string[], site: [number, number], pass: FrameworkPass) {
  if (!topics.length && !properties.length) return
  const fact: MessagingFact = {
    type,
    owner: pass.owner(),
    ...(topics.length ? { topics } : {}),
    ...(properties.length ? { properties } : {}),
    module: pass.module,
    site,
  }
  pass.emit('messaging', fact)
}
