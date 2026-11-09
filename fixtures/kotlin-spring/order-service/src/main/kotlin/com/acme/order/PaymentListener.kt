package com.acme.order

import org.springframework.kafka.annotation.KafkaListener
import org.springframework.stereotype.Component

@Component
class PaymentListener(private val orderService: OrderService) {

  @KafkaListener(topics = ["\${custom.kafka.bindings.payment.kafkaTopic}"])
  fun listen(customer: String) {
    orderService.of(customer).forEach { it.describe() }
  }
}

object Registry {
  val shapes = mutableListOf<String>()

  fun register(name: String) = shapes.add(name)
}

enum class Kind {
  SMALL,
  LARGE
}
