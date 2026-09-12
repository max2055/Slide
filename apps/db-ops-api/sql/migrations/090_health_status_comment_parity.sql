-- MODIFY COLUMN in 089 removed the existing comment. Restore it forward
-- without changing the checksum of a migration that may already be applied.
ALTER TABLE health_check_history MODIFY COLUMN status ENUM('healthy', 'warning', 'critical', 'unknown') NOT NULL COMMENT '健康检查状态（健康、警告、异常、未知）';
