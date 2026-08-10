-- Restore metric registry columns used by the runtime but omitted from the
-- legacy snapshot and migration ledger coverage.
SET @collection_sqls_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'collection_sqls'
);
SET @sql := IF(@collection_sqls_exists = 0,
  'ALTER TABLE metric_definitions ADD COLUMN collection_sqls JSON DEFAULT NULL COMMENT ''各数据库类型的采集 SQL JSON'' AFTER is_builtin',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

SET @compute_expr_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'compute_expr'
);
SET @sql := IF(@compute_expr_exists = 0,
  'ALTER TABLE metric_definitions ADD COLUMN compute_expr VARCHAR(500) DEFAULT NULL COMMENT ''计算表达式'' AFTER collection_sqls',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

SET @template_id_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'template_id'
);
SET @sql := IF(@template_id_exists = 0,
  'ALTER TABLE metric_definitions ADD COLUMN template_id INT UNSIGNED DEFAULT NULL COMMENT ''模板 ID'' AFTER updated_by',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

SET @template_id_index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND INDEX_NAME = 'idx_template_id'
);
SET @sql := IF(@template_id_index_exists = 0,
  'ALTER TABLE metric_definitions ADD INDEX idx_template_id (template_id)',
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;
