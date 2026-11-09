import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyzer/analyze.ts'
import { jvmExternal } from '../../src/analyzer/jvm/analyzer.ts'
import { joinPath } from '../../src/analyzer/jvm/spring.ts'
import { dumpGraph } from '../../src/core/dump.ts'
import { analyzeFixture, copyFixture, edge, node } from '../helpers/fixtures.ts'

const SVC = 'order-service/src/main/kotlin/com/acme/order'
const LIB = 'common-lib/src/main/kotlin/com/acme/common'
const AVRO = 'common-lib/src/main/avro/OrderEventAvro.avsc'
const s = (file: string, name: string) => `s:${file}#${name}`

describe('kotlin-spring fixture', async () => {
  const g = await analyzeFixture('kotlin-spring')

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/kotlin-spring.txt')
  })

  it('reads types and their members: companion constants, constructor vals, enum entries, nested in a file', () => {
    expect(node(g, s(`${LIB}/Base.kt`, 'Shape')).subkind).toBe('interface')
    expect(node(g, s(`${LIB}/Base.kt`, 'Base.API')).tags).toEqual(expect.arrayContaining(['const', 'static']))
    expect(node(g, s(`${SVC}/Order.kt`, 'Order.customer')).subkind).toBe('property')
    expect(node(g, s(`${SVC}/PaymentListener.kt`, 'Kind.SMALL')).subkind).toBe('enum-entry')
    expect(node(g, s(`${SVC}/PaymentListener.kt`, 'Registry')).subkind).toBe('object')
    expect(node(g, s(`${SVC}/Order.kt`, 'Orders')).subkind).toBe('type')
    // under other annotations, the grammar reads a body-less annotation class as an expression
    expect(node(g, s(`${LIB}/Base.kt`, 'Audited')).subkind).toBe('annotation')
  })

  it('follows calls through constructor-injected properties, typealiases and Spring Data repositories', () => {
    expect(edge(g, s(`${SVC}/OrderController.kt`, 'OrderController.create'), 'calls', s(`${SVC}/OrderService.kt`, 'OrderService.place'))).toBeDefined()
    expect(edge(g, s(`${SVC}/OrderService.kt`, 'OrderService.of'), 'calls', s(`${SVC}/OrderRepository.kt`, 'OrderRepository.findAllByCustomer'))).toBeDefined()
    // `save` is inherited from JpaRepository: it writes the entity
    expect(edge(g, s(`${SVC}/OrderService.kt`, 'OrderService.place'), 'queries', s(`${SVC}/Order.kt`, 'Order'))?.subkind).toBe('write')
    expect(edge(g, s(`${SVC}/OrderRepository.kt`, 'OrderRepository.findAllByCustomer'), 'queries', s(`${SVC}/Order.kt`, 'Order'))?.subkind).toBe('read')
    expect(edge(g, s(`${SVC}/OrderRepository.kt`, 'OrderRepository.deleteAllByCustomer'), 'queries', s(`${SVC}/Order.kt`, 'Order'))?.subkind).toBe('write')
    expect(edge(g, s(`${SVC}/OrderService.kt`, 'OrderService.place'), 'calls', s(`${LIB}/Base.kt`, 'shout'))).toBeDefined() // an extension function
    expect(edge(g, s(`${SVC}/OrderService.kt`, 'OrderService.place'), 'instantiates', s(`${SVC}/Order.kt`, 'Order'))).toBeDefined()
  })

  it('tells extends from implements, and overriding a class member from implementing an interface member', () => {
    expect(edge(g, s(`${SVC}/Order.kt`, 'Order'), 'extends', s(`${LIB}/Base.kt`, 'Base'))).toBeDefined()
    expect(edge(g, s(`${LIB}/Base.kt`, 'Base'), 'implements', s(`${LIB}/Base.kt`, 'Shape'))).toBeDefined()
    expect(edge(g, s(`${SVC}/Order.kt`, 'Order.area'), 'implements', s(`${LIB}/Base.kt`, 'Shape.area'))).toBeDefined()
    expect(edge(g, s(`${SVC}/Order.kt`, 'Order.describe'), 'overrides', s(`${LIB}/Base.kt`, 'Base.describe'))).toBeDefined()
    expect(edge(g, s(`${SVC}/Order.kt`, 'Order.describe'), 'calls', s(`${LIB}/Base.kt`, 'Base.describe'))).toBeDefined() // super.describe()
  })

  it('resolves imports to the declaring file, a companion constant through `Companion`, and outside packages by group', () => {
    expect(edge(g, `f:${SVC}/OrderController.kt`, 'imports', `f:${LIB}/Base.kt`)).toBeDefined() // com.acme.common.Base.Companion.API
    expect(edge(g, `f:${SVC}/OrderService.kt`, 'imports', `f:${AVRO}`)).toBeDefined()
    expect(edge(g, `f:${SVC}/OrderRepository.kt`, 'imports', 'x:jvm:org.springframework.data')).toBeDefined()
    expect(g.meta.diagnostics.unresolvedIdentifiers).toBe(0)
  })

  it('gives Spring stereotypes their kind and keeps framework-managed classes out of dead exports', () => {
    expect(node(g, s(`${SVC}/OrderController.kt`, 'OrderController')).subkind).toBe('controller')
    expect(node(g, s(`${SVC}/OrderService.kt`, 'OrderService')).subkind).toBe('service')
    expect(node(g, s(`${SVC}/OrderRepository.kt`, 'OrderRepository')).subkind).toBe('repository')
    expect(node(g, s(`${SVC}/Order.kt`, 'Order')).tags).toEqual(expect.arrayContaining(['entity', 'db:sql', 'table:orders']))
    expect(node(g, s(`${SVC}/PaymentListener.kt`, 'PaymentListener')).tags).toContain('entrypoint')
    expect(node(g, s(`${SVC}/PaymentListener.kt`, 'PaymentListener')).tags).not.toContain('dead-export')
    expect(node(g, s(`${SVC}/PaymentListener.kt`, 'Kind')).tags).toContain('test-only')
  })

  it('tags handlers with their method and full path, constants and templates resolved', () => {
    expect(node(g, s(`${SVC}/OrderController.kt`, 'OrderController.list')).tags).toContain('http:GET /v1/orders/{customer}')
    expect(node(g, s(`${SVC}/OrderController.kt`, 'OrderController.create')).tags).toEqual(expect.arrayContaining(['http:POST /v1/orders', 'http:POST /v1/orders/new']))
  })

  it('reads Avro records, enums and field types', () => {
    expect(node(g, s(AVRO, 'OrderEventAvro')).subkind).toBe('record')
    expect(edge(g, s(AVRO, 'OrderEventAvro.status'), 'type-ref', s(AVRO, 'OrderStatusAvro'))).toBeDefined()
    expect(edge(g, s(AVRO, 'OrderEventAvro.previous'), 'type-ref', s(AVRO, 'OrderEventAvro'))).toBeDefined()
    expect(edge(g, s(`${SVC}/OrderService.kt`, 'OrderService.place'), 'instantiates', s(AVRO, 'OrderEventAvro'))).toBeDefined()
  })
})

