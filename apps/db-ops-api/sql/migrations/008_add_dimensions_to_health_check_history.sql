-- ============================================
-- Migration 008: Add dimensions column to health_check_history
-- Phase 105 - 数据质量
-- IN-01: Historical dimension scores not persisted
-- ============================================
-- Purpose: Add a dimensions JSON column to health_check_history
--          to persist per-check dimension scores (availability,
--          performance, capacity, security) for historical trend display.
-- ============================================

START TRANSACTION;

ALTER TABLE `health_check_history`
  ADD COLUMN `dimensions` JSON DEFAULT NULL COMMENT '维度评分 { availability: N, performance: N, capacity: N, security: N }' AFTER `status`;

COMMIT;
