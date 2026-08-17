CREATE TABLE IF NOT EXISTS agent_security_policies (
  agent_id VARCHAR(64) NOT NULL,
  tool_allowlist JSON NULL,
  skill_allowlist JSON NULL,
  allowed_effects JSON NOT NULL,
  resource_scope JSON NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (agent_id),
  CONSTRAINT fk_agent_security_policy_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_security_policy_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id VARCHAR(64) NOT NULL,
  version INT UNSIGNED NOT NULL,
  policy_json JSON NOT NULL,
  change_note VARCHAR(500) NOT NULL,
  changed_by INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_security_policy_history_version (agent_id, version),
  KEY idx_agent_security_policy_history_actor (changed_by, created_at),
  CONSTRAINT fk_agent_security_policy_history_actor FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO agent_security_policies
  (agent_id, tool_allowlist, skill_allowlist, allowed_effects, resource_scope, version)
VALUES
  ('slide-db-ops', NULL, NULL, JSON_ARRAY('read', 'write', 'execute', 'secret', 'delegate'),
   JSON_OBJECT('instanceIds', NULL, 'serverIds', NULL), 1);

ALTER TABLE agent_tool_audit
  ADD COLUMN agent_id VARCHAR(64) NOT NULL DEFAULT 'slide-db-ops' AFTER actor_id,
  ADD KEY idx_agent_tool_audit_agent_created (agent_id, created_at);
