import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyzer/analyze.ts'
import { loadConfig, targetsOf } from '../../src/analyzer/config.ts'
import { listFiles } from '../../src/analyzer/files.ts'
import type { AnalyzeContext } from '../../src/analyzer/fragment.ts'
import { goAnalyzer } from '../../src/analyzer/go/analyzer.ts'
import { lowerCamel, routePath } from '../../src/analyzer/go/frameworks.ts'
import { goExternal, guessPackageName } from '../../src/analyzer/go/index.ts'
import type { HttpFact } from '../../src/analyzer/plugins/http-facts.ts'
import type { MessagingFact } from '../../src/analyzer/plugins/messaging-facts.ts'
import { dumpGraph } from '../../src/core/dump.ts'
import { FIXTURES, analyzeFixture, copyFixture, edge, node } from '../helpers/fixtures.ts'

const s = (file: string, name: string) => `s:${file}#${name}`
const f = (file: string) => `f:${file}`

/** The facts the Go reader records, by channel (the plugins resolving them run at assembly). */
async function goFacts(root: string) {
  const config = loadConfig(root)
  let files: string[] | undefined
  const ctx: AnalyzeContext = {
    root,
    config,
    mounts: [],
    abs: rel => path.join(root, rel),
    rel: abs => path.relative(root, abs),
    files: () => (files ??= listFiles(root, [], config)),
    targets: targetsOf(config),
    log: () => {},
    timings: {},
    cacheStats: { hits: 0, misses: 0 },
  }
  const http: HttpFact[] = []
  const messaging: MessagingFact[] = []
  for await (const fragment of goAnalyzer.analyze(ctx)) {
    http.push(...((fragment.facts?.http ?? []) as HttpFact[]))
    messaging.push(...((fragment.facts?.messaging ?? []) as MessagingFact[]))
  }
  return { http, messaging }
}

