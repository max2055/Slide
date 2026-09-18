CREATE TABLE IF NOT EXISTS metric_v2_schedule (
  resource_key VARCHAR(128) NOT NULL PRIMARY KEY COMMENT 'resource key',
  revision BIGINT UNSIGNED NOT NULL COMMENT 'revision',
  next_due_ms BIGINT UNSIGNED NOT NULL COMMENT 'next due ms',
  last_end_ms BIGINT UNSIGNED NULL COMMENT 'last end ms',
  job_id VARCHAR(64) NULL COMMENT 'job id',
  states JSON NOT NULL COMMENT 'states',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at'
) ENGINE=InnoDB COMMENT='Metrics v2 durable scheduling';

CREATE TABLE IF NOT EXISTS metric_v2_schedule_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'id',
  resource_key VARCHAR(128) NOT NULL COMMENT 'resource key',
  job_id VARCHAR(64) NOT NULL COMMENT 'job id',
  revision BIGINT UNSIGNED NOT NULL COMMENT 'revision',
  code VARCHAR(64) NOT NULL COMMENT 'code',
  uncertain BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'uncertain',
  duration_ms BIGINT UNSIGNED NOT NULL COMMENT 'duration ms',
  logical_reads INT UNSIGNED NOT NULL COMMENT 'logical reads',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  INDEX idx_metric_schedule_event (resource_key, created_at)
) ENGINE=InnoDB COMMENT='Metrics v2 durable scheduling';
