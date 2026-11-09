import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyze, createContext } from '../../src/analyzer/analyze.ts'
import { ConfigSchema, loadConfig } from '../../src/analyzer/config.ts'
import type { FileFragment } from '../../src/analyzer/fragment.ts'
import { classify, infraAnalyzer } from '../../src/analyzer/infra/analyzer.ts'
import { imageName, isEncrypted, isSecretPath } from '../../src/analyzer/infra/common.ts'
import { renderTemplate } from '../../src/analyzer/infra/helm.ts'
import type { DatastoreFact } from '../../src/analyzer/plugins/datastore-facts.ts'
import type { MessagingFact } from '../../src/analyzer/plugins/messaging-facts.ts'
import { dumpGraph } from '../../src/core/dump.ts'
import { FIXTURES, analyzeFixture, edge, node } from '../helpers/fixtures.ts'
import { makeHistoryRepo } from '../helpers/history-repo.ts'

const ROOT = path.join(FIXTURES, 'infra-root')
const CHART = 'services/orders/charts/orders'
const s = (file: string, name: string) => `s:${file}#${name}`

/** The reader's fragments, facts included (the graph keeps facts only for the plugins that read them). */
async function fragments(): Promise<FileFragment[]> {
  const ctx = createContext(ROOT, loadConfig(ROOT))
  const out: FileFragment[] = []
  for await (const f of infraAnalyzer.analyze(ctx)) out.push(f)
  return out
}

