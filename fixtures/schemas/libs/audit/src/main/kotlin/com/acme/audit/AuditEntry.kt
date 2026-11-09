package com.acme.audit

import jakarta.persistence.Entity
import jakarta.persistence.Id

// a library's entity: its table lives in the databases of the services using it
@Entity
class AuditEntry(@Id val id: Long, val text: String)
