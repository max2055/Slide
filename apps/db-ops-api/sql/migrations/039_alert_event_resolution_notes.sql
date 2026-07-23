SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND COLUMN_NAME = 'resolution_notes'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE alert_events ADD COLUMN resolution_notes TEXT NULL AFTER resolved_by',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
