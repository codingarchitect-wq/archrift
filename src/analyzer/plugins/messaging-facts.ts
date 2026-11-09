// The `messaging` fact channel (docs/POLYGLOT.md): code that sends to or
// listens on a message topic, from any language, and scripts that create
// topics. plugins/messaging.ts resolves the names (configuration properties,
// channels) to topics and draws `publishes` and `subscribes` edges.

export interface MessagingFact {
  /** publish/subscribe: code sends or listens; declare: creates or configures the topic. */
  type: 'publish' | 'subscribe' | 'declare'
  /** The symbol or member (or file) doing it. */
  owner: string
  /**
   * Topic names as written: a literal (`acme.local.image.resize`), a Spring
   * property placeholder (`${app.kafka.bindings.user.topic}`), or SpEL
   * looking one up by channel (`#{props.getTopicForChannel('order')}`).
   */
  topics?: string[]
  /** Channel names the code looks topics up by, resolved through the module's configuration. */
  channels?: string[]
  /** Configuration properties holding the topic name (Go: `kafka.topic.resized.name`). */
  properties?: string[]
  /** The module folder whose configuration files (application*.yml …) name the topics; '' for none. */
  module: string
  site: [number, number]
}
