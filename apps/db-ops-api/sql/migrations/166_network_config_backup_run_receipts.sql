SET @slide_166_sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE network_config_backup_runs ADD COLUMN backup_id BIGINT UNSIGNED NULL COMMENT ''此运行保存或复用的配置备份 ID'', ADD COLUMN backup_audit_id CHAR(36) COLLATE utf8mb4_unicode_ci NULL COMMENT ''此运行成功采集的审计条目 ID''',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'network_config_backup_runs' AND COLUMN_NAME = 'backup_id'
);
PREPARE slide_166_stmt FROM @slide_166_sql;
EXECUTE slide_166_stmt;
DEALLOCATE PREPARE slide_166_stmt;
