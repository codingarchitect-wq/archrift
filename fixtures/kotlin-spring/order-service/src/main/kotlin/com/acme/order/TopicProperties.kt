package com.acme.order

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "custom.kafka")
class TopicProperties {
  var bindings: Map<String, String> = emptyMap()

  fun getTopicForChannel(channel: String): String = bindings.getValue(channel)
}
