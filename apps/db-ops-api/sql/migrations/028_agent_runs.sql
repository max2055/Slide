CREATE TABLE IF NOT EXISTS agent_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  actor_id INT UNSIGNED NOT NULL,
  session_id VARCHAR(100) NOT NULL,
  message_id VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  state ENUM('running','completed','partial','failed','cancelled','timed_out') NOT NULL,
  result_json JSON NULL,
  error_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  UNIQUE KEY uq_agent_runs_actor_session_idempotency (actor_id, session_id, idempotency_key),
  KEY idx_agent_runs_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
