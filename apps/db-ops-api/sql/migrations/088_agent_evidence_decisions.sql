CREATE TABLE IF NOT EXISTS agent_evidence_decisions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Decision UUID',
  owner_user_id INT UNSIGNED NOT NULL COMMENT 'Authenticated decision owner',
  resource_type ENUM('instance','server','network_device') NOT NULL COMMENT 'Authorized resource category',
  resource_id BIGINT UNSIGNED NOT NULL COMMENT 'Authorized resource identifier',
  record_json JSON NOT NULL COMMENT 'Versioned decision and immutable evidence references',
  created_at DATETIME(3) NOT NULL COMMENT 'Decision creation time in UTC',
  PRIMARY KEY (id),
  KEY idx_evidence_decision_resource (owner_user_id, resource_type, resource_id, created_at),
  CONSTRAINT fk_evidence_decision_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Actor-owned evidence-linked decisions';
