package com.acme.order

import com.acme.common.Base.Companion.API
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping(API)
class OrderController(private val orderService: OrderService) {

  @GetMapping(ORDERS_BY_CUSTOMER)
  fun list(@PathVariable customer: String): Orders = orderService.of(customer)

  @PostMapping(*[ORDERS, "$ORDERS/new"])
  fun create(@PathVariable customer: String): Order {
    val order = orderService.place(customer, 2.0)
    return order
  }

  companion object {
    const val ORDERS = "/orders"
    const val ORDERS_BY_CUSTOMER = "$ORDERS/{customer}"
  }
}
