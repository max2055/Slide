CREATE TABLE IF NOT EXISTS operations (
  id CHAR(36) NOT NULL,
  actor_id INT UNSIGNED NOT NULL,
  origin VARCHAR(32) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(128) NOT NULL,
  command_type VARCHAR(32) NOT NULL,
  risk VARCHAR(16) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  approval_id BIGINT UNSIGNED NULL,
  correlation_id CHAR(36) NOT NULL,
  state VARCHAR(32) NOT NULL,
  attempt INT UNSIGNED NOT NULL DEFAULT 1,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at DATETIME NULL,
  result_json JSON NULL,
  error_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_operations_actor_idempotency (actor_id, idempotency_key),
  KEY idx_operations_state_lease (state, lease_expires_at),
  KEY idx_operations_correlation (correlation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operation_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id CHAR(36) NOT NULL,
  from_state VARCHAR(32) NULL,
  to_state VARCHAR(32) NOT NULL,
  reason_code VARCHAR(64) NOT NULL,
  actor_id INT UNSIGNED NULL,
  metadata JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_operation_events_operation_created (operation_id, created_at, id),
  CONSTRAINT fk_operation_events_operation FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @approval_operation_col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND COLUMN_NAME = 'operation_id');
SET @approval_operation_sql = IF(@approval_operation_col_exists = 0,
  'ALTER TABLE approval_requests ADD COLUMN operation_id CHAR(36) NULL, ADD KEY idx_approval_operation (operation_id)',
  'SELECT 1');
PREPARE approval_operation_stmt FROM @approval_operation_sql; EXECUTE approval_operation_stmt; DEALLOCATE PREPARE approval_operation_stmt;