describe('go-service fixture', async () => {
  const g = await analyzeFixture('go-service')

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/go-service.txt')
  })

  it('reads functions, types, fields, interface methods, constants and variables', () => {
    expect(node(g, s('order/order.go', 'Service')).subkind).toBe('struct')
    expect(node(g, s('order/order.go', 'Store')).subkind).toBe('interface')
    expect(node(g, s('order/order.go', 'Store.Find')).subkind).toBe('method')
    expect(node(g, s('order/order.go', 'Store.Find')).signature).toBe('Find(id string) (*Order, error)')
    expect(node(g, s('order/order.go', 'Service.store')).subkind).toBe('property')
    expect(node(g, s('order/order.go', 'Service.store')).exported).toBeUndefined()
    expect(node(g, s('order/order.go', 'NewService')).signature).toBe('func NewService(store Store, events Events) *Service')
    expect(node(g, s('order/order.go', 'ErrNotFound')).subkind).toBe('variable')
    expect(node(g, s('messaging/admin.go', 'DeadLetterTopic')).tags).toContain('const')
    // an embedded field is named after its type
    expect(node(g, s('order/memory.go', 'memoryStore.base')).tags).toContain('embedded')
  })

  it('makes a method a member of its type in the type`s file, and a symbol Type.method in another file', () => {
    expect(node(g, s('order/memory.go', 'memoryStore.Save')).kind).toBe('member')
    const find = node(g, s('order/memory_find.go', 'memoryStore.Find'))
    expect([find.kind, find.subkind, find.name, find.parent]).toEqual(['symbol', 'method', 'memoryStore.Find', f('order/memory_find.go')])
    // judged with its type, never a dead export of its own
    expect(find.tags ?? []).not.toContain('dead-export')
    expect(edge(g, s('order/memory_find.go', 'memoryStore.Find'), 'type-ref', s('order/memory.go', 'memoryStore'))).toBeDefined()
  })

  it('follows values through declared types: parameters, constructor results, fields, embedded structs', () => {
    // a field's interface type: s.store.Save()
    expect(edge(g, s('order/order.go', 'Service.Place'), 'calls', s('order/order.go', 'Store.Save'))).toBeDefined()
    // a parameter's type in another package
    expect(edge(g, s('messaging/consumer.go', 'Listen'), 'calls', s('order/order.go', 'Service.Place'))).toBeDefined()
    // store := NewMemoryStore(); service := NewService(…): the functions' declared results
    expect(edge(g, s('order/service_test.go', 'TestPlace'), 'calls', s('order/order.go', 'Service.Place'))).toBeDefined()
    // promoted from the embedded base, in the same package and through a constructor's result
    expect(edge(g, s('order/memory.go', 'memoryStore.Save'), 'calls', s('order/base.go', 'base.touch'))).toBeDefined()
    expect(edge(g, s('order/service_test.go', 'TestPlace'), 'calls', s('order/base.go', 'base.Writes'))).toBeDefined()
    // pkg.Name through the imports; a method value passed as a handler
    expect(edge(g, s('main.go', 'main'), 'calls', s('order/order.go', 'NewService'))).toBeDefined()
    expect(edge(g, s('api/handler.go', 'Register'), 'references', s('api/handler.go', 'Handler.GetOrder'))).toBeDefined()
    expect(edge(g, s('main.go', 'main'), 'references', s('config/config.go', 'TopicProperties.Name'))).toBeDefined()
    expect(g.meta.diagnostics.unresolvedIdentifiers).toBe(0)
  })

  it('draws composite literals as instantiations, elided element literals too', () => {
    expect(edge(g, s('order/order.go', 'NewService'), 'instantiates', s('order/order.go', 'Service'))).toBeDefined()
    expect(edge(g, s('messaging/consumer.go', 'Listen'), 'instantiates', s('order/order.go', 'Order'))).toBeDefined()
    expect(edge(g, s('order/service_test.go', 'TestPlace'), 'instantiates', s('order/order.go', 'Item'))).toBeDefined()
  })

  it('finds structural implementations: across files and packages, method by method', () => {
    expect(edge(g, s('order/memory.go', 'memoryStore'), 'implements', s('order/order.go', 'Store'))).toBeDefined()
    expect(edge(g, s('order/memory_find.go', 'memoryStore.Find'), 'implements', s('order/order.go', 'Store.Find'))).toBeDefined()
    expect(edge(g, s('messaging/producer.go', 'Publisher'), 'implements', s('order/order.go', 'Events'))).toBeDefined()
    expect(edge(g, s('messaging/producer.go', 'Publisher.Publish'), 'implements', s('order/order.go', 'Events.Publish'))).toBeDefined()
    // a type whose methods cover none of an interface's doesn't implement it
    expect(edge(g, s('order/base.go', 'base'), 'implements', s('order/order.go', 'Store'))).toBeUndefined()
  })

  it('imports the files of a package that are used, and outside packages by path', () => {
    expect(edge(g, f('main.go'), 'imports', f('order/memory.go'))).toBeDefined()
    expect(edge(g, f('main.go'), 'imports', f('order/order.go'))).toBeDefined()
    expect(edge(g, f('main.go'), 'imports', f('order/base.go'))).toBeUndefined()
    expect(edge(g, f('main.go'), 'imports', 'x:go:github.com/confluentinc/confluent-kafka-go')).toBeDefined()
    expect(edge(g, f('api/handler_test.go'), 'imports', 'x:go:net/http/httptest')).toBeDefined()
    expect(g.meta.diagnostics.unresolvedImports).toEqual([])
  })

  it('reads aliased, blank and dot imports, and an external test package', () => {
    // orders "example.com/shop/order"
    expect(edge(g, s('main.go', 'main'), 'calls', s('order/memory.go', 'NewMemoryStore'))).toBeDefined()
    // _ "net/http/pprof"
    expect(edge(g, f('main.go'), 'imports', 'x:go:net/http/pprof')?.subkind).toBe('side-effect')
    // package order_test imports . "example.com/shop/order"
    expect(edge(g, f('order/order_external_test.go'), 'imports', f('order/memory.go'))).toBeDefined()
    expect(edge(g, s('order/order_external_test.go', 'TestFind'), 'calls', s('order/order.go', 'Service.Find'))).toBeDefined()
    expect(edge(g, s('order/order_external_test.go', 'TestFind'), 'references', s('order/order.go', 'ErrNotFound'))).toBeDefined()
  })

  it('tags HTTP handlers with their method and full path', () => {
    expect(node(g, s('api/handler.go', 'Handler.GetOrder')).tags).toContain('http:GET /v1/orders/{id}')
    expect(node(g, s('api/handler.go', 'Health')).tags).toContain('http:ANY /health')
    // a func literal handler: the registering function
    expect(node(g, s('api/handler.go', 'Register')).tags).toContain('http:POST /v1/orders')
  })

  it('records HTTP handlers and requests, and Kafka topics by literal or configuration property', async () => {
    const { http, messaging } = await goFacts(path.join(FIXTURES, 'go-service'))
    const strip = <T extends { site: unknown }>({ site: _, ...rest }: T) => rest
    expect(http.map(strip)).toEqual(
      expect.arrayContaining([
        { type: 'handler', owner: s('api/handler.go', 'Handler.GetOrder'), method: 'GET', path: '/v1/orders/{id}' },
        { type: 'handler', owner: s('api/handler.go', 'Health'), method: '*', path: '/health' },
        { type: 'request', owner: s('api/handler_test.go', 'TestHealth'), method: 'GET', path: '/health' },
      ]),
    )
    expect(messaging.map(strip)).toEqual([
      // configuration.Kafka.Topic.Shipped.Name passed for NewPublisher's `topic`
      { type: 'publish', owner: s('main.go', 'main'), properties: ['kafka.topic.shipped.name'], module: '' },
      // shipped := configuration.Kafka.Topic.Shipped; kafka.TopicSpecification{Topic: shipped.Name}, and a constant
      { type: 'declare', owner: s('messaging/admin.go', 'CreateTopics'), topics: ['shop.orders.dlq'], properties: ['kafka.topic.shipped.name'], module: '' },
      // props is a KafkaProperties, which the configuration holds as Kafka
      { type: 'subscribe', owner: s('messaging/consumer.go', 'Listen'), properties: ['kafka.topic.orders.name'], module: '' },
    ])
  })
})

