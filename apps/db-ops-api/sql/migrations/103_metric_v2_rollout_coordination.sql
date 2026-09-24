CREATE TABLE metric_v2_rollout_resources (
  resource_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY COMMENT 'Server-owned resource identity',
  resource_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Resource type',
  resource_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Resource identifier',
  phase VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'shadow, cutover_pending, v2, or legacy',
  revision INT UNSIGNED NOT NULL COMMENT 'Current policy/source revision',
  generation INT UNSIGNED NOT NULL COMMENT 'Uniform source generation',
  gate_json JSON NULL COMMENT 'Accepted shadow comparison gate; contains no credentials',
  actor_id BIGINT UNSIGNED NOT NULL COMMENT 'Last operator',
  request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Auditable request identity',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'Last coordination state change',
  UNIQUE KEY uq_metric_rollout_resource (resource_type, resource_id)
) ENGINE=InnoDB COMMENT='Resource-level Metrics V2 rollout coordination state';

CREATE TABLE metric_v2_rollout_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'Audit sequence',
  resource_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Server-owned resource identity',
  action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Monotonic rollout transition',
  revision INT UNSIGNED NOT NULL COMMENT 'Policy/source revision at transition',
  generation INT UNSIGNED NOT NULL COMMENT 'Source generation at transition',
  actor_id BIGINT UNSIGNED NOT NULL COMMENT 'Operator identity',
  request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Auditable request identity',
  evidence JSON NOT NULL COMMENT 'Sanitized transition evidence and gates',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Transition commit time',
  KEY idx_metric_rollout_event_resource (resource_key, id)
) ENGINE=InnoDB COMMENT='Immutable Metrics V2 rollout and rollback audit trail';
