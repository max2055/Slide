CREATE TABLE metric_bulk_jobs (
  id CHAR(36) NOT NULL COMMENT 'Immutable bulk configuration job identifier',
  owner_id INT UNSIGNED NOT NULL COMMENT 'Authenticated initiating user; grants are reloaded for execution',
  idempotency_key VARCHAR(80) COLLATE utf8mb4_bin NOT NULL COMMENT 'User scoped submission key',
  state VARCHAR(20) NOT NULL COMMENT 'Draft, queued, running, completed or cancelled',
  payload JSON NOT NULL COMMENT 'Bounded preview, candidate configuration and per-object results; no credentials',
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Monotonic cancellation fence independent of worker result writes',
  expires_at DATETIME(3) NOT NULL COMMENT 'Latest time at which a preview may be confirmed',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Queue order and history time',
  PRIMARY KEY(id),
  UNIQUE KEY uq_metric_bulk_owner_key(owner_id,idempotency_key),
  KEY idx_metric_bulk_pending(state,created_at),
  KEY idx_metric_bulk_owner(owner_id,created_at)
) ENGINE=InnoDB COMMENT='Recoverable configuration batch queue; not a collection scheduler';
