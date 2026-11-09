package com.acme.order

import com.acme.common.Base
import jakarta.persistence.Entity
import jakarta.persistence.Table

@Entity
@Table(name = "orders")
class Order(val id: Long, val customer: String, val size: Double) : Base() {

  override fun area(): Double = size * size

  override fun describe(): String = "order $id: " + super.describe()
}

typealias Orders = List<Order>
