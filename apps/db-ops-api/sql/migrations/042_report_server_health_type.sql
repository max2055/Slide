SET @has_server_health := (
  SELECT LOCATE('server_health', COLUMN_TYPE) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'type'
);
SET @sql := IF(@has_server_health = 0,
  "ALTER TABLE reports MODIFY COLUMN type ENUM('health','performance','slow_query','capacity','audit','custom','server_health') NOT NULL",
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
