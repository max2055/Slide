-- Migration 025: authoritative actor session versioning

START TRANSACTION;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'session_version');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `session_version` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT ''Incremented when security-sensitive user state changes'' AFTER `status`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens' AND COLUMN_NAME = 'session_version');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `refresh_tokens` ADD COLUMN `session_version` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT ''User session version at issuance'' AFTER `user_id`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens' AND INDEX_NAME = 'idx_rt_user_session');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE `refresh_tokens` ADD INDEX `idx_rt_user_session` (`user_id`, `session_version`, `revoked`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

COMMIT;