/** A throwaway Go module with these files (path → source). */
function goModule(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-go-'))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/x\n\ngo 1.22\n')
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return root
}

describe('Go frameworks', () => {
  it('reads the routers` registrations and net/http requests', async () => {
    const root = goModule({
      'web/routes.go': `package web

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/mux"
	"github.com/labstack/echo/v4"
)

func list(w http.ResponseWriter, r *http.Request) {}

func Routes() {
	r := mux.NewRouter()
	r.HandleFunc("/projects/{id}", list).Methods("GET", "PUT")
	c := chi.NewRouter()
	c.Get("/tasks/{taskId}", list)
	c.Method("DELETE", "/tasks/{taskId}", http.HandlerFunc(list))
	e := echo.New()
	g := e.Group("/api")
	g.POST("/users/:id", func(c echo.Context) error { return nil })
	m := http.NewServeMux()
	m.HandleFunc("GET /files/{path...}", list)
}

func Calls(base string, id string) {
	_, _ = http.Get(base + "/projects/" + id)
	_, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/tasks/%s/close", base, id), nil)
}
`,
    })
    const { http } = await goFacts(root)
    const list = s('web/routes.go', 'list')
    expect(http.map(({ site: _, ...rest }) => rest)).toEqual([
      { type: 'handler', owner: list, method: 'GET', path: '/projects/{id}' },
      { type: 'handler', owner: list, method: 'PUT', path: '/projects/{id}' },
      { type: 'handler', owner: list, method: 'GET', path: '/tasks/{taskId}' },
      { type: 'handler', owner: list, method: 'DELETE', path: '/tasks/{taskId}' },
      { type: 'handler', owner: s('web/routes.go', 'Routes'), method: 'POST', path: '/api/users/{id}' },
      { type: 'handler', owner: list, method: 'GET', path: '/files/{path}' },
      { type: 'request', owner: s('web/routes.go', 'Calls'), method: 'GET', path: '/projects/{}' },
      { type: 'request', owner: s('web/routes.go', 'Calls'), method: 'POST', path: '/tasks/{}/close' },
    ])
  })

  it('reads Kafka clients: sarama, segmentio and confluent calls and literals', async () => {
    const root = goModule({
      'events/run.go': `package events

import (
	"github.com/IBM/sarama"
	ck "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	kafka "github.com/segmentio/kafka-go"
)

const auditTopic = "audit.events"

func Run(producer sarama.SyncProducer, consumer *ck.Consumer) {
	_, _, _ = producer.SendMessage(&sarama.ProducerMessage{Topic: auditTopic})
	reader := kafka.NewReader(kafka.ReaderConfig{Topic: "orders.created", GroupID: "g"})
	_ = reader
	_ = consumer.Subscribe("payments", nil)
	w := &kafka.Writer{Topic: "orders.shipped"}
	_ = w
}
`,
    })
    const { messaging } = await goFacts(root)
    const run = s('events/run.go', 'Run')
    expect(messaging.map(({ site: _, ...rest }) => rest)).toEqual([
      { type: 'publish', owner: run, topics: ['audit.events'], module: '' },
      { type: 'subscribe', owner: run, topics: ['orders.created'], module: '' },
      { type: 'subscribe', owner: run, topics: ['payments'], module: '' },
      { type: 'publish', owner: run, topics: ['orders.shipped'], module: '' },
    ])
  })
})

