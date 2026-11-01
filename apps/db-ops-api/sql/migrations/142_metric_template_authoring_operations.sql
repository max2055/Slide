-- Actor-scoped retries are committed atomically with template edits.
CREATE TABLE IF NOT EXISTS metric_template_authoring_operations (
  actor_id BIGINT UNSIGNED NOT NULL COMMENT 'Authenticated principal owning this operation',
  operation_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Client retry identity scoped to principal',
  intent_hash CHAR(64) CHARACTER SET ascii NOT NULL COMMENT 'SHA256 of action target and canonical request',
  result JSON NULL COMMENT 'Committed result replayed only after live authorization',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Operation commit timestamp',
  PRIMARY KEY (actor_id, operation_key)
) ENGINE=InnoDB COMMENT='Atomic native template authoring retry journal';
