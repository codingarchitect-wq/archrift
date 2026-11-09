package com.acme.order

import org.springframework.data.jpa.repository.JpaRepository

interface OrderRepository : JpaRepository<Order, Long> {
  fun findAllByCustomer(customer: String): List<Order>

  fun deleteAllByCustomer(customer: String)
}
