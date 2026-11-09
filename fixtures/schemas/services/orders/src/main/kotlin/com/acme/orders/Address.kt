package com.acme.orders

import jakarta.persistence.Column
import jakarta.persistence.Embeddable
import jakarta.persistence.MappedSuperclass

@MappedSuperclass
abstract class Place {
  var city: String? = null
}

@Embeddable
class Address(@Column(name = "streetName") val street: String) : Place()
