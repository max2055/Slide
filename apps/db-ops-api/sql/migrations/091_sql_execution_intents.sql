CREATE TABLE IF NOT EXISTS sql_execution_intents (
  operation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY COMMENT 'Unique operation; never automatically replay',
  approval_request_id BIGINT NOT NULL UNIQUE COMMENT 'One dispatch per approval',
  instance_id BIGINT NOT NULL COMMENT 'Approved target instance',
  target_database VARCHAR(255) NULL COMMENT 'Approved database or schema',
  sql_text LONGTEXT NOT NULL COMMENT 'Exact approved SQL, without truncation',
  reviewer_id BIGINT NOT NULL COMMENT 'Validated approval reviewer',
  actor_id VARCHAR(255) NOT NULL COMMENT 'Caller identity or approval reviewer',
  state ENUM('unknown','succeeded','reconciled_applied','reconciled_not_applied') NOT NULL DEFAULT 'unknown' COMMENT 'Unknown includes crash before or after target dispatch',
  result_json JSON NULL COMMENT 'Acknowledged result or diagnostic outcome',
  reconciliation_json JSON NULL COMMENT 'Operator identity and external evidence; never re-executes SQL',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Durable intent time',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'Last observation time'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='SQL execution intent and recovery ledger in control database';