describe('infra fixture: a system with a mounted infrastructure folder', async () => {
  const g = await analyzeFixture('infra-root')
  const all = await fragments()
  const facts = <T>(channel: string) => all.flatMap(f => ((f.facts?.[channel] ?? []) as T[]).map(fact => ({ file: f.path, ...fact })))

  it('matches the snapshot', async () => {
    await expect(dumpGraph(g)).toMatchFileSnapshot('./expected/infra.txt')
  })

  it('reads Kubernetes manifests: a symbol per resource, linked by name and by labels', () => {
    const web = 'k8s/web.yaml'
    expect(node(g, s(web, 'Deployment/web')).subkind).toBe('deployment')
    expect(node(g, s(web, 'Deployment/web')).tags).toContain('image:nginx')
    expect(node(g, s(web, 'Secret/web-credentials')).signature).toBe('Secret web-credentials -n shop')
    expect(edge(g, s(web, 'Ingress/web'), 'references', s(web, 'Service/web'))?.subkind).toBe('backend')
    expect(edge(g, s(web, 'Service/web'), 'references', s(web, 'Deployment/web'))?.subkind).toBe('selects')
    for (const used of ['ConfigMap/web-config', 'Secret/web-credentials', 'PersistentVolumeClaim/web-cache', 'ServiceAccount/web'])
      expect(edge(g, s(web, 'Deployment/web'), 'references', s(web, used))?.subkind).toBe('uses')
  })

  it('renders Helm templates with the chart, its values and the library templates they include', () => {
    expect(node(g, s(`${CHART}/Chart.yaml`, 'orders')).signature).toBe('chart orders 0.3.0')
    expect(edge(g, s(`${CHART}/Chart.yaml`, 'orders'), 'references', s('services/common-chart/Chart.yaml', 'common-chart'))?.subkind).toBe('dependency')
    // app.yaml only includes the library's deployment: it still declares Deployment/orders, with the image from values.yaml
    const deployment = s(`${CHART}/templates/app.yaml`, 'Deployment/orders')
    expect(node(g, deployment).tags).toContain('image:acme/orders')
    expect(edge(g, deployment, 'references', s('services/common-chart/templates/_deployment.tpl', 'common.deployment'))?.subkind).toBe('include')
    expect(edge(g, deployment, 'references', s(`${CHART}/templates/app.yaml`, 'ConfigMap/orders-config'))).toBeDefined()
    expect(edge(g, s(`${CHART}/templates/app.yaml`, 'Service/orders'), 'references', deployment)?.subkind).toBe('selects')
    expect(edge(g, s(`${CHART}/templates/ingress.yaml`, 'Ingress/orders-ingress'), 'references', s(`${CHART}/templates/app.yaml`, 'Service/orders'))).toBeDefined()
    expect(edge(g, s('services/common-chart/templates/_deployment.tpl', 'common.deployment'), 'references', s('services/common-chart/templates/_helpers.tpl', 'common.labels'))).toBeDefined()
    // YAML that doesn't parse after rendering still gives its kind and name
    expect(node(g, s(`${CHART}/templates/migrate-job.yaml`, 'Job/orders-migrate')).subkind).toBe('job')
    expect(node(g, `f:${CHART}/templates/migrate-job.yaml`).tags).toContain('parse-errors')
    expect(node(g, s(`${CHART}/values.yaml`, 'replicas')).signature).toBe('replicas: 2')
    // strings never reach a signature
    expect(node(g, s(`${CHART}/values.yaml`, 'imageName')).signature).toBe('imageName: "…"')
  })

  it('reads compose services, Dockerfile stages, SQL and application configuration', () => {
    expect(edge(g, s('docker-compose.yml', 'orders'), 'references', s('docker-compose.yml', 'db'))?.subkind).toBe('depends-on')
    expect(edge(g, s('docker-compose.yml', 'orders'), 'references', 'f:services/orders/Dockerfile')?.subkind).toBe('builds')
    expect(edge(g, s('docker-compose.yml', 'db'), 'references', 'f:db/init.sql')).toBeDefined()
    expect(node(g, s('docker-compose.yml', 'db')).signature).toBe('image: mysql:8.4')
    expect(edge(g, s('services/orders/Dockerfile', 'stage-1'), 'references', s('services/orders/Dockerfile', 'build'))).toBeDefined()
    expect(node(g, 'f:services/orders/Dockerfile').tags).toEqual(expect.arrayContaining(['image:gradle', 'image:distroless/java21-debian12']))
    expect(node(g, s('db/init.sql', 'orders')).tags).toContain('table:orders')
    expect(node(g, s('infra/sql/schema.sql', 'audit.customer_log')).subkind).toBe('table')
    expect(node(g, 'f:services/orders/src/main/resources/application.yml').tags).toContain('app-config')
  })

  it('reads shell scripts: functions, and the scripts and files they run, following cd', () => {
    expect(node(g, s('infra/lib.sh', 'log')).subkind).toBe('function')
    expect(node(g, s('infra/lib.sh', 'die')).range).toEqual([8, 1, 11, 2])
    expect(edge(g, 'f:infra/up.sh', 'references', 'f:infra/kafka/create-topics.sh')?.subkind).toBe('runs')
    expect(edge(g, 'f:infra/up.sh', 'references', 'f:infra/mysql/create-databases.sh')?.subkind).toBe('runs') // after `cd ../mysql`
    expect(edge(g, 'f:infra/up.sh', 'references', 'f:infra/lib.sh')).toBeDefined()
    expect(edge(g, 'f:infra/up.sh', 'references', 'f:infra/values/kafka-values.yaml')?.subkind).toBe('uses')
    expect(edge(g, 'f:infra/up.sh', 'references', 'f:infra/mongodb/mongodb-values.yaml')).toBeDefined() // "$(dirname "$0")/…"
  })

  it('reads the manifests a script hands to kubectl, which the charts then use', () => {
    const sa = s('infra/cluster.sh', 'ServiceAccount/backend-sa')
    expect(node(g, sa).range).toEqual([6, 1, 10, 24])
    expect(edge(g, s(`${CHART}/templates/app.yaml`, 'Deployment/orders'), 'references', sa)?.subkind).toBe('uses')
  })

  it('states the topics and databases the infrastructure creates', () => {
    const topics = facts<MessagingFact>('messaging').map(f => `${f.file} ${f.owner} ${f.topics?.join(',')}`)
    expect(topics.sort()).toEqual([
      'infra/kafka/create-topics.sh f:infra/kafka/create-topics.sh acme.$ENV.orders.v1', // not the commented-out one, nor a helper's "$1"
      'k8s/web.yaml s:k8s/web.yaml#KafkaTopic/shop-events acme.shop.events',
    ])
    expect(facts<MessagingFact>('messaging').every(f => f.type === 'declare' && f.module === '')).toBe(true)
    const dbs = facts<DatastoreFact>('datastore').map(f => `${f.engine}:${f.name} ${f.owner}`)
    expect(dbs.sort()).toEqual([
      'mongodb: f:infra/mongodb/mongodb-values.yaml', // the server a Helm chart runs
      'mongodb:acme-orders-db f:infra/mongodb/mongodb-values.yaml',
      'mysql:acme_orders_db f:infra/mysql/create-databases.sh',
      'postgres:acme_reports_db f:infra/mysql/create-databases.sh',
      'sql:orders_local s:db/init.sql#orders_local',
    ])
    const created = facts<DatastoreFact>('datastore').find(f => f.name === 'acme_orders_db')!
    expect(created.site).toEqual([6, 17])
  })

  it('never reads secrets', () => {
    expect(g.nodes.some(n => n.path?.startsWith('infra/secrets/'))).toBe(false)
    expect(isSecretPath('infra/secrets/dev01/kafka.yaml')).toBe(true)
    expect(isSecretPath('infra/certificates/apex/cert.pfx')).toBe(true)
    expect(isSecretPath('k8s/velero/credentials-velero.properties')).toBe(true)
    expect(isSecretPath('k8s/kafka/kafka-values.yaml')).toBe(false)
    expect(isEncrypted('value: ENC[AES256_GCM,data:x]\n')).toBe(true)
    expect(JSON.stringify(all)).not.toContain('ROOT_PW')
  })

  it('analyzes a Pulumi folder as a light project and tags the resources it creates', () => {
    expect(node(g, s('infra/pulumi/index.ts', 'createGroup')).tags).toEqual(
      expect.arrayContaining(['pulumi:azure-native:resources:ResourceGroup', 'pulumi:azure-native:storage:StorageAccount']),
    )
    expect(node(g, s('infra/pulumi/index.ts', 'createGroup')).tags).not.toContain('pulumi:pulumi:index:Config')
    expect(edge(g, s('infra/pulumi/index.ts', 'createGroup'), 'references', s('infra/pulumi/config.ts', 'region'))).toBeDefined()
    expect(edge(g, 'f:infra/pulumi/index.ts', 'imports', 'x:npm:@pulumi/azure-native')).toBeDefined()
  })
})

