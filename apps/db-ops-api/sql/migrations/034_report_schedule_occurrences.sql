CREATE TABLE report_schedule_occurrences (
  config_id INT UNSIGNED NOT NULL,
  occurrence_at DATETIME NOT NULL,
  state ENUM('queued','running','completed','failed') NOT NULL DEFAULT 'queued',
  report_id BIGINT UNSIGNED NULL,
  last_error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (config_id, occurrence_at),
  KEY idx_report_occurrence_state (state, occurrence_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
