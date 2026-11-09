package com.acme.orders

import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.mongodb.repository.MongoRepository

interface OrderRepository : JpaRepository<PurchaseOrder, Long> {
  fun findByNumber(number: String): PurchaseOrder?
}

interface CustomerRepository : JpaRepository<Customer, Long>

interface EventRepository : MongoRepository<OrderEvent, String>
