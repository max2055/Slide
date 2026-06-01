-- ============================================
-- Migration 007: Report Configs Table
-- Phase 103 - 报表重构 (RPT-02)
-- ============================================
-- Purpose: Add report_configs table for scheduled report
--          generation with cron expressions, type, format,
--          and per-config enable/disable support.
-- ============================================

START TRANSACTION;

-- =========================================================================
-- 1. Create report_configs table
-- =========================================================================

CREATE TABLE IF NOT EXISTS `report_configs` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL COMMENT '配置名称',
  `cron` VARCHAR(100) NOT NULL COMMENT '5-field cron expression (min hour dom mon dow)',
  `type` ENUM('health', 'performance', 'slow_query', 'capacity') NOT NULL COMMENT '报表类型',
  `instance_id` INT UNSIGNED NOT NULL COMMENT '关联的数据库实例ID',
  `format` ENUM('html', 'pdf', 'md', 'json') NOT NULL DEFAULT 'html' COMMENT '输出格式',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '启用开关',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_enabled` (`enabled`),
  INDEX `idx_instance_id` (`instance_id`),
  CONSTRAINT `fk_rc_instance` FOREIGN KEY (`instance_id`) REFERENCES `database_instances`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

COMMIT;
