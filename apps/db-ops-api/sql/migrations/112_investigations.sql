-- T02-B persistence only. Loaded automatically by the ordered SQL runner.
-- Session ownership remains the existing numeric Chat user; no Run state copy.
CREATE TABLE IF NOT EXISTS investigations (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'id',
  title VARCHAR(200) NOT NULL COMMENT 'title',
  goal TEXT NOT NULL COMMENT 'goal',
  profile_id VARCHAR(128) NOT NULL COMMENT 'profile id',
  profile_version BIGINT UNSIGNED NOT NULL COMMENT 'profile version',
  session_id VARCHAR(100) NOT NULL COMMENT 'session id',
  owner_kind ENUM('user','service') NOT NULL COMMENT 'owner kind',
  owner_id INT UNSIGNED NOT NULL COMMENT 'owner id',
  scope_version CHAR(64) NOT NULL COMMENT 'scope version',
  lifecycle ENUM('open','waiting','closed','archived') NOT NULL DEFAULT 'open' COMMENT 'lifecycle',
  problem_status ENUM('unconfirmed','in_progress','resolved','not_applicable') NOT NULL DEFAULT 'unconfirmed' COMMENT 'problem status',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'version',
  active_request_id CHAR(36) NULL COMMENT 'active request id',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'updated at',
  UNIQUE KEY uq_investigation_session (session_id),
  KEY idx_investigation_owner_list (owner_kind, owner_id, lifecycle, updated_at, id),
  CONSTRAINT fk_investigation_session FOREIGN KEY(session_id) REFERENCES chat_sessions(session_id) ON DELETE RESTRICT,
  CONSTRAINT fk_investigation_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Investigation persistence and immutable request authority';

CREATE TABLE IF NOT EXISTS investigation_resources (
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  resource_type ENUM('instance','server','network_device') NOT NULL COMMENT 'resource type',
  resource_id INT UNSIGNED NOT NULL COMMENT 'resource id',
  role ENUM('primary','related') NOT NULL DEFAULT 'related' COMMENT 'role',
  PRIMARY KEY(investigation_id, resource_type, resource_id),
  CONSTRAINT fk_investigation_resource FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Investigation persistence and immutable request authority';

CREATE TABLE IF NOT EXISTS investigation_members (
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  user_id INT UNSIGNED NOT NULL COMMENT 'user id',
  role ENUM('viewer','operator') NOT NULL COMMENT 'role',
  granted_by INT UNSIGNED NOT NULL COMMENT 'granted by',
  expires_at DATETIME NULL COMMENT 'expires at',
  PRIMARY KEY(investigation_id, user_id),
  CONSTRAINT fk_investigation_member FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_investigation_member_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_investigation_member_grantor FOREIGN KEY(granted_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Investigation persistence and immutable request authority';

CREATE TABLE IF NOT EXISTS investigation_requests (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'id',
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  actor_kind ENUM('user','service') NOT NULL COMMENT 'actor kind',
  actor_id INT UNSIGNED NOT NULL COMMENT 'actor id',
  idempotency_key VARBINARY(255) NOT NULL COMMENT 'idempotency key',
  request_hash CHAR(64) NOT NULL COMMENT 'request hash',
  request_snapshot JSON NOT NULL COMMENT 'request snapshot',
  message_id VARCHAR(100) NULL COMMENT 'message id',
  job_id CHAR(36) NOT NULL COMMENT 'job id',
  accepted_version BIGINT UNSIGNED NOT NULL COMMENT 'accepted version',
  cancel_requested_at DATETIME NULL COMMENT 'cancel requested at',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  UNIQUE KEY uq_investigation_request_key(actor_kind, actor_id, idempotency_key),
  UNIQUE KEY uq_investigation_request_job(job_id),
  CONSTRAINT fk_investigation_request FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_investigation_request_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Investigation persistence and immutable request authority';

CREATE TABLE IF NOT EXISTS investigation_admission_keys (
  actor_kind ENUM('user','service') NOT NULL COMMENT 'actor kind',
  actor_id INT UNSIGNED NOT NULL COMMENT 'actor id',
  idempotency_key VARBINARY(255) NOT NULL COMMENT 'idempotency key',
  request_id CHAR(36) NULL COMMENT 'request id',
  PRIMARY KEY(actor_kind, actor_id, idempotency_key),
  CONSTRAINT fk_investigation_key_request FOREIGN KEY(request_id) REFERENCES investigation_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_investigation_key_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Investigation persistence and immutable request authority';
