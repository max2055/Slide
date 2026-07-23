-- The legacy snapshot marked 015 as covered but omitted this runtime column.
-- Repair it forward-only for new and already-baselined installations.
SET @structured_result_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cron_job_logs' AND COLUMN_NAME = 'structured_result'
);
SET @sql := IF(@structured_result_exists = 0,
  'ALTER TABLE cron_job_logs ADD COLUMN structured_result JSON DEFAULT NULL AFTER result',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
