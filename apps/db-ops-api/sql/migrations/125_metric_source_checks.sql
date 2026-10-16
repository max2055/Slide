CREATE TABLE metric_source_checks (
  resource_key VARCHAR(160) NOT NULL COMMENT 'Resource identity',
  revision BIGINT UNSIGNED NOT NULL COMMENT 'Candidate configuration revision',
  payload JSON NOT NULL COMMENT 'Actual captured source replay comparisons and semantic differences',
  checked_at DATETIME(3) NOT NULL COMMENT 'Actual measurement verification time',
  PRIMARY KEY(resource_key, revision)
) ENGINE=InnoDB COMMENT='Measured source migration verification evidence';
