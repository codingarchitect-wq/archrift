package com.acme.orders

import jakarta.persistence.Embeddable
import jakarta.persistence.Entity
import jakarta.persistence.Inheritance
import jakarta.persistence.InheritanceType.JOINED
import jakarta.persistence.Table

// single-table inheritance (the default): every subclass's rows are the root's table
@Entity
@Table(name = "payment")
abstract class Payment(val amount: Long) : BaseEntity<Long>()

@Entity
class CardPayment(val cardNumber: String) : Payment(0)

// joined: a subclass has a table of its own, its own columns and the root's key
@Entity
@Inheritance(strategy = JOINED)
abstract class Shipment(val carrier: String) : BaseEntity<Long>()

@Entity
class ParcelShipment(val weight: Int) : Shipment("post")

// an embeddable is no entity, even with @Table on it
@Embeddable
@Table(name = "not_a_table")
class Money(val cents: Long)
