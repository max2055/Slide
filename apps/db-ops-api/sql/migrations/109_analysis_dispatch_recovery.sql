ALTER TABLE ai_analysis
  MODIFY COLUMN status ENUM('pending','running','completed','failed','unknown') NOT NULL DEFAULT 'pending' COMMENT 'Analysis lifecycle; unknown may already be billed',
  ADD COLUMN legacy_status VARCHAR(16) NULL COMMENT 'Original legacy lifecycle retained during reconciliation',
  ADD COLUMN recovery_reason VARCHAR(128) NULL COMMENT 'Stable recovery or operator reconciliation reason';

CREATE TABLE analysis_dispatches (
  analysis_id INT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'Analysis record identity',
  job_id CHAR(36) NOT NULL COMMENT 'Durable workflow job identity',
  request_snapshot JSON NOT NULL COMMENT 'Immutable secret-free authorized request',
  evidence_version CHAR(64) NOT NULL COMMENT 'Frozen evidence SHA-256',
  config_version CHAR(64) NOT NULL COMMENT 'Provider and prompt configuration SHA-256',
  authorization_version CHAR(64) NOT NULL COMMENT 'Frozen actor permission scope SHA-256',
  request_state ENUM('unsent','sending','responded','completed','failed','unknown') NOT NULL DEFAULT 'unsent' COMMENT 'Request boundary and terminal state',
  attempt_number INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Workflow attempt bound to this run',
  owner_id CHAR(36) NULL COMMENT 'Workflow lease owner identity',
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic workflow fencing token',
  current_run_id CHAR(36) NULL COMMENT 'Current agent runtime run identity',
  retry_of INT UNSIGNED NULL COMMENT 'Explicitly confirmed unknown analysis predecessor',
  reason VARCHAR(128) NULL COMMENT 'Stable dispatch reconciliation reason',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last record mutation time',
  UNIQUE KEY uq_analysis_dispatch_job (job_id),
  KEY idx_analysis_dispatch_recovery (request_state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='analysis dispatches';

CREATE TABLE analysis_dispatch_attempts (
  analysis_id INT UNSIGNED NOT NULL COMMENT 'Analysis record identity',
  attempt_number INT UNSIGNED NOT NULL COMMENT 'Workflow attempt bound to this run',
  job_id CHAR(36) NOT NULL COMMENT 'Durable workflow job identity',
  owner_id CHAR(36) NOT NULL COMMENT 'Workflow lease owner identity',
  fencing_token BIGINT UNSIGNED NOT NULL COMMENT 'Monotonic workflow fencing token',
  runtime_run_id CHAR(36) NOT NULL COMMENT 'Agent runtime run identity',
  request_state ENUM('unsent','sending','responded','completed','failed','unknown','abandoned') NOT NULL DEFAULT 'unsent' COMMENT 'Request boundary and terminal state',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Attempt start time',
  finished_at DATETIME NULL COMMENT 'Attempt settlement time',
  PRIMARY KEY (analysis_id, attempt_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='analysis dispatch attempts';

CREATE TABLE analysis_dispatch_keys (
  scope_key CHAR(64) NOT NULL PRIMARY KEY COMMENT 'Persistent admission scope SHA-256',
  analysis_id INT UNSIGNED NULL COMMENT 'Analysis record identity',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last record mutation time'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='analysis dispatch keys';
