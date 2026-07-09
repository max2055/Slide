-- Migration 022: Unified observability — target_type on metric_definitions + alert_rule_templates
--
-- Description: Add target_type column to metric_definitions table to distinguish
--              instance vs server metrics. Create alert_rule_templates table with
--              server-scoped preset templates (CPU/memory/disk/load/unreachable).
--
-- Requirements: UNI-01
--
-- Usage: Run once against the primary MySQL database.
--        All operations are idempotent via column-existence checks and
--        CREATE TABLE IF NOT EXISTS / INSERT IGNORE.

START TRANSACTION;

-- =====================================================
-- Section 1: metric_definitions — add target_type column
-- =====================================================

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'target_type');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `metric_definitions` ADD COLUMN `target_type` ENUM(''instance'',''server'') NOT NULL DEFAULT ''instance'' AFTER `id`',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure existing instance metrics have target_type='instance' (idempotent — default handles new rows)
UPDATE metric_definitions SET target_type = 'instance' WHERE target_type IS NULL OR target_type = '';

-- =============================================
-- Section 2: Create alert_rule_templates table
-- =============================================

CREATE TABLE IF NOT EXISTS `alert_rule_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `target_type` ENUM('instance','server') NOT NULL DEFAULT 'instance',
  `metric_name` VARCHAR(100) NOT NULL,
  `operator` VARCHAR(10) NOT NULL,
  `threshold_template` JSON,
  `duration_seconds` INT DEFAULT 60,
  `severity` ENUM('info','warning','error','critical') DEFAULT 'warning',
  `silence_minutes` INT DEFAULT 5,
  `enabled` BOOLEAN DEFAULT TRUE,
  `created_by` INT UNSIGNED,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_target_type` (`target_type`),
  INDEX `idx_metric_name` (`metric_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================
-- Section 3: Seed server preset templates
-- =============================================

INSERT IGNORE INTO `alert_rule_templates`
  (`name`, `description`, `target_type`, `metric_name`, `operator`, `threshold_template`, `duration_seconds`, `severity`, `silence_minutes`)
VALUES
  ('CPU过高', '服务器 CPU 使用率超过阈值', 'server', 'cpu_usage', '>', '{"warning":80,"error":90,"critical":95}', 120, 'warning', 5),
  ('内存过高', '服务器内存使用率超过阈值', 'server', 'memory_usage', '>', '{"warning":80,"error":90,"critical":95}', 120, 'warning', 5),
  ('磁盘过高', '服务器磁盘使用率超过阈值', 'server', 'disk_usage', '>', '{"warning":75,"error":85,"critical":95}', 180, 'warning', 5),
  ('负载过高', '服务器系统负载超过阈值', 'server', 'load_1min', '>', '{"warning":4,"error":8,"critical":12}', 120, 'warning', 5),
  ('服务器不可达', '服务器连接超时或无法访问', 'server', 'reachability', '=', '{"warning":1,"error":2,"critical":3}', 600, 'error', 5);

COMMIT;
