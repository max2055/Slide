-- ============================================
-- Migration 004: Add sql_execution_history table
-- Phase 97 - SQL 执行历史持久化
-- ============================================

CREATE TABLE IF NOT EXISTS `sql_execution_history` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT DEFAULT NULL,
  `username` VARCHAR(100) DEFAULT NULL,
  `instance_id` INT DEFAULT NULL,
  `instance_name` VARCHAR(200) DEFAULT NULL,
  `db_type` VARCHAR(20) DEFAULT NULL,
  `database_name` VARCHAR(100) DEFAULT NULL,
  `sql_text` TEXT,
  `status` VARCHAR(20) DEFAULT 'success',
  `duration_ms` INT DEFAULT 0,
  `row_count` INT DEFAULT 0,
  `error_message` TEXT DEFAULT NULL,
  `ip_address` VARCHAR(45) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_instance_id (instance_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  FULLTEXT INDEX idx_sql_text (sql_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
