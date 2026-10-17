-- P10 formal additive installation of the reviewed P01 schema. No external CASCADE FKs.
-- External sources are checked live; retained evidence survives user/resource deletion.
-- Additive, reentrant for this exact schema. No legacy UPDATE/ALTER or backfill.
-- External investigation/resource/user/approval/metrics identities remain owned
-- by their current domains. Services validate them live, retaining tombstones.

CREATE TABLE IF NOT EXISTS trusted_cases (
  id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY COMMENT 'id',
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'schema version',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'version',
  source_investigation_id CHAR(36) NOT NULL COMMENT 'source investigation id',
  source_result_version BIGINT UNSIGNED NOT NULL COMMENT 'source result version',
  author_kind ENUM('user','service') NOT NULL COMMENT 'author kind',
  author_id INT UNSIGNED NOT NULL COMMENT 'author id',
  current_version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'current version',
  state ENUM('draft','pending_review','published','expired','withdrawn') NOT NULL DEFAULT 'draft' COMMENT 'state',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'updated at',
  KEY idx_case_source (source_investigation_id, source_result_version),
  KEY idx_case_page (state, updated_at, id),
  CHECK (schema_version=1 AND version>0 AND source_result_version>0 AND current_version>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

CREATE TABLE IF NOT EXISTS trusted_case_versions (
  case_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'case id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
  content JSON NOT NULL COMMENT 'content',
  source_snapshot JSON NOT NULL COMMENT 'source snapshot',
  applicability JSON NOT NULL COMMENT 'applicability',
  redaction_policy_version VARCHAR(128) NOT NULL COMMENT 'redaction policy version',
  valid_until DATETIME(3) NOT NULL COMMENT 'valid until',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  PRIMARY KEY(case_id,version),
  KEY idx_case_expiry (valid_until,case_id,version),
  CONSTRAINT fk_ops_case_version FOREIGN KEY(case_id) REFERENCES trusted_cases(id) ON DELETE RESTRICT,
  CHECK (version>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

-- Normalized complete source scope, including hidden/deleted resource refs.
-- P03 uses NOT EXISTS(unauthorized resource) BEFORE pagination/count/ranking.
CREATE TABLE IF NOT EXISTS trusted_case_resources (
  case_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'case id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  resource_type ENUM('instance','server','network_device') NOT NULL COMMENT 'resource type',
  resource_id INT UNSIGNED NOT NULL COMMENT 'resource id',
  PRIMARY KEY(case_id,version,resource_type,resource_id),
  KEY idx_case_resource (resource_type,resource_id,case_id,version),
  CONSTRAINT fk_ops_case_scope FOREIGN KEY(case_id,version) REFERENCES trusted_case_versions(case_id,version) ON DELETE RESTRICT,
  CHECK (resource_id>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

CREATE TABLE IF NOT EXISTS trusted_case_reviews (
  id CHAR(36) NOT NULL PRIMARY KEY COMMENT 'id',
  case_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'case id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
  author_id INT UNSIGNED NOT NULL COMMENT 'author id',
  reviewer_id INT UNSIGNED NOT NULL COMMENT 'reviewer id',
  decision ENUM('approved','rejected') NOT NULL COMMENT 'decision',
  note VARCHAR(2000) NOT NULL COMMENT 'note',
  reviewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'reviewed at',
  UNIQUE KEY uq_case_review (case_id,version),
  CONSTRAINT fk_ops_case_review FOREIGN KEY(case_id,version) REFERENCES trusted_case_versions(case_id,version) ON DELETE RESTRICT,
  CHECK (reviewer_id<>author_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

-- Portable bounded token index. No optional fulltext plugin or vector store.
-- Published/expiry/live ACL filters still apply to every index consumer.
CREATE TABLE IF NOT EXISTS trusted_case_search_tokens (
  token VARBINARY(192) NOT NULL COMMENT 'token',
  case_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'case id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  PRIMARY KEY(token,case_id,version),
  CONSTRAINT fk_ops_case_token FOREIGN KEY(case_id,version) REFERENCES trusted_case_versions(case_id,version) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

CREATE TABLE IF NOT EXISTS resource_relation_revisions (
  relation_id BIGINT UNSIGNED NOT NULL COMMENT 'relation id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'schema version',
  source_type ENUM('instance','server','network_device') NOT NULL COMMENT 'source type',
  source_id INT UNSIGNED NOT NULL COMMENT 'source id',
  target_type ENUM('instance','server','network_device') NOT NULL COMMENT 'target type',
  target_id INT UNSIGNED NOT NULL COMMENT 'target id',
  relation_type ENUM('runs_on','replicates_to','depends_on','connected_to','serves') NOT NULL COMMENT 'relation type',
  state ENUM('suggested','confirmed','expired','withdrawn','conflicted') NOT NULL DEFAULT 'suggested' COMMENT 'state',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
  provenance JSON NOT NULL COMMENT 'provenance',
  legacy_provenance VARCHAR(64) NULL COMMENT 'legacy provenance',
  observed_at DATETIME(3) NOT NULL COMMENT 'observed at',
  confirmed_by INT UNSIGNED NULL COMMENT 'confirmed by',
  confirmed_at DATETIME(3) NULL COMMENT 'confirmed at',
  valid_from DATETIME(3) NOT NULL COMMENT 'valid from',
  valid_until DATETIME(3) NULL COMMENT 'valid until',
  withdrawal_reason VARCHAR(1000) NULL COMMENT 'withdrawal reason',
  PRIMARY KEY(relation_id,version),
  KEY idx_relation_source (source_type,source_id,state,valid_until,relation_id,version),
  KEY idx_relation_target (target_type,target_id,state,valid_until,relation_id,version),
  CHECK (schema_version=1 AND version>0 AND source_id>0 AND target_id>0),
  CHECK (source_type<>target_type OR source_id<>target_id),
  CHECK (valid_until IS NULL OR valid_until>valid_from),
  CHECK (state<>'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

-- Intentionally separate from old metric_baselines. Source identity is an
-- opaque stable reference to the single formal metrics domain, never a FK
-- or a replacement measurement/source/binding store owned by operations.
CREATE TABLE IF NOT EXISTS behavior_baseline_versions (
  id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'schema version',
  resource_type ENUM('instance','server','network_device') NOT NULL COMMENT 'resource type',
  resource_id INT UNSIGNED NOT NULL COMMENT 'resource id',
  series_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'series hash',
  series_identity JSON NOT NULL COMMENT 'series identity',
  method_version VARCHAR(128) NOT NULL COMMENT 'method version',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
  state ENUM('not_qualified','qualified','invalidated') NOT NULL DEFAULT 'not_qualified' COMMENT 'state',
  reason VARCHAR(1000) NULL COMMENT 'reason',
  training_from DATETIME(3) NOT NULL COMMENT 'training from',
  training_until DATETIME(3) NOT NULL COMMENT 'training until',
  validation_from DATETIME(3) NOT NULL COMMENT 'validation from',
  validation_until DATETIME(3) NOT NULL COMMENT 'validation until',
  quality JSON NOT NULL COMMENT 'quality',
  reference_bands JSON NOT NULL COMMENT 'reference bands',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  PRIMARY KEY(id,version),
  KEY idx_baseline_series (series_hash,state,created_at,id,version),
  KEY idx_baseline_resource (resource_type,resource_id,state,id,version),
  CHECK (schema_version=1 AND version>0 AND resource_id>0),
  CHECK (training_until>training_from AND validation_from>=training_until AND validation_until>validation_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

CREATE TABLE IF NOT EXISTS attention_correlation_snapshots (
  id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'schema version',
  rule_version VARCHAR(128) NOT NULL COMMENT 'rule version',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
  observed_from DATETIME(3) NOT NULL COMMENT 'observed from',
  observed_until DATETIME(3) NOT NULL COMMENT 'observed until',
  severity VARCHAR(32) NOT NULL COMMENT 'severity',
  score_lower DECIMAL(9,4) NOT NULL COMMENT 'score lower',
  score_upper DECIMAL(9,4) NOT NULL COMMENT 'score upper',
  coverage DECIMAL(6,5) NOT NULL COMMENT 'coverage',
  partial BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'partial',
  snapshot JSON NOT NULL COMMENT 'snapshot',
  override_of_id VARCHAR(128) COLLATE utf8mb4_bin NULL COMMENT 'override of id',
  override_of_version BIGINT UNSIGNED NULL COMMENT 'override of version',
  created_by INT UNSIGNED NULL COMMENT 'created by',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  PRIMARY KEY(id,version),
  KEY idx_attention_rank (severity,score_lower,observed_from,id,version),
  CONSTRAINT fk_ops_attention_override FOREIGN KEY(override_of_id,override_of_version) REFERENCES attention_correlation_snapshots(id,version) ON DELETE RESTRICT,
  CHECK (schema_version=1 AND version>0 AND coverage>=0 AND coverage<=1),
  CHECK (score_lower>=0 AND score_upper>=score_lower AND score_upper<=100),
  CHECK (observed_until>=observed_from),
  CHECK ((override_of_id IS NULL)=(override_of_version IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

CREATE TABLE IF NOT EXISTS attention_snapshot_members (
  snapshot_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'snapshot id',
  snapshot_version BIGINT UNSIGNED NOT NULL COMMENT 'snapshot version',
  member_type ENUM('event','investigation','relation','baseline') NOT NULL COMMENT 'member type',
  member_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'member id',
  member_version BIGINT UNSIGNED NOT NULL COMMENT 'member version',
  PRIMARY KEY(snapshot_id,snapshot_version,member_type,member_id,member_version),
  KEY idx_attention_member (member_type,member_id,snapshot_id,snapshot_version),
  CONSTRAINT fk_ops_attention_member FOREIGN KEY(snapshot_id,snapshot_version) REFERENCES attention_correlation_snapshots(id,version) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

CREATE TABLE IF NOT EXISTS action_plans (
  id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY COMMENT 'id',
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'schema version',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'version',
  current_version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'current version',
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  author_kind ENUM('user','service') NOT NULL COMMENT 'author kind',
  author_id INT UNSIGNED NOT NULL COMMENT 'author id',
  requester_kind ENUM('user','service') NOT NULL COMMENT 'requester kind',
  requester_id INT UNSIGNED NOT NULL COMMENT 'requester id',
  target_type ENUM('instance','server','network_device') NOT NULL COMMENT 'target type',
  target_id INT UNSIGNED NOT NULL COMMENT 'target id',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'updated at',
  KEY idx_plan_investigation (investigation_id,updated_at,id),
  KEY idx_plan_target (target_type,target_id,updated_at,id),
  CHECK (schema_version=1 AND version>0 AND current_version>0 AND target_id>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

-- Immutable content, mutable lifecycle only. P06 owns compare-and-swap writes.
CREATE TABLE IF NOT EXISTS action_plan_versions (
  plan_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'plan id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  result_version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'result version',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
  content JSON NOT NULL COMMENT 'content',
  policy_version VARCHAR(128) NOT NULL COMMENT 'policy version',
  state ENUM('draft','pending_approval','approved','rejected','expired','superseded') NOT NULL DEFAULT 'draft' COMMENT 'state',
  valid_from DATETIME(3) NOT NULL COMMENT 'valid from',
  valid_until DATETIME(3) NOT NULL COMMENT 'valid until',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  PRIMARY KEY(plan_id,version),
  KEY idx_plan_expiry (state,valid_until,plan_id,version),
  CONSTRAINT fk_ops_plan_version FOREIGN KEY(plan_id) REFERENCES action_plans(id) ON DELETE RESTRICT,
  CHECK (version>0 AND result_version>0),
  CHECK (valid_until>valid_from AND valid_until<=DATE_ADD(valid_from,INTERVAL 30 MINUTE))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

-- One-to-one adapter onto existing agent_tool_approvals. No second approval engine.
-- External approval FK is deferred to P10 to avoid cascade/history semantics.
CREATE TABLE IF NOT EXISTS action_approval_bindings (
  approval_id BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'approval id',
  plan_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'plan id',
  plan_version BIGINT UNSIGNED NOT NULL COMMENT 'plan version',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
  policy_version VARCHAR(128) NOT NULL COMMENT 'policy version',
  author_id INT UNSIGNED NOT NULL COMMENT 'author id',
  requester_id INT UNSIGNED NOT NULL COMMENT 'requester id',
  reviewer_id INT UNSIGNED NOT NULL COMMENT 'reviewer id',
  approval_mode ENUM('once') NOT NULL DEFAULT 'once' COMMENT 'approval mode',
  expires_at DATETIME(3) NOT NULL COMMENT 'expires at',
  consumed_at DATETIME(3) NULL COMMENT 'consumed at',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  KEY idx_action_approval_plan (plan_id,plan_version),
  CONSTRAINT fk_ops_approval_version FOREIGN KEY(plan_id,plan_version) REFERENCES action_plan_versions(plan_id,version) ON DELETE RESTRICT,
  CHECK (reviewer_id<>author_id AND reviewer_id<>requester_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

CREATE TABLE IF NOT EXISTS action_executions (
  id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY COMMENT 'id',
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'schema version',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'version',
  plan_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'plan id',
  plan_version BIGINT UNSIGNED NOT NULL COMMENT 'plan version',
  approval_id BIGINT UNSIGNED NOT NULL COMMENT 'approval id',
  operation_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'operation id',
  actor_id INT UNSIGNED NOT NULL COMMENT 'actor id',
  request_key VARBINARY(255) NOT NULL COMMENT 'request key',
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'payload hash',
  state ENUM('queued','prechecking','dispatching','succeeded','failed','outcome_unknown','cancelled') NOT NULL DEFAULT 'queued' COMMENT 'state',
  lease_owner VARCHAR(128) NULL COMMENT 'lease owner',
  lease_expires_at DATETIME(3) NULL COMMENT 'lease expires at',
  fence BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'fence',
  sent_at DATETIME(3) NULL COMMENT 'sent at',
  cancel_requested_at DATETIME(3) NULL COMMENT 'cancel requested at',
  receipt JSON NULL COMMENT 'receipt',
  receipt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'receipt hash',
  error_code VARCHAR(128) NULL COMMENT 'error code',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'updated at',
  UNIQUE KEY uq_action_execution_approval (approval_id),
  UNIQUE KEY uq_action_execution_plan (plan_id,plan_version,approval_id),
  UNIQUE KEY uq_action_execution_request (actor_id,request_key),
  UNIQUE KEY uq_action_operation (operation_id),
  KEY idx_action_execution_lease (state,lease_expires_at,id),
  CONSTRAINT fk_ops_execution_plan FOREIGN KEY(plan_id,plan_version) REFERENCES action_plan_versions(plan_id,version) ON DELETE RESTRICT,
  CONSTRAINT fk_ops_execution_approval FOREIGN KEY(approval_id) REFERENCES action_approval_bindings(approval_id) ON DELETE RESTRICT,
  CHECK (schema_version=1 AND version>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

-- Global/resource locks compose in the same transaction as approval consumption,
-- existing intent/outbox and execution. Fences never authorize remote retries.
CREATE TABLE IF NOT EXISTS action_dispatch_locks (
  lock_key VARBINARY(128) NOT NULL PRIMARY KEY COMMENT 'lock key',
  execution_id VARCHAR(128) COLLATE utf8mb4_bin NULL COMMENT 'execution id',
  fence BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'fence',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'updated at',
  CONSTRAINT fk_ops_dispatch_execution FOREIGN KEY(execution_id) REFERENCES action_executions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';

CREATE TABLE IF NOT EXISTS action_verification_reports (
  id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'id',
  version BIGINT UNSIGNED NOT NULL COMMENT 'version',
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'schema version',
  execution_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'execution id',
  investigation_id CHAR(36) NOT NULL COMMENT 'investigation id',
  result_version BIGINT UNSIGNED NOT NULL COMMENT 'result version',
  plan_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL COMMENT 'plan id',
  plan_version BIGINT UNSIGNED NOT NULL COMMENT 'plan version',
  verifier_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'verifier hash',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'content hash',
  state ENUM('pending','observing','passed','failed','inconclusive') NOT NULL DEFAULT 'pending' COMMENT 'state',
  observed_from DATETIME(3) NULL COMMENT 'observed from',
  observed_until DATETIME(3) NULL COMMENT 'observed until',
  missing_samples INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'missing samples',
  evidence JSON NOT NULL COMMENT 'evidence',
  conclusion JSON NOT NULL COMMENT 'conclusion',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'created at',
  PRIMARY KEY(id,version),
  KEY idx_verification_execution (execution_id,version),
  KEY idx_verification_result (investigation_id,result_version,id,version),
  CONSTRAINT fk_ops_verification_execution FOREIGN KEY(execution_id) REFERENCES action_executions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ops_verification_plan FOREIGN KEY(plan_id,plan_version) REFERENCES action_plan_versions(plan_id,version) ON DELETE RESTRICT,
  CHECK (schema_version=1 AND version>0 AND result_version>0),
  CHECK (state<>'passed' OR (missing_samples=0 AND observed_from IS NOT NULL AND observed_until>observed_from))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Operations immutable versions and retained audit history';
