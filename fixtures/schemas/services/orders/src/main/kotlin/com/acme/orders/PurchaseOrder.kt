package com.acme.orders

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.ForeignKey
import jakarta.persistence.Index
import jakarta.persistence.JoinColumn
import jakarta.persistence.ManyToOne
import jakarta.persistence.Table
import java.time.Instant

@Entity
@Table(name = ORDER_TABLE, indexes = [Index(name = "IX_Order_Placed", columnList = "placedAt")])
class PurchaseOrder(
    @ManyToOne(optional = false)
    @JoinColumn(foreignKey = ForeignKey(name = "FK_Order_Customer"))
    val customer: Customer,
    @Column(unique = true) val number: String,
    val note: String?,
    val placedAt: Instant,
) : BaseEntity<Long>()

const val ORDER_TABLE = "purchase_order"
