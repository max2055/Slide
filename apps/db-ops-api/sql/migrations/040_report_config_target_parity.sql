SET @instance_nullable := (
  SELECT IS_NULLABLE = 'YES' FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'report_configs' AND COLUMN_NAME = 'instance_id'
);
SET @sql := IF(@instance_nullable = 0,
  'ALTER TABLE report_configs MODIFY COLUMN instance_id INT UNSIGNED NULL',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
