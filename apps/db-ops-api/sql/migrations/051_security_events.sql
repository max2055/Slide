CREATE TABLE IF NOT EXISTS security_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type VARCHAR(64) NOT NULL,
  reason_code VARCHAR(96) NOT NULL,
  actor_id BIGINT NULL,
  resource_type VARCHAR(64) NULL,
  resource_id VARCHAR(128) NULL,
  request_id VARCHAR(128) NULL,
  fingerprint CHAR(64) NOT NULL,
  occurrence_count INT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_security_event_fingerprint (fingerprint),
  KEY idx_security_event_type_time (event_type, last_seen_at),
  KEY idx_security_event_actor_time (actor_id, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
