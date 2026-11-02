CREATE TABLE metric_history_study_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'Append-only audit sequence',
  resource_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Authorized resource type and numeric ID',
  action VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Isolated replay or cleanup preview',
  created_at DATETIME(3) NOT NULL COMMENT 'UTC audit time',
  payload JSON NOT NULL COMMENT 'Actor, evidence window, fixed rule hash or capacity assumptions; no credentials',
  KEY idx_history_study_resource (resource_key, id)
) ENGINE=InnoDB COMMENT='Resource-scoped isolated historical replay and cleanup preview audit';
