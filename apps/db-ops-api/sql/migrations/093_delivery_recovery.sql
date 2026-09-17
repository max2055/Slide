-- Business send gate only: workflow_jobs remains the sole queue.
CREATE TABLE IF NOT EXISTS notification_delivery_states (
  business_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin COMMENT 'Stable source and channel business identity' PRIMARY KEY,
  kind ENUM('notification','report') NOT NULL COMMENT 'Delivery source kind',
  source_id BIGINT UNSIGNED NOT NULL COMMENT 'Alert or report identifier',
  channel_id INT UNSIGNED NOT NULL COMMENT 'Notification channel identifier',
  state ENUM('ready','sending','sent','retryable','failed','unknown','skipped') NOT NULL COMMENT 'Durable business delivery outcome',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Compare and swap recovery version',
  workflow_job_id VARCHAR(128) NOT NULL COMMENT 'Current owning workflow job',
  fencing_token BIGINT UNSIGNED NOT NULL COMMENT 'Current execution fencing token',
  attempt_id CHAR(36) NULL COMMENT 'Globally unique send attempt identifier',
  request_encrypted MEDIUMTEXT NULL COMMENT 'Encrypted frozen channel and message',
  request_digest CHAR(64) NULL COMMENT 'Frozen request SHA256 digest',
  idempotent_until DATETIME(3) NULL COMMENT 'Receiver deduplication contract deadline',
  error_code VARCHAR(128) NULL COMMENT 'Sanitized outcome classification',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Creation time',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'Last state change time',
  KEY idx_delivery_job (workflow_job_id),
  KEY idx_delivery_state (state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Durable external delivery send gate and reconciliation state';
ALTER TABLE notification_delivery_attempts MODIFY status ENUM('started','sent','failed','unknown','skipped') NOT NULL COMMENT 'Delivery attempt outcome including uncertain acceptance';
ALTER TABLE report_notification_deliveries MODIFY status ENUM('started','sent','failed','unknown','skipped') NOT NULL COMMENT 'Delivery attempt outcome including uncertain acceptance';

SET @delivery_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_delivery_replays' AND COLUMN_NAME = 'business_key') = 0, 'ALTER TABLE notification_delivery_replays ADD COLUMN business_key VARCHAR(128) NULL COMMENT ''Reconciled business delivery key''', 'SELECT 1');
PREPARE delivery_stmt FROM @delivery_ddl;
EXECUTE delivery_stmt;
DEALLOCATE PREPARE delivery_stmt;

SET @delivery_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_delivery_replays' AND COLUMN_NAME = 'state_version') = 0, 'ALTER TABLE notification_delivery_replays ADD COLUMN state_version BIGINT UNSIGNED NULL COMMENT ''Expected state version before recovery''', 'SELECT 1');
PREPARE delivery_stmt FROM @delivery_ddl;
EXECUTE delivery_stmt;
DEALLOCATE PREPARE delivery_stmt;

SET @delivery_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_delivery_replays' AND COLUMN_NAME = 'decision') = 0, 'ALTER TABLE notification_delivery_replays ADD COLUMN decision ENUM(''sent'',''abandon'',''retry'') NULL COMMENT ''Explicit recovery decision''', 'SELECT 1');
PREPARE delivery_stmt FROM @delivery_ddl;
EXECUTE delivery_stmt;
DEALLOCATE PREPARE delivery_stmt;

SET @delivery_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_delivery_replays' AND COLUMN_NAME = 'reconciliation') = 0, 'ALTER TABLE notification_delivery_replays ADD COLUMN reconciliation VARCHAR(1024) NULL COMMENT ''Operator receiver reconciliation evidence''', 'SELECT 1');
PREPARE delivery_stmt FROM @delivery_ddl;
EXECUTE delivery_stmt;
DEALLOCATE PREPARE delivery_stmt;

SET @delivery_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_delivery_replays' AND INDEX_NAME = 'uq_delivery_recovery_version') = 0, 'ALTER TABLE notification_delivery_replays ADD UNIQUE KEY uq_delivery_recovery_version (business_key, state_version)', 'SELECT 1');
PREPARE delivery_stmt FROM @delivery_ddl;
EXECUTE delivery_stmt;
DEALLOCATE PREPARE delivery_stmt;