describe('JVM helpers', () => {
  it('names an outside package by up to three segments, never the declaration imported', () => {
    expect(jvmExternal('org.springframework.kafka.annotation.KafkaListener')).toBe('x:jvm:org.springframework.kafka')
    expect(jvmExternal('java.util.UUID')).toBe('x:jvm:java.util')
    expect(jvmExternal('kotlin.math.max')).toBe('x:jvm:kotlin.math')
    expect(jvmExternal('io.mockk.every')).toBe('x:jvm:io.mockk')
    expect(jvmExternal('org.junit.Test')).toBe('x:jvm:org.junit')
  })

  it('joins a controller prefix and a handler path with single slashes', () => {
    expect(joinPath('/v1/', '/orders/')).toBe('/v1/orders')
    expect(joinPath('', '')).toBe('/')
    expect(joinPath('api', '{id}')).toBe('/api/{id}')
  })
})

describe('JVM cache', () => {
  it('re-reads and re-links only the file whose body changed, and everything when declarations change', async () => {
    const root = copyFixture('kotlin-spring')
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-jvm-cache-'))
    const run = async () => {
      const logs: string[] = []
      const graph = await analyze({ root, cacheDir, history: false, log: m => logs.push(m) })
      return { graph, log: logs.find(l => l.includes('Kotlin/Avro'))! }
    }
    expect((await run()).log).toContain('11 read, 11 linked')
    expect((await run()).log).toContain('0 read, 0 linked')
    const service = path.join(root, SVC, 'OrderService.kt')
    fs.writeFileSync(service, fs.readFileSync(service, 'utf8').replace('customer.shout()', 'customer.shout().trim()'))
    expect((await run()).log).toContain('1 read, 1 linked')
    // a new constant is part of what other files see: they are linked again
    fs.writeFileSync(service, fs.readFileSync(service, 'utf8').replace('const val PAYMENT_CHANNEL', 'const val EXTRA = "x"\n    const val PAYMENT_CHANNEL'))
    const after = await run()
    expect(after.log).toContain('1 read, 11 linked')
    expect(node(after.graph, s(`${SVC}/OrderService.kt`, 'OrderService.EXTRA'))).toBeDefined()
  })
})

