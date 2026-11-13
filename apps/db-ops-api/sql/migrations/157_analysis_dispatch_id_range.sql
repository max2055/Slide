-- Keep all analysis references aligned with ai_analysis.id without changing 109.
ALTER TABLE analysis_dispatches
  MODIFY COLUMN analysis_id BIGINT UNSIGNED NOT NULL COMMENT 'Analysis record identity',
  MODIFY COLUMN retry_of BIGINT UNSIGNED NULL COMMENT 'Explicitly confirmed unknown analysis predecessor';

ALTER TABLE analysis_dispatch_attempts
  MODIFY COLUMN analysis_id BIGINT UNSIGNED NOT NULL COMMENT 'Analysis record identity';

ALTER TABLE analysis_dispatch_keys
  MODIFY COLUMN analysis_id BIGINT UNSIGNED NULL COMMENT 'Analysis record identity';
