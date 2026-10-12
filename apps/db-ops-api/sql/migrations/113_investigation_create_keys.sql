-- Reserve the original POST command before allocating a Session.
CREATE TABLE IF NOT EXISTS investigation_create_keys (
  actor_kind ENUM('user','service') NOT NULL COMMENT 'actor kind',
  actor_id INT UNSIGNED NOT NULL COMMENT 'actor id',
  idempotency_key VARBINARY(255) NOT NULL COMMENT 'client command key',
  command_hash CHAR(64) NOT NULL COMMENT 'canonical command hash',
  command_snapshot JSON NOT NULL COMMENT 'immutable original command and subject window',
  investigation_id CHAR(36) NULL COMMENT 'transactional investigation binding',
  PRIMARY KEY(actor_kind, actor_id, idempotency_key),
  UNIQUE KEY uq_investigation_create_binding (investigation_id),
  CONSTRAINT fk_investigation_create_binding FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE CASCADE,
  CONSTRAINT fk_investigation_create_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Atomic investigation creation command recovery';
