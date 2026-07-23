-- The baseline marked historical 018 as covered without including this column.
-- Repair the schema contract forward-only for fresh and already-baselined DBs.
SET @execution_trace_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_analysis' AND COLUMN_NAME = 'execution_trace'
);
SET @sql := IF(@execution_trace_exists = 0,
  "ALTER TABLE ai_analysis ADD COLUMN execution_trace JSON DEFAULT NULL COMMENT 'Agent execution trace' AFTER `usage`",
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
