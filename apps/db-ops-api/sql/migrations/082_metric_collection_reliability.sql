-- Preserve sparse, independently scheduled metric samples and support bounded
-- latest/history reads without filesorts on the high-volume observation tables.
ALTER TABLE metrics_history
  MODIFY COLUMN cpu_usage DECIMAL(5,2) DEFAULT NULL COMMENT 'CPU 使用率 %',
  MODIFY COLUMN memory_usage DECIMAL(5,2) DEFAULT NULL COMMENT '内存使用率 %',
  MODIFY COLUMN disk_usage DECIMAL(5,2) DEFAULT NULL COMMENT '磁盘使用率 %',
  MODIFY COLUMN connections INT DEFAULT NULL COMMENT '连接数',
  MODIFY COLUMN qps DECIMAL(10,2) DEFAULT NULL COMMENT '每秒查询数',
  MODIFY COLUMN tps DECIMAL(10,2) DEFAULT NULL COMMENT '每秒事务数',
  MODIFY COLUMN active_transactions INT DEFAULT NULL COMMENT '活跃事务',
  MODIFY COLUMN slow_queries INT DEFAULT NULL COMMENT '慢查询查询',
  MODIFY COLUMN buffer_pool_hit_rate DECIMAL(5,2) DEFAULT NULL COMMENT '缓冲池命中率 %',
  MODIFY COLUMN threads_running INT DEFAULT NULL COMMENT '线程运行',
  MODIFY COLUMN threads_connected INT DEFAULT NULL COMMENT '线程已连接',
  MODIFY COLUMN bytes_received BIGINT DEFAULT NULL COMMENT '字节接收',
  MODIFY COLUMN bytes_sent BIGINT DEFAULT NULL COMMENT '字节发送',
  MODIFY COLUMN queries_total BIGINT DEFAULT NULL COMMENT '查询总计',
  MODIFY COLUMN commits_total BIGINT DEFAULT NULL COMMENT '提交事务总计',
  MODIFY COLUMN rollbacks_total BIGINT DEFAULT NULL COMMENT '回滚事务总计',
  DROP INDEX idx_instance_time,
  ADD INDEX idx_instance_time (instance_id, recorded_at, id);

ALTER TABLE server_metrics
  DROP INDEX idx_server_time,
  ADD INDEX idx_server_time (server_id, recorded_at, id),
  DROP INDEX idx_server_metric_time,
  ADD INDEX idx_server_metric_time (server_id, metric_name, recorded_at, id);

ALTER TABLE network_device_observations
  ADD INDEX idx_network_device_observation_time (device_id, observed_at, id);

UPDATE metric_definitions
SET is_collected = FALSE
WHERE target_type = 'instance' AND id = 'health_score';
