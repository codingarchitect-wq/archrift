package com.acme.order

import java.util.Date
import org.springframework.stereotype.Component

/** Stamps exports the old way: a java.util.Date (the move to java.time isn't finished here). */
@Component
class LegacyStamp(private val clock: OrderClock) {
  fun stamp(): Date = Date(clock.millis())
}
