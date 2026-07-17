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

CREATE TABLE IF NOT EXISTS `chat_session_shares` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(100) NOT NULL,
  `granted_by` INT UNSIGNED NOT NULL,
  `recipient_user_id` INT UNSIGNED NOT NULL,
  `permission` ENUM('read') NOT NULL DEFAULT 'read',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_chat_session_share_recipient` (`session_id`, `recipient_user_id`),
  KEY `idx_chat_share_recipient_permission` (`recipient_user_id`, `permission`),
  KEY `idx_chat_share_grantor` (`granted_by`),
  CONSTRAINT `fk_chat_share_session`
    FOREIGN KEY (`session_id`) REFERENCES `chat_sessions` (`session_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_chat_share_grantor`
    FOREIGN KEY (`granted_by`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_chat_share_recipient`
    FOREIGN KEY (`recipient_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

COMMIT;
