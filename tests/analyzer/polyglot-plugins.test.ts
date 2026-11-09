import { describe, expect, it } from 'vitest'
import { databaseOf } from '../../src/analyzer/plugins/datastores.ts'
import { fit, segments } from '../../src/analyzer/plugins/http.ts'
import { topicKey } from '../../src/analyzer/plugins/messaging.ts'

describe('http matching', () => {
  it('reads a path as segments, variables of any notation as {}', () => {
    expect(segments('https://api.example.com/internal/v5/projects/{projectId}/tasks?size=20#x')).toEqual(['internal', 'v5', 'projects', '{}', 'tasks'])
    expect(segments('/projects/:id')).toEqual(['projects', '{}'])
    expect(segments('/{}/v5/projects/{}')).toEqual(['{}', 'v5', 'projects', '{}'])
  })

  it('fits a handler to the end of a request path, longer and more literal handlers fitting better', () => {
    const request = segments('/v5/projects/{}/tasks')
    expect(fit(segments('/projects/{projectId}/tasks'), request)).toEqual([3, 2])
    expect(fit(segments('/tasks'), request)).toEqual([1, 1])
    expect(fit(segments('/projects/{projectId}'), request)).toBeUndefined()
    // a handler of variables only matches anything: never
    expect(fit(segments('/{id}'), request)).toBeUndefined()
    // an unknown part of the request matches a literal
    expect(fit(segments('/projects/{id}/tasks'), segments('/{}/{}/tasks'))).toEqual([3, 2])
  })
})

describe('topic keys', () => {
  it('leave out environments, placeholders and a trailing version, so one topic meets across environments', () => {
    expect(topicKey('acme.local.ordering.order')).toBe('acme.ordering.order')
    expect(topicKey('acme.$APP_ENV.billing.invoice.v2')).toBe('acme.billing.invoice')
    expect(topicKey('acme.${env}.image.resize')).toBe('acme.image.resize')
    expect(topicKey('orders')).toBe('orders')
    expect(topicKey('${kafka-topic-user}')).toBeUndefined()
  })
})

describe('databases from connection URLs', () => {
  it('take the engine and the database name, nothing else', () => {
    expect(databaseOf('jdbc:mysql://localhost:3306/acme-orders?serverTimezone=UTC&useSSL=false')).toEqual({ engine: 'mysql', name: 'acme-orders' })
    expect(databaseOf('jdbc:postgresql://db.internal:5432/orders')).toEqual({ engine: 'postgres', name: 'orders' })
    expect(databaseOf('mongodb://mongo-0.mongo:27017,mongo-1.mongo:27017/acme-job-service?replicaSet=rs0')).toEqual({ engine: 'mongodb', name: 'acme-job-service' })
    expect(databaseOf('mongodb+srv://cluster.example.net/shop')).toEqual({ engine: 'mongodb', name: 'shop' })
    expect(databaseOf('jdbc:mysql://localhost:3306')).toBeUndefined()
  })
})
