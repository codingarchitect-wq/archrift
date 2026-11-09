package com.acme.order

import org.junit.jupiter.api.Test

class OrderServiceTest {
  @Test
  fun placesAnOrder(service: OrderService) {
    service.place("ada", Kind.SMALL.ordinal.toDouble())
    Registry.register("x")
  }
}
