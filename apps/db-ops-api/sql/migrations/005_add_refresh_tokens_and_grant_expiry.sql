-- ============================================
-- Migration 005: Refresh Tokens + Grant Expiry
-- Phase 101 - Refresh Token & Grant Expiry
-- ============================================
-- Purpose: Implement dual-token auth (1h access + 7d refresh),
--          add grant_expiry to user_roles and instance_permissions
--          for automatic temporary authorization expiration.
-- ============================================

START TRANSACTION;

-- =========================================================================
-- 1. Create refresh_tokens table
-- =========================================================================

CREATE TABLE IF NOT EXISTS `refresh_tokens` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `token_hash` CHAR(64) NOT NULL COMMENT 'SHA-256 hex of the raw refresh token',
  `user_id` INT UNSIGNED NOT NULL,
  `expires_at` DATETIME NOT NULL COMMENT '7 days from creation',
  `revoked` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_token_hash` (`token_hash`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_expires_at` (`expires_at`),
  CONSTRAINT `fk_rt_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================================
-- 2. Add grant_expiry to user_roles
-- =========================================================================

ALTER TABLE `user_roles`
  ADD COLUMN `grant_expiry` DATETIME NULL DEFAULT NULL AFTER `created_at`,
  ADD INDEX `idx_grant_expiry` (`grant_expiry`);

-- =========================================================================
-- 3. Add access_level and grant_expiry to instance_permissions
-- =========================================================================

ALTER TABLE `instance_permissions`
  ADD COLUMN `access_level` ENUM('read-only', 'read-write', 'admin') NOT NULL DEFAULT 'read-only' AFTER `instance_id`,
  ADD COLUMN `grant_expiry` DATETIME NULL DEFAULT NULL AFTER `access_level`,
  ADD INDEX `idx_grant_expiry` (`grant_expiry`);

COMMIT;
