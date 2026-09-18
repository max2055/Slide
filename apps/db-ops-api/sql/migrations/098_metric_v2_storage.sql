CREATE TABLE metric_v2_observations (
  id VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'MAX-64 sha256 observation identity',
  series_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'SHA256 of canonical series identity',
  stage ENUM('raw','normalized') NOT NULL COMMENT 'Persistence boundary',
  observed_at DATETIME(3) NOT NULL COMMENT 'Source observation time in UTC',
  stored_at DATETIME(3) NOT NULL COMMENT 'First persistence time in UTC',
  valid_value BOOLEAN NOT NULL COMMENT 'Non-null good or partial observation',
  payload JSON NULL COMMENT 'Contract including exact integer strings and provenance; null after raw expiry',
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Immutable retry payload digest excluding stored_at',
  evidence_expires_at DATETIME(3) NULL COMMENT 'Raw evidence expiry; normalized has no evidence TTL',
  PRIMARY KEY (id),
  KEY idx_metric_v2_latest (series_hash, stage, valid_value, observed_at, id),
  KEY idx_metric_v2_range (series_hash, stage, observed_at, id),
  KEY idx_metric_v2_retention (stage, stored_at),
  KEY idx_metric_v2_evidence (stage, evidence_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='V2 observations; Canonical and Extension share one contract';

CREATE TABLE metric_v2_attempts (
  id VARCHAR(256) NOT NULL COMMENT 'Collection attempt identity',
  payload JSON NOT NULL COMMENT 'Attempt state, source, revision and observation references',
  stored_at DATETIME(3) NOT NULL COMMENT 'First persistence time for retention',
  PRIMARY KEY (id),
  KEY idx_metric_v2_attempt_retention (stored_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Attempts never update effective observations';

CREATE TABLE metric_v2_inventory (
  resource_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Hash of resource type and id',
  payload JSON NOT NULL COMMENT 'Resource attributes, each with source and observed time',
  PRIMARY KEY (resource_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Inventory is separate from numeric timeseries';
