package com.acme.orders

import java.time.Instant
import java.util.UUID
import org.springframework.data.annotation.Id
import org.springframework.data.mongodb.core.index.CompoundIndex
import org.springframework.data.mongodb.core.index.Indexed
import org.springframework.data.mongodb.core.mapping.DBRef
import org.springframework.data.mongodb.core.mapping.Document
import org.springframework.data.mongodb.core.mapping.Field

@Document(collection = EVENTS)
@CompoundIndex(name = "by_order_time", def = "{'order': 1, 'at': -1}")
data class OrderEvent(
    @Id val key: String,
    @Field("order") val orderNumber: String,
    @Indexed(unique = true) val sequence: Long,
    @DBRef val profile: CustomerProfile?,
    val at: Instant,
    val correlation: UUID,
) {
  companion object {
    const val EVENTS = "order_events"
  }
}

@Document
data class CustomerProfile(val id: String, val name: String?)
