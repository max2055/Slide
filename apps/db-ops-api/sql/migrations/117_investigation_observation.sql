-- Additive T05 storage. No rewrite of Chat, canonical facts or Run receipts.
CREATE TABLE IF NOT EXISTS investigation_stream_heads (
  investigation_id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'investigation id',
  sequence BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'last committed sequence',
  retained_after BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'expired cursor lower bound',
  CONSTRAINT fk_stream_head_investigation FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Durable investigation cursor and retention watermark';
CREATE TABLE IF NOT EXISTS investigation_stream_events (
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  sequence BIGINT UNSIGNED NOT NULL COMMENT 'per investigation committed sequence',
  source_key VARBINARY(255) NOT NULL COMMENT 'stable source identity and payload revision',
  event_json JSON NOT NULL COMMENT 'validated redacted event envelope',
  occurred_at DATETIME(3) NOT NULL COMMENT 'source occurrence time',
  PRIMARY KEY (investigation_id, sequence),
  UNIQUE KEY uq_investigation_stream_source (investigation_id, source_key),
  KEY idx_investigation_stream_retention (occurred_at),
  CONSTRAINT fk_stream_event_investigation FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Persistent replay independent of process and WebSocket lifetime';
CREATE TABLE IF NOT EXISTS investigation_observed_sources (
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  source_key VARBINARY(255) NOT NULL COMMENT 'source identity',
  payload_hash CHAR(64) NOT NULL COMMENT 'last captured source hash',
  PRIMARY KEY (investigation_id, source_key),
  CONSTRAINT fk_observed_source_investigation FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Capture deduplication survives event retention';
CREATE TABLE IF NOT EXISTS investigation_evidence (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'evidence id',
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  request_id CHAR(36) NOT NULL COMMENT 'original request id',
  run_id VARCHAR(100) NOT NULL COMMENT 'original Run id',
  source_key VARBINARY(255) NOT NULL COMMENT 'server-owned evidence idempotency key',
  payload_hash CHAR(64) NOT NULL COMMENT 'immutable complete command hash',
  content_hash CHAR(64) NOT NULL COMMENT 'redacted snapshot hash',
  metadata_json JSON NOT NULL COMMENT 'source summary observation window collection time resources',
  raw_json JSON NULL COMMENT 'redacted sensitive snapshot only within retention',
  expires_at DATETIME(3) NOT NULL COMMENT 'snapshot expiry',
  expired_at DATETIME(3) NULL COMMENT 'tombstone time',
  UNIQUE KEY uq_investigation_evidence_source (investigation_id, source_key),
  KEY idx_investigation_evidence_expiry (expires_at, id),
  CONSTRAINT fk_evidence_investigation FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_evidence_request FOREIGN KEY (request_id) REFERENCES investigation_requests(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Evidence bindings, redacted snapshots and expiry tombstones';
CREATE TABLE IF NOT EXISTS investigation_results (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'result id',
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  request_id CHAR(36) NOT NULL COMMENT 'original request id',
  run_id VARCHAR(100) NOT NULL COMMENT 'original Run id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'per investigation result revision',
  source_key VARBINARY(255) NOT NULL COMMENT 'server-owned completion key',
  payload_hash CHAR(64) NOT NULL COMMENT 'immutable result command hash',
  result_json JSON NOT NULL COMMENT 'schemaVersion 2 result and provenance',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'persistence time',
  UNIQUE KEY uq_investigation_result_version (investigation_id, version),
  UNIQUE KEY uq_investigation_result_source (investigation_id, source_key),
  CONSTRAINT fk_result_investigation FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_result_request FOREIGN KEY (request_id) REFERENCES investigation_requests(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Immutable atomic investigation result versions';
