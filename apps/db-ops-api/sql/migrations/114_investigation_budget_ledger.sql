-- T07-A standalone ledger. The ordered MigrationRunner discovers this file.
-- Application rollback retains these facts; never refund unknown dispatches by dropping tables.
CREATE TABLE IF NOT EXISTS investigation_budget_domains (
  domain_key VARBINARY(128) NOT NULL PRIMARY KEY COMMENT 'Trusted security domain and serialization lock',
  policy_hash CHAR(64) NOT NULL COMMENT 'Frozen admission policy hash',
  policy_snapshot JSON NOT NULL COMMENT 'Frozen admission policy limits',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Creation time UTC'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Durable admission quota serialization';

CREATE TABLE IF NOT EXISTS investigation_budget_ledger (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'Reservation ID',
  request_id CHAR(36) NOT NULL COMMENT 'Existing investigation request',
  operation_id VARBINARY(128) NOT NULL COMMENT 'Stable execution operation key',
  domain_key VARBINARY(128) NOT NULL COMMENT 'Trusted security domain',
  mode ENUM('automatic','manual') NOT NULL COMMENT 'Admission lane',
  command_hash CHAR(64) NOT NULL COMMENT 'Exact reservation command hash',
  request_budget_hash CHAR(64) NOT NULL COMMENT 'Immutable request Profile domain lane and resource hash',
  reservation_snapshot JSON NOT NULL COMMENT 'Frozen Profile allocation and price table',
  state ENUM('reserved','sent','unknown','settled','cancelled') NOT NULL DEFAULT 'reserved' COMMENT 'Operation dispatch and settlement fact',
  reserved_tokens BIGINT UNSIGNED NOT NULL COMMENT 'Token ceiling reserved before dispatch',
  reserved_cost_micros BIGINT UNSIGNED NOT NULL COMMENT 'Nonzero monetary allowance before dispatch',
  charged_tokens BIGINT UNSIGNED NOT NULL COMMENT 'Measured tokens or conservative outstanding allowance',
  charged_cost_micros BIGINT UNSIGNED NOT NULL COMMENT 'Measured cost or conservative outstanding allowance',
  cost_status ENUM('reserved','known','unknown') NOT NULL DEFAULT 'reserved' COMMENT 'Cost measurement availability',
  usage_snapshot JSON NULL COMMENT 'Known provider raw input cached input and output usage',
  settlement_hash CHAR(64) NULL COMMENT 'Idempotent known settlement hash',
  budget_day DATE NOT NULL COMMENT 'UTC admission day',
  budget_hour DATETIME NOT NULL COMMENT 'UTC admission hour',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Reservation time UTC',
  sent_at DATETIME(3) NULL COMMENT 'Committed dispatch intent time UTC',
  settled_at DATETIME(3) NULL COMMENT 'Known settlement or pre-dispatch cancellation time UTC',
  UNIQUE KEY uq_investigation_budget_operation (request_id, operation_id),
  KEY idx_investigation_budget_domain (domain_key, state, budget_day, budget_hour),
  CONSTRAINT fk_investigation_budget_request FOREIGN KEY(request_id) REFERENCES investigation_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_investigation_budget_domain FOREIGN KEY(domain_key) REFERENCES investigation_budget_domains(domain_key) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Durable nonrefundable unknown usage and idempotent settlement';

CREATE TABLE IF NOT EXISTS investigation_budget_resources (
  reservation_id CHAR(36) NOT NULL COMMENT 'Reservation ID',
  resource_key VARBINARY(128) NOT NULL COMMENT 'Canonical required resource or platform component',
  PRIMARY KEY(reservation_id, resource_key),
  KEY idx_investigation_budget_resource (resource_key, reservation_id),
  CONSTRAINT fk_investigation_budget_resource FOREIGN KEY(reservation_id) REFERENCES investigation_budget_ledger(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='All-resource admission quota footprint';
