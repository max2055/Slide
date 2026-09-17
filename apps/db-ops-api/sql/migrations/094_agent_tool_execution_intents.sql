CREATE TABLE IF NOT EXISTS agent_tool_execution_intents (
  id CHAR(36) NOT NULL PRIMARY KEY,
  approval_id BIGINT UNSIGNED NOT NULL,
  request_id VARCHAR(255) NOT NULL,
  state ENUM('dispatching', 'released', 'finished') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tool_execution_approval (approval_id),
  CONSTRAINT fk_tool_execution_approval FOREIGN KEY (approval_id)
    REFERENCES agent_tool_approvals(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
