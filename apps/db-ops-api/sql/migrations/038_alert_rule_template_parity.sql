SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND COLUMN_NAME = 'template_id'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE alert_rules ADD COLUMN template_id INT UNSIGNED NULL COMMENT ''所属模板，NULL=全局规则'' AFTER instance_ids',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND INDEX_NAME = 'idx_alert_rule_template_id'
);
SET @sql := IF(@index_exists = 0,
  'ALTER TABLE alert_rules ADD INDEX idx_alert_rule_template_id (template_id)',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
