// Kubernetes manifests: a symbol per resource (`Deployment/api`, subkind the
// kind lowercased) and the names it refers to, linked in pass B: an Ingress
// to its backend Services, a Service's selector to the workloads whose pods
// match, a workload to the ConfigMaps, Secrets, claims and service account it
// uses. Secret data and environment values are never read.
import type { Range } from '../../core/model.ts'
import { symbolId } from '../../core/ids.ts'
import type { MessagingFact } from '../plugins/messaging-facts.ts'
import type { DatastoreFact } from '../plugins/datastore-facts.ts'
import { asArray, asString, countLoc, engineOfImage, get, imageName, isObject, positionOf } from './common.ts'
import type { InfraDecl, InfraFile, InfraRef, K8sResource } from './model.ts'

/** Where each workload kind keeps its pod template. */
const POD_TEMPLATE: Record<string, string[]> = {
  Deployment: ['spec', 'template'],
  StatefulSet: ['spec', 'template'],
  DaemonSet: ['spec', 'template'],
  ReplicaSet: ['spec', 'template'],
  ReplicationController: ['spec', 'template'],
  Job: ['spec', 'template'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template'],
}

/** Workloads that run a server; a Job or CronJob with a database image is a client (a backup). */
const SERVER_KINDS = new Set(['StatefulSet', 'Deployment', 'DaemonSet', 'ReplicaSet'])

/** A YAML document that is a Kubernetes resource. */
export const isResource = (v: unknown): v is Record<string, unknown> =>
  isObject(v) && typeof v.apiVersion === 'string' && typeof v.kind === 'string' && asString(get(v, 'metadata', 'name')) !== undefined

export interface ResourceSink {
  file: InfraFile
  /** The text the document came from (a rendered template's, a heredoc's), for positions. */
  text: string
  /** Lines in the file before `text` starts (a heredoc in a script). */
  lineOffset?: number
}

/**
 * Adds a resource to the file: its symbol, the references it makes and the
 * facts it states. `at` overrides the symbol's range (a resource a template
 * renders from another file's named template sits on the include's line).
 */
export function addResource(sink: ResourceSink, doc: Record<string, unknown>, range: Range, span: [number, number], at?: { range: Range; via?: string }): K8sResource | undefined {
  const { file } = sink
  const kind = doc.kind as string
  const name = asString(get(doc, 'metadata', 'name'))!
  const namespace = asString(get(doc, 'metadata', 'namespace'))
  const symbolName = `${kind}/${name}`
  const id = symbolId(file.path, symbolName)
  if (file.decls.some(d => d.id === id)) return undefined
  const shift = sink.lineOffset ?? 0
  const where: Range = at?.range ?? [range[0] + shift, range[1], range[2] + shift, range[3]]
  const decl: InfraDecl = {
    id,
    kind: 'symbol',
    name: symbolName,
    subkind: kind.toLowerCase(),
    parent: `f:${file.path}`,
    range: where,
    signature: `${kind} ${name}${namespace ? ` -n ${namespace}` : ''}${at?.via ? ` (${at.via})` : ''}`,
    tags: ['k8s'],
    loc: at ? 1 : countLoc(sink.text, range[0], range[2]),
    complexity: 1,
  }
  file.decls.push(decl)
  const resource: K8sResource = { id, kind, name, ...(namespace ? { namespace } : {}) }
  ;(file.resources ??= []).push(resource)

  // a reference's site: where the name it uses is written, else the resource's first line
  const siteOf = (needle: string): [number, number] => {
    if (at) return [at.range[0], at.range[1]]
    const i = sink.text.indexOf(needle, span[0])
    const [line, col] = i >= 0 && i < span[1] ? positionOf(sink.text, i) : [range[0], range[1]]
    return [line + shift, col]
  }
  const ref = (target: InfraRef['target'], subkind: string, needle: string) => {
    const [line, col] = siteOf(needle)
    file.refs.push({ source: id, target, subkind, line, col })
  }
  const byName = (kinds: string[], target: unknown, subkind: string) => {
    const n = asString(target)
    if (n) ref({ to: 'k8s', kinds, name: n, ...(namespace ? { namespace } : {}) }, subkind, n)
  }
  const selects = (labels: unknown, subkind: string) => {
    if (!isObject(labels)) return
    const pairs = Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, asString(v) ?? String(v)]))
    if (Object.keys(pairs).length) ref({ to: 'pods', labels: pairs, ...(namespace ? { namespace } : {}) }, subkind, Object.keys(pairs)[0])
  }

  switch (kind) {
    case 'Service':
      if (get(doc, 'spec', 'type') !== 'ExternalName') selects(get(doc, 'spec', 'selector'), 'selects')
      break
    case 'Ingress': {
      const backends: unknown[] = [get(doc, 'spec', 'defaultBackend'), get(doc, 'spec', 'backend')]
      for (const rule of asArray(get(doc, 'spec', 'rules'))) for (const p of asArray(get(rule, 'http', 'paths'))) backends.push(get(p, 'backend'))
      for (const b of backends) byName(['Service'], get(b, 'service', 'name') ?? get(b, 'serviceName'), 'backend')
      break
    }
    case 'HorizontalPodAutoscaler': {
      const target = get(doc, 'spec', 'scaleTargetRef')
      const k = asString(get(target, 'kind'))
      if (k) byName([k], get(target, 'name'), 'scales')
      break
    }
    case 'PodDisruptionBudget':
      selects(get(doc, 'spec', 'selector', 'matchLabels'), 'selects')
      break
    case 'NetworkPolicy':
      selects(get(doc, 'spec', 'podSelector', 'matchLabels'), 'selects')
      break
    case 'RoleBinding':
    case 'ClusterRoleBinding': {
      const roleKind = asString(get(doc, 'roleRef', 'kind'))
      if (roleKind) byName([roleKind], get(doc, 'roleRef', 'name'), 'binds')
      for (const s of asArray(doc.subjects)) if (get(s, 'kind') === 'ServiceAccount') byName(['ServiceAccount'], get(s, 'name'), 'binds')
      break
    }
    case 'KafkaTopic': {
      // Strimzi: the topic is spec.topicName, or the resource's name
      const topic = asString(get(doc, 'spec', 'topicName')) ?? name
      const [line, col] = siteOf(topic)
      const fact: MessagingFact = { type: 'declare', owner: id, topics: [topic], module: '', site: [line, col] }
      ;(file.facts.messaging ??= []).push(fact)
      break
    }
  }

  // workloads: the pods they run, and what those use
  const template = POD_TEMPLATE[kind] ? get(doc, ...POD_TEMPLATE[kind]) : kind === 'Pod' ? doc : undefined
  if (template !== undefined) {
    const labels = get(template, 'metadata', 'labels')
    if (isObject(labels)) resource.podLabels = Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, asString(v) ?? String(v)]))
    const spec = get(template, 'spec')
    const images = new Set<string>()
    for (const c of [...asArray(get(spec, 'containers')), ...asArray(get(spec, 'initContainers'))]) {
      const image = asString(get(c, 'image'))
      const img = image && imageName(image)
      if (img) images.add(img)
      for (const e of asArray(get(c, 'env'))) {
        byName(['ConfigMap'], get(e, 'valueFrom', 'configMapKeyRef', 'name'), 'uses')
        byName(['Secret'], get(e, 'valueFrom', 'secretKeyRef', 'name'), 'uses')
      }
      for (const e of asArray(get(c, 'envFrom'))) {
        byName(['ConfigMap'], get(e, 'configMapRef', 'name'), 'uses')
        byName(['Secret'], get(e, 'secretRef', 'name'), 'uses')
      }
    }
    for (const v of asArray(get(spec, 'volumes'))) {
      byName(['ConfigMap'], get(v, 'configMap', 'name'), 'uses')
      byName(['Secret'], get(v, 'secret', 'secretName'), 'uses')
      byName(['PersistentVolumeClaim'], get(v, 'persistentVolumeClaim', 'claimName'), 'uses')
      byName(['SecretProviderClass'], get(v, 'csi', 'volumeAttributes', 'secretProviderClass'), 'uses')
      for (const s of asArray(get(v, 'projected', 'sources'))) {
        byName(['ConfigMap'], get(s, 'configMap', 'name'), 'uses')
        byName(['Secret'], get(s, 'secret', 'name'), 'uses')
      }
    }
    byName(['ServiceAccount'], get(spec, 'serviceAccountName'), 'uses')
    for (const s of asArray(get(spec, 'imagePullSecrets'))) byName(['Secret'], get(s, 'name'), 'uses')
    for (const img of [...images].sort()) {
      decl.tags.push(`image:${img}`)
      const engine = SERVER_KINDS.has(kind) ? engineOfImage(img) : undefined
      if (engine) {
        const fact: DatastoreFact = { type: 'declare', owner: id, engine, name: '', module: '', site: [where[0], where[1]] }
        ;(file.facts.datastore ??= []).push(fact)
      }
    }
  }
  return resource
}