describe('infra reader parts', () => {
  it('classifies files by name and place', () => {
    const files = new Set(['c/Chart.yaml', 'c/templates/a.yaml', 'c/templates/_h.tpl', 'other/templates/x.yaml'])
    expect(classify('c/Chart.yaml', files)).toBe('chart')
    expect(classify('c/templates/a.yaml', files)).toBe('helm-template')
    expect(classify('c/templates/_h.tpl', files)).toBe('helm-helpers')
    expect(classify('other/templates/x.yaml', files)).toBe('manifest') // a pipeline's templates folder
    expect(classify('k8s/kafka/kafka-values.yaml', files)).toBe('values')
    expect(classify('svc/src/main/resources/config/kafka.yml', files)).toBe('app-config')
    expect(classify('docker/docker-compose.e2e.yml', files)).toBe('compose')
    expect(classify('services/x/Dockerfile_local', files)).toBe('dockerfile')
    expect(classify('README.md', files)).toBeUndefined()
  })

  it('renders a template leniently, keeping its line numbers', () => {
    const r = renderTemplate('{{- if .Values.on }}\nname: {{ .Chart.Name }}-x\nport: {{ .Values.port }}\nhost: {{ quote .Values.host }}\n{{- end }}\n', {
      chart: { name: 'api', version: '1.0.0' },
      values: { port: 8080 },
    })
    expect(r.text.split('\n')).toEqual(['', 'name: api-x', 'port: 8080', 'host: "…"', '', ''])
    expect(r.complexity).toBe(2)
  })

  it('names images without registry, tag and digest', () => {
    expect(imageName('acmeacr01.azurecr.io/bitnami/mongodb:8.0.3')).toBe('bitnami/mongodb')
    expect(imageName('docker.io/library/nginx:1.27@sha256:abc123')).toBe('nginx')
    expect(imageName('localhost:5000/team/app')).toBe('team/app')
    expect(imageName('${BASE_IMAGE}')).toBeUndefined()
  })
})

