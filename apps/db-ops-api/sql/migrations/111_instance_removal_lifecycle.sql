-- Additive tombstone: do not fire instance FKs (notably Cron ON DELETE SET NULL).
ALTER TABLE database_instances
  ADD COLUMN lifecycle_state ENUM('available','deleting','deleted') NOT NULL DEFAULT 'available' COMMENT 'Access lifecycle; independent of connection health',
  ADD COLUMN removal_requested_at DATETIME(6) NULL COMMENT 'Durable deletion intent timestamp',
  ADD COLUMN removed_at DATETIME(6) NULL COMMENT 'Cleanup completion timestamp',
  ADD COLUMN removal_reasons JSON NULL COMMENT 'Retryable cleanup step codes; never remote error text or credentials',
  ADD INDEX idx_instance_lifecycle (lifecycle_state);
