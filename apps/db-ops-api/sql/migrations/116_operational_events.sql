-- Internal T07-B only. Production producers remain disconnected.
-- Additive rollback: stop admission and retain events/receipts; no destructive down.
CREATE TABLE IF NOT EXISTS operational_events (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'Server allocated event ID',
  source VARBINARY(128) NOT NULL COMMENT 'Bound trusted source',
  source_event_id VARBINARY(512) NOT NULL COMMENT 'Producer delivery identity, exact bytes',
  command_hash CHAR(64) NOT NULL COMMENT 'Canonical delivery envelope hash excluding server fields',
  envelope JSON NOT NULL COMMENT 'Versioned event envelope without actor or policy input',
  occurred_at DATETIME(3) NOT NULL COMMENT 'Producer occurrence UTC',
  received_at DATETIME(3) NOT NULL COMMENT 'Database receipt UTC',
  fingerprint CHAR(64) NOT NULL COMMENT 'Policy scope subject error callsite release fingerprint',
  trigger_key CHAR(64) NOT NULL COMMENT 'Durable aggregate identity',
  disposition ENUM('accepted','linked','suppressed') NOT NULL DEFAULT 'suppressed' COMMENT 'Persisted admission outcome',
  suppression_reason VARCHAR(64) NULL COMMENT 'Deterministic reason independent of payload',
  investigation_id CHAR(36) NULL COMMENT 'Associated investigation if any',
  request_id CHAR(36) NULL COMMENT 'Initial accepted request if any',
  previous_investigation_id CHAR(36) NULL COMMENT 'Closed predecessor reference without reopening',
  UNIQUE KEY uq_operational_delivery (source, source_event_id),
  KEY idx_operational_fingerprint (fingerprint, received_at),
  KEY idx_operational_source (source, received_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Persistent events and queryable suppressions';

CREATE TABLE IF NOT EXISTS investigation_trigger_keys (
  trigger_key CHAR(64) NOT NULL PRIMARY KEY COMMENT 'Policy version scope fingerprint key without time bucket',
  policy_id VARBINARY(128) NOT NULL COMMENT 'Trusted policy ID',
  policy_version BIGINT UNSIGNED NOT NULL COMMENT 'Immutable policy version',
  scope_hash CHAR(64) NOT NULL COMMENT 'Actor domain and all required resource boundary hash',
  fingerprint CHAR(64) NOT NULL COMMENT 'Stable problem fingerprint',
  policy_hash CHAR(64) NOT NULL COMMENT 'Reject policy mutations without version change',
  active_investigation_id CHAR(36) NULL COMMENT 'Last investigation, lifecycle checked under lock',
  first_request_id CHAR(36) NULL COMMENT 'Initial request reused by linked events',
  window_started_at DATETIME(3) NOT NULL COMMENT 'Database UTC threshold window start',
  window_count BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Unique eligible events in current window',
  event_count BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'All unique events, no delivery retry increment',
  last_seen DATETIME(3) NOT NULL COMMENT 'Last database receive UTC',
  KEY idx_trigger_policy (policy_id, policy_version, scope_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Cross-window durable problem aggregation locks';

CREATE TABLE IF NOT EXISTS investigation_trigger_cooldowns (
  domain_key VARBINARY(128) NOT NULL COMMENT 'Same shared budget security domain',
  resource_key VARBINARY(128) NOT NULL COMMENT 'All resource or platform component identity',
  cooldown_until DATETIME(3) NOT NULL COMMENT 'Database UTC earliest next initial admission',
  PRIMARY KEY(domain_key, resource_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Cross-fingerprint and policy resource cooldown';

CREATE TABLE IF NOT EXISTS investigation_event_links (
  investigation_id CHAR(36) NOT NULL COMMENT 'Associated investigation',
  event_id CHAR(36) NOT NULL COMMENT 'Unique delivered event',
  linked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Database UTC association time',
  PRIMARY KEY(investigation_id, event_id),
  UNIQUE KEY uq_investigation_event (event_id),
  CONSTRAINT fk_trigger_event FOREIGN KEY(event_id) REFERENCES operational_events(id) ON DELETE RESTRICT,
  CONSTRAINT fk_trigger_investigation FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Persistent deduplicated event investigation associations';
