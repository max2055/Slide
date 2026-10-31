-- MAX-238: client operation-key journal for configuration publication.
-- Additive and inert until a caller sends `operation_key`. The published binding
-- remains the only policy/configuration fact; this table records which client
-- intent produced which revision so a replay returns the stored publication
-- without a second revision, publication or audit row.
CREATE TABLE IF NOT EXISTS metric_policy_apply_operations (
  operation_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY COMMENT 'Client intent key, byte-exact',
  resource_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Resource type and numeric ID',
  actor_id BIGINT UNSIGNED NOT NULL COMMENT 'Actor that committed the publication',
  target_revision BIGINT UNSIGNED NOT NULL COMMENT 'Revision this operation published',
  configuration_digest CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'sha256 of the canonical configuration fingerprint',
  result JSON NOT NULL COMMENT 'Published result returned on replay; never credentials',
  committed_at VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Trusted policy clock at publication',
  KEY idx_metric_policy_apply_operation_resource (resource_key)
) ENGINE=InnoDB COMMENT='Client operation keys binding resource, target revision and configuration digest';
