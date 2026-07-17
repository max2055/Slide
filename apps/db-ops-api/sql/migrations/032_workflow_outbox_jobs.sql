CREATE TABLE outbox_events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  event_type VARCHAR(128) NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  aggregate_version BIGINT UNSIGNED NOT NULL,
  payload JSON NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_outbox_idempotency (idempotency_key),
  KEY idx_outbox_available (published_at, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE workflow_jobs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  job_type VARCHAR(128) NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  payload JSON NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  state ENUM('queued','running','retry','completed','dead_letter','cancelled') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner CHAR(36) NULL,
  lease_expires_at DATETIME NULL,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_workflow_job_idempotency (idempotency_key),
  KEY idx_workflow_claim (state, available_at, lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE workflow_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id CHAR(36) NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  worker_id CHAR(36) NOT NULL,
  fencing_token BIGINT UNSIGNED NOT NULL,
  state ENUM('running','succeeded','failed','abandoned') NOT NULL,
  error_message TEXT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  UNIQUE KEY uq_workflow_attempt (job_id, attempt_number),
  KEY idx_workflow_attempt_job (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
