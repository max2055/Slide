-- ============================================
-- Database Migration: 016_add_db_version_and_data_size_to_instances
-- ============================================
-- Purpose: Add db_version and data_size_gb columns to
--          database_instances table. These columns are
--          referenced in instance-database-service.ts and
--          monitor-collector.ts but were missing from the
--          CREATE TABLE statement.
-- Date: 2026-06-10
-- ============================================

START TRANSACTION;

-- 1. Add db_version column
ALTER TABLE `database_instances`
  ADD COLUMN `db_version` VARCHAR(50) DEFAULT NULL COMMENT '数据库版本号'
  AFTER `database_name`;

-- 2. Add data_size_gb column
ALTER TABLE `database_instances`
  ADD COLUMN `data_size_gb` DECIMAL(10,2) DEFAULT NULL COMMENT '数据总大小 GB'
  AFTER `db_version`;

COMMIT;
