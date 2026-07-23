-- Delivery attempts are append-only.  notification_records remains the legacy
-- user-facing summary and must not be used as the retry state machine.
CREATE TABLE notification_delivery_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  workflow_job_id CHAR(36) NOT NULL,
  alert_id BIGINT UNSIGNED NOT NULL,
  channel_id INT UNSIGNED NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  status ENUM('started','sent','failed') NOT NULL,
  error_code VARCHAR(128) NULL,
  error_message VARCHAR(1024) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  UNIQUE KEY uq_notification_delivery_attempt (workflow_job_id, attempt_number),
  KEY idx_notification_delivery_alert_channel (alert_id, channel_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE notification_delivery_replays (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  workflow_job_id CHAR(36) NOT NULL,
  actor_id INT UNSIGNED NOT NULL,
  reason VARCHAR(512) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notification_delivery_replay_job (workflow_job_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
