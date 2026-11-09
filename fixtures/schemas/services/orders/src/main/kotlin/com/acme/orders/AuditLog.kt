package com.acme.orders

import jakarta.persistence.Entity
import jakarta.persistence.ManyToOne

// no CREATE TABLE for it: its columns come from the entity
@Entity
class AuditLog(val message: String, @ManyToOne val order: PurchaseOrder?) : BaseEntity<Long>()
