CREATE TABLE metric_semantic_baselines (
  resource_key VARCHAR(160) NOT NULL COMMENT 'Resource identity',
  reference_id VARCHAR(128) NOT NULL COMMENT 'Policy metric reference',
  revision BIGINT UNSIGNED NOT NULL COMMENT 'Published configuration revision',
  payload JSON NOT NULL COMMENT 'Metric version unit and exact sample statistics',
  computed_at DATETIME(3) NOT NULL COMMENT 'Statistics computation time',
  PRIMARY KEY(resource_key, reference_id)
) ENGINE=InnoDB COMMENT='Accepted semantic metric baseline cache';
