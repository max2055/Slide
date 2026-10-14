-- T11 additive audit storage. No rewrite of machine results or trusted knowledge.
CREATE TABLE IF NOT EXISTS investigation_feedback (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'feedback audit id',
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  result_id CHAR(36) NOT NULL COMMENT 'immutable reviewed result',
  result_version BIGINT UNSIGNED NOT NULL COMMENT 'reviewed result revision',
  actor_id INT UNSIGNED NOT NULL COMMENT 'authenticated human author',
  idempotency_key VARBINARY(255) NOT NULL COMMENT 'client retry identity scoped to investigation and author',
  payload_hash CHAR(64) NOT NULL COMMENT 'complete command identity',
  accepted_version BIGINT UNSIGNED NOT NULL COMMENT 'investigation revision after write',
  command_json JSON NOT NULL COMMENT 'redacted human command with immutable result binding',
  verification_json JSON NULL COMMENT 'server-attributed human confirmation separate from machine output',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'server audit time',
  UNIQUE KEY uq_investigation_feedback_key (investigation_id, actor_id, idempotency_key),
  UNIQUE KEY uq_investigation_feedback_version (investigation_id, accepted_version),
  CONSTRAINT fk_feedback_investigation FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_feedback_result FOREIGN KEY (result_id) REFERENCES investigation_results(id) ON DELETE RESTRICT,
  CONSTRAINT fk_feedback_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Append-only human feedback and closure audit';
