-- NULL keeps historical and PostgreSQL records unchanged. MySQL error_log.LOGGED
-- is a primary key; epoch seconds with six decimals retain its full precision.
ALTER TABLE database_logs
  ADD COLUMN source_position DECIMAL(20,6) DEFAULT NULL COMMENT 'MySQL 源日志 UTC epoch 微秒水位；历史及其他来源为空',
  ADD UNIQUE KEY uq_database_log_source_position (instance_id, source, source_position);