describe('mounts and git history', () => {
  /** A second repository, of other commits by another author, interleaved with the root's in time. */
  function makeInfraRepo(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    const git = (args: string[], date?: string) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Grace',
          GIT_AUTHOR_EMAIL: 'grace@example.com',
          GIT_COMMITTER_NAME: 'Grace',
          GIT_COMMITTER_EMAIL: 'grace@example.com',
          ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
        },
      })
    git(['init', '-q'])
    const steps: [string, Record<string, string>][] = [
      ['2026-01-20T10:00:00Z', { 'up.sh': '#!/bin/bash\n./kafka/topics.sh\n' }],
      ['2026-03-15T10:00:00Z', { 'up.sh': '#!/bin/bash\nset -e\n./kafka/topics.sh\n', 'kafka/topics.sh': 'kafka-topics.sh --create --topic a.b\n' }],
      ['2026-07-01T10:00:00Z', { 'kafka/topics.sh': 'kafka-topics.sh --create --topic a.b\nkafka-topics.sh --create --topic a.c\n' }],
    ]
    for (const [date, write] of steps) {
      for (const [file, text] of Object.entries(write)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        fs.writeFileSync(path.join(dir, file), text)
      }
      git(['add', '-A'])
      git(['commit', '-q', '-m', `step ${date}`], date)
    }
  }

  it("joins a mount's commits with the root's, each file counted in its own repository", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'archrift-infra-history-'))
    const root = path.join(base, 'system')
    const ops = path.join(base, 'ops')
    makeHistoryRepo(root)
    makeInfraRepo(ops)
    const g = await analyze({ root, config: ConfigSchema.parse({ mounts: { infra: ops } }), cacheDir: false })
    // 6 commits by Ada in the root, 3 by Grace in the mount
    expect(g.meta.history).toMatchObject({ commits: 9, authors: 2, since: Date.parse('2026-01-05T10:00:00Z') / 1000, until: Date.parse('2026-07-01T10:00:00Z') / 1000 })
    expect(node(g, 'f:infra/up.sh').metrics).toMatchObject({ commits: 2, authors: 1, lastCommit: Date.parse('2026-03-15T10:00:00Z') / 1000 })
    expect(node(g, 'f:infra/kafka/topics.sh').metrics).toMatchObject({ commits: 2, churn: 1 }) // only the July commit (one line added) is in the 90 days
    expect(node(g, 'f:src/a.ts').metrics?.commits).toBe(5)
    // the mount's commits never touch the root's files, and the other way round
    expect(g.edges.filter(e => e.kind === 'co-changes').every(e => e.source.startsWith('f:infra/') === e.target.startsWith('f:infra/'))).toBe(true)
  })
})

describe('infra fixture: what the infrastructure declares', async () => {
  const g = await analyzeFixture('infra-root')

  it('topics a script or a KafkaTopic resource creates are the topics the code uses', () => {
    expect(edge(g, 'f:infra/kafka/create-topics.sh', 'references', 'x:kafka:acme.orders')?.subkind).toBe('declares')
    expect(edge(g, 's:k8s/web.yaml#KafkaTopic/shop-events', 'references', 'x:kafka:acme.shop.events')?.subkind).toBe('declares')
    // `acme.$ENV.orders.v1` keys without the environment and the version
    expect(node(g, 'x:kafka:acme.orders').signature).toBe('acme.$ENV.orders.v1')
  })

  it('databases created by scripts and values files, per engine', () => {
    expect(edge(g, 'f:infra/mysql/create-databases.sh', 'references', 'x:db:mysql:acme-orders')?.subkind).toBe('declares')
    expect(edge(g, 'f:infra/mysql/create-databases.sh', 'references', 'x:db:postgres:acme-reports')?.subkind).toBe('declares')
    expect(edge(g, 'f:infra/mongodb/mongodb-values.yaml', 'references', 'x:db:mongodb:acme-orders')?.subkind).toBe('declares')
  })
})
