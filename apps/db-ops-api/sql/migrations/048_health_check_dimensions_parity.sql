-- The historical baseline omitted a column required by health-check persistence.
-- Keep this forward-only so both fresh and already-baselined databases converge.
SET @dimensions_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'health_check_history' AND COLUMN_NAME = 'dimensions'
);
SET @sql := IF(@dimensions_exists = 0,
  'ALTER TABLE health_check_history ADD COLUMN dimensions JSON DEFAULT NULL AFTER status',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
