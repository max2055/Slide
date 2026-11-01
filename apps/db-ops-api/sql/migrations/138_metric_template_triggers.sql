-- MAX239: immutable rule bodies and per-binding publication snapshots.
-- Existing alerts/events/workflow_jobs remain the only event and notification writers.
CREATE TABLE IF NOT EXISTS metric_trigger_rule_versions (
  rule_id VARBINARY(128) NOT NULL COMMENT 'Stable rule identity',
  version INT UNSIGNED NOT NULL COMMENT 'Append-only rule version',
  template_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL COMMENT 'Owning template',
  payload JSON NOT NULL COMMENT 'Strict restricted AST and canonical content hash',
  PRIMARY KEY (rule_id, version),
  KEY template_rules (template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Published executable template rule bodies';

CREATE TABLE IF NOT EXISTS metric_trigger_snapshots (
  resource_key VARBINARY(255) NOT NULL COMMENT 'Exact resource type and id',
  config_revision BIGINT UNSIGNED NOT NULL COMMENT 'Binding target revision',
  snapshot_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Compiler hash',
  payload JSON NOT NULL COMMENT 'Immutable compiler snapshot, parameters and fixed template pins',
  PRIMARY KEY (resource_key, config_revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Trigger snapshots committed atomically with template bindings';
