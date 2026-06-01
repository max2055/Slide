-- Migration 015: Add output_schema for structured cron job results
-- Supports: Layer 1 - Structured JSON output validation

ALTER TABLE cron_jobs
  ADD COLUMN output_schema JSON DEFAULT NULL AFTER task_description
  COMMENT 'Expected JSON schema for structured output validation';

ALTER TABLE cron_job_logs
  ADD COLUMN structured_result JSON DEFAULT NULL AFTER result
  COMMENT 'Parsed structured JSON output matching output_schema';

-- =========================================================================
-- Seed output schemas for existing jobs
-- =========================================================================

-- Schema snapshot schema
UPDATE cron_jobs
SET output_schema = JSON_OBJECT(
  'instances', JSON_OBJECT('type', 'object', 'properties', JSON_OBJECT(
    'total', JSON_OBJECT('type', 'integer'),
    'succeeded', JSON_OBJECT('type', 'integer'),
    'failed', JSON_OBJECT('type', 'integer')
  )),
  'failures', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT(
    'type', 'object', 'properties', JSON_OBJECT(
      'instance', JSON_OBJECT('type', 'string'),
      'reason', JSON_OBJECT('type', 'string')
    )
  )),
  'schemas_collected', JSON_OBJECT('type', 'integer'),
  'changes_detected', JSON_OBJECT('type', 'integer'),
  'coverage_rate', JSON_OBJECT('type', 'number')
)
WHERE name = 'Schema 快照采集';

-- Capacity collection schema
UPDATE cron_jobs
SET output_schema = JSON_OBJECT(
  'instances', JSON_OBJECT('type', 'object', 'properties', JSON_OBJECT(
    'total', JSON_OBJECT('type', 'integer'),
    'succeeded', JSON_OBJECT('type', 'integer'),
    'failed', JSON_OBJECT('type', 'integer')
  )),
  'failures', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT(
    'type', 'object', 'properties', JSON_OBJECT(
      'instance', JSON_OBJECT('type', 'string'),
      'reason', JSON_OBJECT('type', 'string')
    )
  )),
  'total_storage_gb', JSON_OBJECT('type', 'number'),
  'total_databases', JSON_OBJECT('type', 'integer'),
  'total_tables', JSON_OBJECT('type', 'integer'),
  'coverage_rate', JSON_OBJECT('type', 'number')
)
WHERE name = '容量数据采集';

-- Index collection schema
UPDATE cron_jobs
SET output_schema = JSON_OBJECT(
  'instances', JSON_OBJECT('type', 'object', 'properties', JSON_OBJECT(
    'total', JSON_OBJECT('type', 'integer'),
    'succeeded', JSON_OBJECT('type', 'integer'),
    'failed', JSON_OBJECT('type', 'integer')
  )),
  'failures', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT(
    'type', 'object', 'properties', JSON_OBJECT(
      'instance', JSON_OBJECT('type', 'string'),
      'reason', JSON_OBJECT('type', 'string')
    )
  )),
  'total_indexes', JSON_OBJECT('type', 'integer'),
  'coverage_rate', JSON_OBJECT('type', 'number')
)
WHERE name = '索引信息采集';

-- Log collection schema
UPDATE cron_jobs
SET output_schema = JSON_OBJECT(
  'instances', JSON_OBJECT('type', 'object', 'properties', JSON_OBJECT(
    'total', JSON_OBJECT('type', 'integer'),
    'succeeded', JSON_OBJECT('type', 'integer'),
    'failed', JSON_OBJECT('type', 'integer')
  )),
  'failures', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT(
    'type', 'object', 'properties', JSON_OBJECT(
      'instance', JSON_OBJECT('type', 'string'),
      'reason', JSON_OBJECT('type', 'string')
    )
  )),
  'logs_collected', JSON_OBJECT('type', 'integer'),
  'coverage_rate', JSON_OBJECT('type', 'number')
)
WHERE name = '数据库日志采集';

-- Generic schema for all other tasks (baseline metric)
UPDATE cron_jobs
SET output_schema = JSON_OBJECT(
  'instances', JSON_OBJECT('type', 'object', 'properties', JSON_OBJECT(
    'total', JSON_OBJECT('type', 'integer'),
    'succeeded', JSON_OBJECT('type', 'integer'),
    'failed', JSON_OBJECT('type', 'integer')
  )),
  'failures', JSON_OBJECT('type', 'array', 'items', JSON_OBJECT(
    'type', 'object', 'properties', JSON_OBJECT(
      'instance', JSON_OBJECT('type', 'string'),
      'reason', JSON_OBJECT('type', 'string')
    )
  )),
  'coverage_rate', JSON_OBJECT('type', 'number')
)
WHERE output_schema IS NULL;
