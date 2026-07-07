-- Migration 021: Add server alert fields
--
-- Description: Extend alert_rules, alerts, and alert_events tables
--              with server_id and target_type columns for server-scoped alert rules.
--
-- Requirements: ALR-01, ALR-02, ALR-03, ALR-04
--
-- Usage: Run once against the primary MySQL database.
--        Idempotent via column-existence checks.

-- ========================================
-- Section 1: alert_rules — server scoping
-- ========================================

-- Add target_type to distinguish server vs instance rules
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND COLUMN_NAME = 'target_type');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `alert_rules` ADD COLUMN `target_type` ENUM(''instance'',''server'') NOT NULL DEFAULT ''instance'' AFTER `id`',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add server_id to alert_rules (NULL for instance-scoped rules, specific server ID for server rules)
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND COLUMN_NAME = 'server_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `alert_rules` ADD COLUMN `server_id` INT UNSIGNED DEFAULT NULL AFTER `instance_ids`',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Index for querying rules by server_id
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND INDEX_NAME = 'idx_server_rules');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE `alert_rules` ADD INDEX `idx_server_rules` (`server_id`)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ========================================
-- Section 2: alerts — server_id column
-- ========================================

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND COLUMN_NAME = 'server_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `alerts` ADD COLUMN `server_id` INT UNSIGNED DEFAULT NULL AFTER `instance_id`',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND INDEX_NAME = 'idx_server_alerts');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE `alerts` ADD INDEX `idx_server_alerts` (`server_id`)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ========================================
-- Section 3: alert_events — server_id column
-- ========================================

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND COLUMN_NAME = 'server_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `alert_events` ADD COLUMN `server_id` INT UNSIGNED DEFAULT NULL AFTER `instance_id`',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_events' AND INDEX_NAME = 'idx_server_events');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE `alert_events` ADD INDEX `idx_server_events` (`server_id`)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
