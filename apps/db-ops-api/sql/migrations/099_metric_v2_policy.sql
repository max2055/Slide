-- Additive MAX-69 configuration plane; legacy collection remains unchanged.
CREATE TABLE metric_v2_policy_lock (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'Singleton configuration publication lock'
) ENGINE=InnoDB COMMENT='Serializes group membership and configuration publications';
INSERT INTO metric_v2_policy_lock (id) VALUES (1);

CREATE TABLE metric_v2_policy_groups (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY COMMENT 'Single primary group identity',
  payload JSON NOT NULL COMMENT 'Validated group revision and overrides'
) ENGINE=InnoDB COMMENT='Metric collection primary group policies';

CREATE TABLE metric_v2_policy_bindings (
  resource_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY COMMENT 'Resource type and numeric ID',
  group_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'Exactly one primary group or null',
  payload JSON NOT NULL COMMENT 'Immutable published plan snapshot, binding and application state',
  capabilities JSON NOT NULL COMMENT 'Trusted capability evidence for the pinned package, not collection failures',
  KEY idx_metric_v2_policy_group (group_id),
  CONSTRAINT fk_metric_v2_policy_group FOREIGN KEY (group_id) REFERENCES metric_v2_policy_groups(id)
) ENGINE=InnoDB COMMENT='Persisted package pins and resource policy publications';

CREATE TABLE metric_v2_policy_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'Audit sequence',
  target VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Resource or group identity',
  payload JSON NOT NULL COMMENT 'Actor, request, action, revision and time; no credentials',
  KEY idx_metric_v2_policy_audit_target (target, id)
) ENGINE=InnoDB COMMENT='Atomic policy publication audit records';
