-- Migration 024: data-loom integration improvements
-- P0: cross-table association IDs + approval execution status
-- P1: slow_queries tables_accessed + alert_events reviewed status
-- P2: approval rollback_info

START TRANSACTION;

-- =============================================
-- P0-1: sql_execution_history → approval_request_id
-- =============================================
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sql_execution_history' AND COLUMN_NAME = 'approval_request_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `sql_execution_history` ADD COLUMN `approval_request_id` BIGINT UNSIGNED DEFAULT NULL COMMENT ''审批请求 ID，关联 approval_requests.id'' AFTER `ip_address`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sql_execution_history' AND INDEX_NAME = 'idx_approval_request_id');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE `sql_execution_history` ADD INDEX `idx_approval_request_id` (`approval_request_id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =============================================
-- P0-2: approval_requests.status + execution_failed
-- =============================================
SET @enum_has_execution_failed = (SELECT LOCATE('execution_failed', COLUMN_TYPE) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND COLUMN_NAME = 'status');
SET @sql = IF(@enum_has_execution_failed = 0,
  "ALTER TABLE `approval_requests` MODIFY COLUMN `status` ENUM('pending','approved','rejected','executed','execution_failed','cancelled') NOT NULL DEFAULT 'pending'",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =============================================
-- P1-1: slow_queries + tables_accessed JSON
-- =============================================
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'slow_queries' AND COLUMN_NAME = 'tables_accessed');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `slow_queries` ADD COLUMN `tables_accessed` JSON DEFAULT NULL COMMENT ''访问的表名列表 ["orders","users"]'' AFTER `schema_name`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =============================================
-- P1-2: alert_events.status + reviewed
-- =============================================
SET @enum_has_reviewed = (SELECT LOCATE('reviewed', COLUMN_TYPE) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND COLUMN_NAME = 'status');
SET @sql = IF(@enum_has_reviewed = 0,
  "ALTER TABLE `alert_events` MODIFY COLUMN `status` ENUM('open','investigating','handled','resolved','closed','reviewed') NOT NULL DEFAULT 'open'",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =============================================
-- P2: approval_requests + rollback_info JSON
-- =============================================
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'approval_requests' AND COLUMN_NAME = 'rollback_info');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `approval_requests` ADD COLUMN `rollback_info` JSON DEFAULT NULL COMMENT ''回滚信息 {sql, executed_at, success, notes}'' AFTER `execution_result`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

COMMIT;
