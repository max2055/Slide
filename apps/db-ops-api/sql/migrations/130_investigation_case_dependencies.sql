-- Additive reference receipts, never copied case content or current evidence.
-- Retain across summaries, successor Runs and rollback to older executables.
CREATE TABLE IF NOT EXISTS investigation_case_dependencies (
  investigation_id CHAR(36) NOT NULL COMMENT 'Investigation that consumed the reference',
  case_id CHAR(36) NOT NULL COMMENT 'Exact case identity, no latest-version fallback',
  case_version BIGINT UNSIGNED NOT NULL COMMENT 'Immutable consumed version',
  content_hash CHAR(64) NOT NULL COMMENT 'Exact consumed case content hash',
  PRIMARY KEY (investigation_id, case_id),
  CONSTRAINT fk_investigation_case_dependency FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Investigation-wide case egress dependencies, not evidence';
