CREATE TABLE cron_runs (
  run_id CHAR(36) NOT NULL PRIMARY KEY COMMENT '本次运行关联 ID',
  job_id INT UNSIGNED NOT NULL COMMENT '原任务 ID，删除任务后保留运行记录',
  triggered_by INT UNSIGNED NULL COMMENT '手动触发主体，NULL 表示定时触发',
  request_key CHAR(64) NOT NULL COMMENT '主体任务幂等键摘要',
  request_hash CHAR(64) NOT NULL COMMENT '请求参数摘要',
  status ENUM('queued','running','success','partial','failed','unknown','cancelled') NOT NULL DEFAULT 'queued' COMMENT '业务运行状态',
  queued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '持久化入队时间',
  started_at DATETIME(3) NULL COMMENT 'runner 启动时间',
  runner_finished_at DATETIME(3) NULL COMMENT 'runner 结束时间，独立于业务完成',
  completed_at DATETIME(3) NULL COMMENT '已保存业务完成证据的时间',
  completion JSON NULL COMMENT '结构化业务完成证据',
  completion_hash CHAR(64) NULL COMMENT '完成幂等摘要',
  output_schema JSON NULL COMMENT '入队时输出契约快照',
  log_id BIGINT UNSIGNED NULL COMMENT '旧日志关联 ID',
  error_code VARCHAR(128) NULL COMMENT '缺失完成或执行错误原因',
  UNIQUE KEY uq_cron_request_key (request_key),
  KEY idx_cron_runs_job (job_id, queued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Cron 业务运行、完成证据与调度意图关联';

ALTER TABLE cron_job_logs ADD COLUMN run_id CHAR(36) NULL COMMENT 'NULL 表示旧 runner 语义，不追溯业务成功',
  ADD UNIQUE KEY uq_cron_log_run (run_id);

ALTER TABLE cron_job_logs MODIFY COLUMN status ENUM('running','success','error','skipped','timeout','partial','queued','failed','unknown','cancelled') NOT NULL DEFAULT 'running' COMMENT '运行日志状态；run_id 为 NULL 时保留旧 runner 语义';

-- Native handlers return business evidence, not the old Agent statistics template.
UPDATE cron_jobs SET output_schema = JSON_OBJECT('type', 'object',
  'properties', JSON_OBJECT('handler', JSON_OBJECT('type', 'string'), 'data', JSON_OBJECT()),
  'required', JSON_ARRAY('handler', 'data'), 'additionalProperties', JSON_EXTRACT('false', '$'))
WHERE principal_type = 'system-maintenance' AND handler_key IN
  ('capacity.collect','baseline.cleanup','report.schedule','alert.evaluate','notification.dispatch','fault.diagnose-unhealthy');
