package com.acme.orders

import jakarta.persistence.GeneratedValue
import jakarta.persistence.Id
import jakarta.persistence.MappedSuperclass
import jakarta.persistence.Version

@MappedSuperclass
abstract class BaseEntity<ID> {
  @Id @GeneratedValue var id: ID? = null

  @Version var version: Long = 0
}
