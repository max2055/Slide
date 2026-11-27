-- Restore the application state removed by migration 058.
ALTER TABLE notification_records
  MODIFY COLUMN status ENUM('pending', 'sent', 'failed', 'suppressed')
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '业务状态';
