// Message topics (docs/POLYGLOT.md, P4): the `messaging` facts any language
// records become one node per topic (`x:kafka:<key>`, tagged `topic` and
// `infra`) and `publishes` / `subscribes` edges from the code that sends to
// or listens on it; a script or configuration class that creates the topic
// `references` it (subkind `declares`).
//
// Code rarely names a topic outright: a Spring listener gives a property
// placeholder (`${custom.kafka.bindings.user.kafkaTopic}`) or looks a channel
// up (`getTopicForChannel('order')`), a Go service a configuration key. Each
// is resolved through the module's own configuration (module-config.ts). The
// names that come out differ per environment (`acme.local.x`, `acme.$APP_ENV.x.v2`),
// so a topic's key leaves out environment and version parts: they meet there.
import type { MessagingFact } from './messaging-facts.ts'
import { canonical, moduleConfig } from './module-config.ts'
import type { ModuleConfig } from './module-config.ts'
import type { Plugin } from './types.ts'

/** Segments naming an environment, not the topic. */
const ENVIRONMENTS = /^(local|dev\d*|develop|test\d*|int|integration|qa|stage|staging|sandbox|prod|production|docker|kubernetes|k8s)$/i
const CHANNEL_LOOKUP = /getTopicForChannel\(\s*['"]([^'"]+)['"]\s*\)/

/** A topic name's key: its segments without environments, placeholders or a trailing version. */
export function topicKey(name: string): string | undefined {
  const parts = name
    .trim()
    .split('.')
    .filter(p => p && !p.includes('$') && !p.includes('{') && !ENVIRONMENTS.test(p))
  if (parts.length > 1 && /^v\d+$/i.test(parts[parts.length - 1])) parts.pop()
  return parts.length ? parts.join('.') : undefined
}

/** What a channel is bound to: a `bindings.<channel>.<kafkaTopic|destination|topic|name>` property. */
function channelTopics(config: ModuleConfig, channel: string): string[] {
  const c = canonical(channel)
  const keys = config.keys(k => new RegExp(`(^|\\.)bindings\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(kafkatopic|destination|topic|name)$`).test(k))
  const names = keys.flatMap(k => config.values(k).map(v => config.resolve(v)).filter((v): v is string => v !== undefined))
  return names.length ? [names[0]] : [channel]
}

/** The topic names a fact stands for, as far as the module's configuration says. */
export function topicNames(fact: MessagingFact, config: ModuleConfig): string[] {
  const out: string[] = []
  for (const t of fact.topics ?? []) {
    const channel = CHANNEL_LOOKUP.exec(t)?.[1]
    if (channel) out.push(...channelTopics(config, channel))
    else if (t.includes('${')) {
      const r = config.resolve(t)
      if (r !== undefined) out.push(r)
    } else if (!t.includes('#{')) out.push(t)
  }
  for (const ch of fact.channels ?? []) out.push(...channelTopics(config, ch))
  for (const p of fact.properties ?? []) {
    const r = config.values(p).map(v => config.resolve(v)).find(v => v !== undefined)
    if (r) out.push(r)
  }
  return [...new Set(out)]
}

export const messaging: Plugin = {
  name: 'messaging',
  version: 1,

  assemble(api) {
    const found: { fact: MessagingFact; key: string; name: string }[] = []
    for (const { fact } of api.facts<MessagingFact>('messaging')) {
      if (!api.nodes.has(fact.owner)) continue
      for (const name of topicNames(fact, moduleConfig(api, fact.module))) {
        const key = topicKey(name)
        if (key) found.push({ fact, key, name })
      }
    }
    if (!found.length) return
    // a topic is named without what all topic keys share (`acme.`)
    const keys = [...new Set(found.map(f => f.key))].sort()
    const shared = keys.length > 1 ? commonPrefix(keys.map(k => k.split('.'))) : 0
    for (const key of keys) {
      const label = key.split('.').slice(shared).join('.') || key
      const names = [...new Set(found.filter(f => f.key === key).map(f => f.name))].sort()
      api.addNode({ id: `x:kafka:${key}`, kind: 'external', name: label, tags: ['kafka', 'topic', 'infra'], signature: names.join(', ') })
    }
    for (const { fact, key } of found) {
      const target = `x:kafka:${key}`
      const site = [fact.site[0], fact.site[1]]
      if (fact.type === 'declare') api.addEdge({ source: fact.owner, target, kind: 'references', subkind: 'declares', count: 1, targets: api.targets, confidence: 'inferred' }, site)
      else api.addEdge({ source: fact.owner, target, kind: fact.type === 'publish' ? 'publishes' : 'subscribes', count: 1, targets: api.targets, confidence: 'inferred' }, site)
    }
  },
}

/** How many leading segments every key shares, leaving each at least one of its own. */
function commonPrefix(lists: string[][]): number {
  let n = 0
  const min = Math.min(...lists.map(l => l.length)) - 1
  while (n < min && lists.every(l => l[n] === lists[0][n])) n++
  return n
}