describe('Go helpers', () => {
  it('names outside packages: the standard library by path, others by repository', () => {
    expect(goExternal('net/http/httptest')).toBe('x:go:net/http/httptest')
    expect(goExternal('github.com/confluentinc/confluent-kafka-go/v2/kafka')).toBe('x:go:github.com/confluentinc/confluent-kafka-go')
    expect(goExternal('gopkg.in/yaml.v3')).toBe('x:go:gopkg.in/yaml.v3')
    expect(goExternal('dev.azure.com/org/project/repo.git/common/app')).toBe('x:go:dev.azure.com/org/project/repo.git')
  })

  it('guesses an outside package`s name, and says when it is a guess', () => {
    expect(guessPackageName('github.com/confluentinc/confluent-kafka-go/v2/kafka')).toEqual({ name: 'kafka', vague: false })
    expect(guessPackageName('gopkg.in/yaml.v3')).toEqual({ name: 'yaml', vague: false })
    expect(guessPackageName('github.com/hashicorp/go-multierror')).toEqual({ name: 'multierror', vague: true })
  })

  it('writes configuration segments lower-camel and routes with {params}', () => {
    expect(['Kafka', 'AutoCreateTopics', 'HTTPClient', 'URL'].map(lowerCamel)).toEqual(['kafka', 'autoCreateTopics', 'httpClient', 'url'])
    expect(routePath('/orders/:id/*rest')).toBe('/orders/{id}/{rest}')
    expect(routePath('/files/{path...}')).toBe('/files/{path}')
  })
})

describe('Go reader', () => {
  it('counts names that should resolve and don`t, not outside packages` members', async () => {
    const root = copyFixture('go-service')
    const main = path.join(root, 'main.go')
    fs.appendFileSync(main, '\nfunc broken() {\n\tmissing()\n\t_ = order.Nope\n\t_ = gin.Anything\n}\n')
    const graph = await analyze({ root, cacheDir: false, history: false })
    expect(graph.meta.diagnostics.unresolvedIdentifiers).toBe(2)
  })

  it('re-links only the edited file, and the packages that see a changed declaration', async () => {
    const root = copyFixture('go-service')
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-go-cache-'))
    const run = async () => {
      const logs: string[] = []
      const graph = await analyze({ root, cacheDir, history: false, log: m => logs.push(m) })
      return { graph, log: logs.find(l => l.includes('Go files'))! }
    }
    expect((await run()).log).toContain('13 read, 13 linked')
    expect((await run()).log).toContain('0 read, 0 linked')
    const find = path.join(root, 'order/memory_find.go')
    fs.writeFileSync(find, fs.readFileSync(find, 'utf8').replace('return &o, nil', 'found := o\n\treturn &found, nil'))
    expect((await run()).log).toContain('1 read, 1 linked')
    // a new field is part of what other packages see: config, the packages importing it (messaging, main) are linked again
    const config = path.join(root, 'config/config.go')
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('\tPort int', '\tPort int\n\tHost string'))
    const after = await run()
    expect(after.log).toContain('1 read, 5 linked')
    expect(node(after.graph, s('config/config.go', 'ServerProperties.Host')).subkind).toBe('property')
  })
})

describe('go-service: between the parts', async () => {
  const g = await analyzeFixture('go-service')

  it('turns the Kafka facts into topics, resolving configuration keys through the module YAML', () => {
    expect(edge(g, 's:messaging/consumer.go#Listen', 'subscribes', 'x:kafka:shop.orders')).toBeDefined()
    expect(edge(g, 's:main.go#main', 'publishes', 'x:kafka:shop.orders.shipped')).toBeDefined()
    expect(edge(g, 's:messaging/admin.go#CreateTopics', 'references', 'x:kafka:shop.orders.dlq')?.subkind).toBe('declares')
  })

  it('matches a request to the handler serving it', () => {
    expect(edge(g, 's:api/handler_test.go#TestHealth', 'http-call', 's:api/handler.go#Health')?.subkind).toBe('GET')
  })
})
