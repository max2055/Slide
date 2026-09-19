CREATE TABLE metric_v2_rollout (
  series_hash CHAR(64) NOT NULL PRIMARY KEY COMMENT 'semantic series identity',
  source VARCHAR(128) NOT NULL COMMENT 'sole formal publisher',
  generation INT UNSIGNED NOT NULL COMMENT 'monotonic switch generation',
  read_mode VARCHAR(16) NOT NULL COMMENT 'legacy or v2',
  package_pin JSON NOT NULL COMMENT 'immutable package pin',
  published_revision INT UNSIGNED NOT NULL COMMENT 'published revision',
  applied_revision INT UNSIGNED NULL COMMENT 'confirmed revision',
  latest_payload JSON NULL COMMENT 'formal value only; shadow excluded',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at'
) ENGINE=InnoDB COMMENT='Opt-in formal publisher fencing';

CREATE TABLE metric_v2_publications (
  observation_id VARCHAR(128) NOT NULL PRIMARY KEY COMMENT 'formal normalized observation',
  series_hash CHAR(64) NOT NULL COMMENT 'semantic series identity',
  generation INT UNSIGNED NOT NULL COMMENT 'accepted source generation',
  observed_at DATETIME(3) NOT NULL COMMENT 'original observation time',
  INDEX idx_metric_publication_window (series_hash, observed_at)
) ENGINE=InnoDB COMMENT='Formal history excludes shadow evidence';

CREATE TABLE metric_v2_alert_state (
  identity_hash CHAR(64) NOT NULL PRIMARY KEY COMMENT 'series and rule version identity',
  last_window_ms BIGINT NOT NULL COMMENT 'monotonic evaluated window',
  state VARCHAR(16) NOT NULL COMMENT 'firing or healthy',
  alert_id BIGINT NULL COMMENT 'existing alerts record'
) ENGINE=InnoDB COMMENT='Serialized metric alert state';

CREATE TABLE metric_v2_alert_transitions (
  transition_key CHAR(64) NOT NULL PRIMARY KEY COMMENT 'identity window target state',
  identity_hash CHAR(64) NOT NULL COMMENT 'alert identity',
  window_ms BIGINT NOT NULL COMMENT 'fixed evaluation window end',
  state VARCHAR(16) NOT NULL COMMENT 'target state',
  evidence JSON NOT NULL COMMENT 'source generation and revisions',
  INDEX idx_metric_transition_identity (identity_hash, window_ms)
) ENGINE=InnoDB COMMENT='Metric alert transition replay ledger';
