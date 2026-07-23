SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'report_configs' AND COLUMN_NAME = 'notification_channel_ids'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE report_configs ADD COLUMN notification_channel_ids JSON NULL AFTER format',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

CREATE TABLE IF NOT EXISTS report_notification_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  workflow_job_id VARCHAR(128) NOT NULL,
  report_id BIGINT UNSIGNED NOT NULL,
  channel_id INT UNSIGNED NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  status ENUM('started','sent','failed','skipped') NOT NULL,
  error_code VARCHAR(128) NULL,
  error_message VARCHAR(1024) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  UNIQUE KEY uq_report_notification_delivery_attempt (workflow_job_id, attempt_number),
  KEY idx_report_notification_delivery_report (report_id, created_at),
  KEY idx_report_notification_delivery_channel (channel_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
