package com.acme.orders

import jakarta.persistence.AttributeOverride
import jakarta.persistence.CollectionTable
import jakarta.persistence.Column
import jakarta.persistence.ElementCollection
import jakarta.persistence.Embedded
import jakarta.persistence.Entity
import jakarta.persistence.OneToMany
import jakarta.persistence.Transient

// no primary constructor: its properties are all in the body
@Entity
class Customer : BaseEntity<Long>() {
  @Column(nullable = false, length = NAME_LENGTH) lateinit var displayName: String

  @Embedded
  @AttributeOverride(name = "city", column = Column(name = "town"))
  var address: Address? = null

  @OneToMany(mappedBy = "customer") var orders: MutableList<PurchaseOrder> = mutableListOf()

  @ElementCollection @CollectionTable(name = "CUSTOMER_TAG") var tags: MutableSet<String> = mutableSetOf()

  @Transient var cached: String? = null

  val upper: String
    get() = displayName.uppercase()

  companion object {
    const val NAME_LENGTH = 100
  }
}
