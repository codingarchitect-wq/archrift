package com.acme.order

import java.time.Instant
import org.springframework.stereotype.Component

/** The time for orders, in java.time. */
@Component
class OrderClock {
  fun millis(): Long = Instant.now().toEpochMilli()
}