describe('Spring annotations on a class without a primary constructor', () => {
  it('are read once: one table tag, one listener tag', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-no-ctor-'))
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(
      path.join(root, 'src/Things.kt'),
      ['package x', '', '@Entity', 'class Thing {', '  var name: String? = null', '}', '', '@KafkaListener(topics = ["t"])', 'class Listener {', '  fun on(m: String) {}', '}', ''].join('\n'),
    )
    const g = await analyze({ root, cacheDir: false, history: false })
    expect(node(g, 's:src/Things.kt#Thing').tags?.filter(t => t.startsWith('table:'))).toEqual(['table:Thing'])
    expect(node(g, 's:src/Things.kt#Listener').tags?.filter(t => t === 'kafka-listener')).toEqual(['kafka-listener'])
  })
})

describe('a name declared in two modules', () => {
  it("resolves to the copy in a library the caller's libraries depend on, not to another service's copy", async () => {
    // in a system of services, a Go service keeps its own copy of the shared message-key schema, under the same
    // full name; the Kotlin services get the library's through the libraries their build files name
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-transitive-'))
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
    const key = JSON.stringify({ type: 'record', name: 'KeyAvro', namespace: 'com.acme.messages', fields: [{ name: 'id', type: 'string' }] })
    write('base-lib/build.gradle.kts', 'plugins { kotlin("jvm") }\n')
    write('base-lib/src/main/avro/KeyAvro.avsc', key)
    write('events-lib/build.gradle.kts', 'dependencies { implementation("com.acme:base-lib:1.0") }\n')
    write('image-service/go.mod', 'module acme/image\n')
    write('image-service/resources/avro/KeyAvro.avsc', key)
    write('job-service/build.gradle.kts', 'dependencies { implementation("com.acme:events-lib:1.0") }\n')
    write('job-service/src/main/kotlin/com/acme/job/Log.kt', 'package com.acme.job\n\nimport com.acme.messages.KeyAvro\n\nfun describe(key: KeyAvro): String = key.toString()\n')
    const g = await analyze({ root, cacheDir: false, history: false })
    const from = 's:job-service/src/main/kotlin/com/acme/job/Log.kt#describe'
    expect(edge(g, from, 'type-ref', 's:base-lib/src/main/avro/KeyAvro.avsc#KeyAvro')).toBeDefined()
    expect(edge(g, from, 'type-ref', 's:image-service/resources/avro/KeyAvro.avsc#KeyAvro')).toBeUndefined()
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('kotlin-spring: between the parts', async () => {
  const g = await analyzeFixture('kotlin-spring')

  it('resolves topics through constants, property placeholders and channel bindings, per environment', () => {
    // kafkaTemplate.send(ORDERS_TOPIC, …)
    expect(edge(g, s(`${SVC}/OrderService.kt`, 'OrderService.place'), 'publishes', 'x:kafka:acme.orders')).toBeDefined()
    // getTopicForChannel(PAYMENT_CHANNEL) → custom.kafka.bindings.payment.kafkaTopic → acme.local.payments
    expect(edge(g, s(`${SVC}/OrderService.kt`, 'OrderService.topicName'), 'publishes', 'x:kafka:acme.payments')).toBeDefined()
    // @KafkaListener(topics = ["${custom.kafka.bindings.payment.kafkaTopic}"]): the placeholder for Kubernetes doesn't resolve, the local profile's literal does
    expect(edge(g, s(`${SVC}/PaymentListener.kt`, 'PaymentListener.listen'), 'subscribes', 'x:kafka:acme.payments')).toBeDefined()
    expect(node(g, 'x:kafka:acme.payments').tags).toEqual(['kafka', 'topic', 'infra'])
    expect(node(g, 'x:kafka:acme.payments').name).toBe('payments')
  })

  it("links a module's repositories to the database its datasource names, without host or credentials", () => {
    expect(edge(g, s(`${SVC}/OrderRepository.kt`, 'OrderRepository'), 'queries', 'x:db:mysql:acme-orders')).toBeDefined()
    expect(node(g, 'x:db:mysql:acme-orders').signature).toBe('mysql: acme-orders')
    expect(JSON.stringify(g)).not.toContain('keep-out-of-the-graph')
    expect(JSON.stringify(g)).not.toContain('db-host.internal')
  })
})
