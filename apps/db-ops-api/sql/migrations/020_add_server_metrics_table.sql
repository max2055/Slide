-- Migration 020: Add server_metrics table
--
-- Description: Create server_metrics KV table for SSH-collected
--              OS-level metric time series (CPU, memory, disk, load, uptime).
--
-- Requirements: COL-01 (server_metrics KV table), COL-03 (metric rows per collected value)

-- ========================================
-- Section 1: server_metrics table
-- ========================================
CREATE TABLE IF NOT EXISTS `server_metrics` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_id` INT UNSIGNED NOT NULL,
  `metric_name` VARCHAR(100) NOT NULL COMMENT 'e.g. cpu_usage, memory_usage, disk_usage, load_1min, uptime',
  `metric_value` DECIMAL(20,4) NOT NULL COMMENT 'numeric metric value',
  `recorded_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_server_time` (`server_id`, `recorded_at`),
  INDEX `idx_server_metric_time` (`server_id`, `metric_name`, `recorded_at`),
  CONSTRAINT `fk_server_metrics_server` FOREIGN KEY (`server_id`) REFERENCES `servers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
