SET @target_database_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND COLUMN_NAME = 'target_database'
);
SET @sql := IF(@target_database_exists = 0,
  'ALTER TABLE approval_requests ADD COLUMN target_database VARCHAR(128) NULL AFTER submitted_by',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

SET @has_executing := (
  SELECT LOCATE('executing', COLUMN_TYPE) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND COLUMN_NAME = 'status'
);
SET @sql := IF(@has_executing = 0,
  "ALTER TABLE approval_requests MODIFY COLUMN status ENUM('pending','executing','approved','rejected','executed','execution_failed','cancelled') NOT NULL DEFAULT 'pending'",
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

SET @has_claimed := (
  SELECT LOCATE('claimed', COLUMN_TYPE) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_events' AND COLUMN_NAME = 'event_type'
);
SET @sql := IF(@has_claimed = 0,
  "ALTER TABLE approval_events MODIFY COLUMN event_type ENUM('submitted','ai_reviewed','claimed','approved','rejected','executed','execution_failed','notified') NOT NULL",
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
