CREATE TABLE IF NOT EXISTS agent_evidence (
  owner_user_id INT UNSIGNED NOT NULL COMMENT 'Authenticated evidence owner',
  id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Canonical evidence SHA256',
  resource_type ENUM('instance','server','network_device') NOT NULL COMMENT 'Resource category',
  resource_id BIGINT UNSIGNED NOT NULL COMMENT 'Resource identifier',
  correlation_id VARCHAR(128) NOT NULL COMMENT 'Diagnostic correlation identifier',
  evidence_json JSON NOT NULL COMMENT 'Versioned validated evidence payload',
  observed_at DATETIME(3) NOT NULL COMMENT 'Observation timestamp in UTC',
  valid_until DATETIME(3) NOT NULL COMMENT 'Evidence validity deadline in UTC',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Evidence persistence timestamp',
  PRIMARY KEY (owner_user_id, id),
  KEY idx_agent_evidence_resource_time (owner_user_id, resource_type, resource_id, observed_at),
  KEY idx_agent_evidence_correlation (owner_user_id, correlation_id, observed_at),
  CONSTRAINT fk_agent_evidence_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Authorized resource evidence history';
