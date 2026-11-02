-- Immutable post-failure observations; no new Investigation/Run lifecycle.
CREATE TABLE IF NOT EXISTS platform_event_verifications (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'Verification receipt',
  event_id CHAR(36) NOT NULL COMMENT 'Original durable failure',
  investigation_id CHAR(36) NOT NULL COMMENT 'Original linked investigation',
  actor_id INT UNSIGNED NOT NULL COMMENT 'Live operator',
  idempotency_key VARBINARY(255) NOT NULL COMMENT 'Retry identity',
  command_hash CHAR(64) NOT NULL COMMENT 'Event, investigation and expected revision',
  payload JSON NOT NULL COMMENT 'Original hash, window, deployment, safe observation and conclusion',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Database receipt time',
  UNIQUE KEY uq_platform_verification (investigation_id, actor_id, idempotency_key),
  KEY idx_platform_verification_event (event_id, created_at),
  CONSTRAINT fk_platform_verification_event FOREIGN KEY(event_id) REFERENCES operational_events(id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_verification_investigation FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_verification_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Audited platform recovery observations';
