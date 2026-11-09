package com.acme.order

import com.acme.common.Audited
import com.acme.common.shout
import com.acme.messages.OrderEventAvro
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.stereotype.Service

@Audited
@Service
class OrderService(
    private val orderRepository: OrderRepository,
    private val kafkaTemplate: KafkaTemplate<String, OrderEventAvro>,
    private val topics: TopicProperties,
) {

  fun place(customer: String, size: Double): Order {
    val order = Order(0, customer.shout(), size)
    val saved = orderRepository.save(order)
    kafkaTemplate.send(ORDERS_TOPIC, customer, OrderEventAvro())
    return saved
  }

  fun of(customer: String): Orders = orderRepository.findAllByCustomer(customer)

  fun topicName(): String = topics.getTopicForChannel(PAYMENT_CHANNEL)

  companion object {
    const val ORDERS_TOPIC = "acme.local.orders"
    const val PAYMENT_CHANNEL = "payment"
  }
}
