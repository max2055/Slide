CREATE TABLE IF NOT EXISTS agent_tool_idempotency (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_id INT UNSIGNED NOT NULL,
  session_id VARCHAR(512) NOT NULL,
  session_hash CHAR(64) NOT NULL,
  tool_name VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  arguments_hash CHAR(64) NOT NULL,
  state ENUM('running','completed','failed') NOT NULL,
  result_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_agent_tool_idempotency (actor_id, session_hash, tool_name, idempotency_key),
  KEY idx_agent_tool_idempotency_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
