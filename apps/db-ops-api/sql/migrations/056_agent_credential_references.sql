CREATE TABLE IF NOT EXISTS agent_credential_references (
  ref_id CHAR(36) NOT NULL,
  owner_id INT UNSIGNED NOT NULL,
  tool_name VARCHAR(128) NOT NULL,
  secret_encrypted TEXT NOT NULL,
  status ENUM('active','consumed','expired','revoked') NOT NULL DEFAULT 'active',
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ref_id),
  KEY idx_agent_credential_active (owner_id, tool_name, status, expires_at),
  CONSTRAINT fk_agent_credential_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
