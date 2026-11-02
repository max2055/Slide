-- Immutable receipts on the existing investigation owner, not a second task state.
CREATE TABLE IF NOT EXISTS investigation_workflow_receipts (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'immutable receipt id',
  investigation_id CHAR(36) NOT NULL COMMENT 'canonical investigation owner',
  actor_id INT UNSIGNED NOT NULL COMMENT 'authenticated human actor',
  kind VARCHAR(16) NOT NULL COMMENT 'scope or retest receipt',
  idempotency_key VARBINARY(255) NOT NULL COMMENT 'original client command key',
  command_hash CHAR(64) NOT NULL COMMENT 'complete original command identity',
  accepted_version BIGINT UNSIGNED NOT NULL COMMENT 'investigation revision after confirmation',
  payload JSON NOT NULL COMMENT 'immutable sourced scope or observed retest receipt',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'server acceptance time',
  UNIQUE KEY uq_investigation_workflow_key(investigation_id,actor_id,kind,idempotency_key),
  UNIQUE KEY uq_investigation_workflow_version(investigation_id,accepted_version),
  CONSTRAINT fk_workflow_receipt_investigation FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_workflow_receipt_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Original investigation scope and no-action retest audit';

-- Retain historical read ACLs without widening the current tool scope.
ALTER TABLE investigations ADD COLUMN scope_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'confirmed scope revisions requiring historical ACLs above zero';
CREATE TABLE IF NOT EXISTS investigation_scope_resources (
  investigation_id CHAR(36) NOT NULL COMMENT 'original investigation owner',
  resource_type VARCHAR(32) NOT NULL COMMENT 'historical resource kind',
  resource_id INT UNSIGNED NOT NULL COMMENT 'historical resource identity',
  PRIMARY KEY(investigation_id,resource_type,resource_id),
  CONSTRAINT fk_scope_resource_investigation FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Retained historical read ACLs distinct from tool scope';
