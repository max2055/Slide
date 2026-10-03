-- Repair 106 forward: MySQL 8 defaults cron_runs to 0900_ai_ci while
-- existing cron_job_logs inherits unicode_ci. Recovery joins both run IDs.
-- Keep 106 checksum-immutable and preserve all run records and states.
ALTER TABLE cron_runs MODIFY COLUMN run_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  NOT NULL COMMENT '本次运行关联 ID';

ALTER TABLE cron_job_logs MODIFY COLUMN run_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  NULL COMMENT 'NULL 表示旧 runner 语义，不追溯业务成功';
