-- ============================================
-- 数据库智能运维系统 - 数据库 Schema
-- ============================================

-- 创建数据库
CREATE DATABASE IF NOT EXISTS `db_ops_ai`
DEFAULT CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE `db_ops_ai`;

-- ============================================
-- 1. 用户系统
-- ============================================

-- 用户表
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(50) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `email` VARCHAR(100) DEFAULT NULL,
  `status` ENUM('active', 'inactive', 'locked') NOT NULL DEFAULT 'active',
  `role_backup` VARCHAR(20) DEFAULT NULL COMMENT 'Phased out: roles moved to user_roles table via RBAC',
  `last_login_at` DATETIME DEFAULT NULL,
  `last_login_ip` VARCHAR(45) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_username` (`username`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 用户登录日志表
CREATE TABLE IF NOT EXISTS `user_login_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `username` VARCHAR(50) NOT NULL,
  `login_status` ENUM('success', 'failed') NOT NULL,
  `ip_address` VARCHAR(45) DEFAULT NULL,
  `user_agent` VARCHAR(255) DEFAULT NULL,
  `failure_reason` VARCHAR(100) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_username` (`username`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 用户操作日志表
CREATE TABLE IF NOT EXISTS `user_action_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `username` VARCHAR(50) NOT NULL,
  `action` VARCHAR(100) NOT NULL COMMENT '操作类型，如：create_instance, delete_user, modify_config',
  `resource_type` VARCHAR(50) DEFAULT NULL COMMENT '资源类型，如：user, instance, alert',
  `resource_id` VARCHAR(50) DEFAULT NULL,
  `details` JSON DEFAULT NULL COMMENT '操作详情',
  `ip_address` VARCHAR(45) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_action` (`action`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 2. 数据库实例管理
-- ============================================

-- 数据库实例配置表
CREATE TABLE IF NOT EXISTS `database_instances` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL COMMENT '实例名称',
  `environment` ENUM('development', 'staging', 'production', 'testing') NOT NULL DEFAULT 'development',
  `db_type` ENUM('mysql', 'postgresql', 'oracle', 'dameng', 'mongodb', 'redis', 'elasticsearch') NOT NULL DEFAULT 'mysql',
  `host` VARCHAR(255) NOT NULL,
  `port` INT NOT NULL,
  `username` VARCHAR(100) NOT NULL,
  `password_encrypted` VARCHAR(255) NOT NULL,
  `database_name` VARCHAR(100) DEFAULT NULL,
  `db_version` VARCHAR(50) DEFAULT NULL COMMENT '数据库版本号',
  `data_size_gb` DECIMAL(10,2) DEFAULT NULL COMMENT '数据总大小 GB',
  `connection_string` VARCHAR(500) DEFAULT NULL,
  `max_connections` INT DEFAULT 100,
  `connection_timeout_ms` INT DEFAULT 30000,
  `status` ENUM('active', 'inactive', 'error') NOT NULL DEFAULT 'active',
  `health_score` INT DEFAULT 100 COMMENT '健康分数 0-100',
  `health_status` ENUM('healthy', 'warning', 'critical', 'unknown') DEFAULT 'unknown',
  `last_health_check_at` DATETIME DEFAULT NULL,
  `tags` JSON DEFAULT NULL COMMENT '标签数组',
  `description` TEXT DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_name_environment` (`name`, `environment`),
  INDEX `idx_status` (`status`),
  INDEX `idx_health_status` (`health_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 实例连接池状态表
CREATE TABLE IF NOT EXISTS `instance_pool_stats` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `active_connections` INT DEFAULT 0,
  `idle_connections` INT DEFAULT 0,
  `waiting_requests` INT DEFAULT 0,
  `recorded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_recorded_at` (`recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 3. 监控指标
-- ============================================

-- 监控指标历史表
CREATE TABLE IF NOT EXISTS `metrics_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `cpu_usage` DECIMAL(5,2) DEFAULT 0 COMMENT 'CPU 使用率 %',
  `memory_usage` DECIMAL(5,2) DEFAULT 0 COMMENT '内存使用率 %',
  `disk_usage` DECIMAL(5,2) DEFAULT 0 COMMENT '磁盘使用率 %',
  `connections` INT DEFAULT 0 COMMENT '连接数',
  `qps` DECIMAL(10,2) DEFAULT 0 COMMENT '每秒查询数',
  `tps` DECIMAL(10,2) DEFAULT 0 COMMENT '每秒事务数',
  `active_transactions` INT DEFAULT 0,
  `slow_queries` INT DEFAULT 0,
  `buffer_pool_hit_rate` DECIMAL(5,2) DEFAULT 0 COMMENT '缓冲池命中率 %',
  `threads_running` INT DEFAULT 0,
  `threads_connected` INT DEFAULT 0,
  `bytes_received` BIGINT DEFAULT 0,
  `bytes_sent` BIGINT DEFAULT 0,
  `queries_total` BIGINT DEFAULT 0,
  `commits_total` BIGINT DEFAULT 0,
  `rollbacks_total` BIGINT DEFAULT 0,
  `table_open_cache_hit_rate` DECIMAL(5,2) DEFAULT NULL COMMENT 'MySQL 表缓存命中率 %',
  `handler_read_rnd_next` BIGINT DEFAULT NULL COMMENT 'MySQL 全表扫计数器（累计）',
  `handler_read_rnd_next_rate` DECIMAL(10,2) DEFAULT NULL COMMENT 'MySQL 全表扫速率（次/秒）',
  `key_blocks_usage` DECIMAL(5,2) DEFAULT NULL COMMENT 'MySQL MyISAM key buffer 使用率 %',
  `open_files` INT DEFAULT NULL COMMENT 'MySQL 打开文件数',
  `aborted_connects` INT DEFAULT NULL COMMENT 'MySQL 拒绝连接数（累计）',
  `aborted_connects_rate` DECIMAL(10,2) DEFAULT NULL COMMENT 'MySQL 拒绝连接速率（次/秒）',
  `idx_scan_ratio` DECIMAL(5,2) DEFAULT NULL COMMENT 'PG 索引扫描比例 %',
  `dead_tuples` BIGINT DEFAULT NULL COMMENT 'PG 死元组数',
  `cache_hit_ratio` DECIMAL(5,2) DEFAULT NULL COMMENT 'PG 缓冲命中率 %',
  `connections_used` INT DEFAULT NULL COMMENT 'PG 连接使用数',
  `connections_max` INT DEFAULT NULL COMMENT 'PG 最大连接数',
  `vacuum_count` INT DEFAULT NULL COMMENT 'PG 手动 vacuum 次数',
  `autovacuum_count` INT DEFAULT NULL COMMENT 'PG 自动 vacuum 次数',
  `replication_lag_seconds` DECIMAL(10,2) DEFAULT NULL COMMENT 'PG 复制延迟（秒）',
  `data_size_gb` DECIMAL(10,2) DEFAULT NULL COMMENT '数据总大小 GB',
  `is_estimated` TINYINT(1) DEFAULT 0 COMMENT '是否为估算值',
  `recorded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_recorded_at` (`recorded_at`),
  INDEX `idx_instance_time` (`instance_id`, `recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 健康检查历史表
CREATE TABLE IF NOT EXISTS `health_check_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `health_score` INT NOT NULL COMMENT '健康分数 0-100',
  `status` ENUM('healthy', 'warning', 'critical') NOT NULL,
  `checks` JSON NOT NULL COMMENT '详细检查项',
  `issues` JSON DEFAULT NULL COMMENT '发现的问题',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 4. 慢查询管理
-- ============================================

-- 慢查询记录表
CREATE TABLE IF NOT EXISTS `slow_queries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `sql_text` TEXT NOT NULL,
  `sql_hash` VARCHAR(64) NOT NULL COMMENT 'SQL 的 MD5 哈希',
  `avg_time_ms` DECIMAL(10,2) DEFAULT 0,
  `max_time_ms` DECIMAL(10,2) DEFAULT 0,
  `min_time_ms` DECIMAL(10,2) DEFAULT 0,
  `execution_count` BIGINT DEFAULT 1,
  `total_time_ms` DECIMAL(12,2) DEFAULT 0,
  `rows_examined` BIGINT DEFAULT 0,
  `rows_sent` BIGINT DEFAULT 0,
  `first_seen` DATETIME DEFAULT NULL,
  `last_seen` DATETIME DEFAULT NULL,
  `digest_text` TEXT DEFAULT NULL COMMENT '参数化后的 SQL',
  `schema_name` VARCHAR(100) DEFAULT NULL,
  `user_name` VARCHAR(100) DEFAULT NULL,
  `host_name` VARCHAR(255) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_sql_hash` (`sql_hash`),
  INDEX `idx_last_seen` (`last_seen`),
  INDEX `idx_avg_time` (`avg_time_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 慢查询分析记录表
CREATE TABLE IF NOT EXISTS `slow_query_analysis` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slow_query_id` BIGINT UNSIGNED NOT NULL,
  `analysis_type` ENUM('index_recommend', 'rewrite_suggest', 'config_tune') NOT NULL,
  `analysis_result` JSON NOT NULL,
  `recommendation` TEXT DEFAULT NULL,
  `estimated_improvement` VARCHAR(50) DEFAULT NULL,
  `analyzed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `analyzed_by` INT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_slow_query_id` (`slow_query_id`),
  INDEX `idx_analysis_type` (`analysis_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 5. 告警管理
-- ============================================

-- 告警表
CREATE TABLE IF NOT EXISTS `alerts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED DEFAULT NULL,
  `alert_type` ENUM('performance', 'availability', 'security', 'backup', 'replication', 'capacity') NOT NULL,
  `level` ENUM('info', 'warning', 'error', 'critical') NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `message` TEXT NOT NULL,
  `description` TEXT DEFAULT NULL,
  `status` ENUM('unread', 'read', 'acknowledged', 'resolved', 'closed') NOT NULL DEFAULT 'unread',
  `acknowledged_by` INT UNSIGNED DEFAULT NULL,
  `acknowledged_at` DATETIME DEFAULT NULL,
  `resolved_by` INT UNSIGNED DEFAULT NULL,
  `resolved_at` DATETIME DEFAULT NULL,
  `assigned_to` INT UNSIGNED DEFAULT NULL,
  `source` VARCHAR(50) DEFAULT NULL COMMENT '告警来源',
  `metric_name` VARCHAR(100) DEFAULT NULL,
  `metric_value` VARCHAR(50) DEFAULT NULL,
  `threshold_value` VARCHAR(50) DEFAULT NULL,
  `tags` JSON DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_level` (`level`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 告警规则表
CREATE TABLE IF NOT EXISTS `alert_rules` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `metric_name` VARCHAR(100) NOT NULL,
  `operator` ENUM('>', '<', '>=', '<=', '=', '!=') NOT NULL,
  `threshold` DECIMAL(15,2) NOT NULL,
  `threshold_template` JSON DEFAULT NULL COMMENT '三级阈值 {warning, error, critical}，从 metric-registry 继承',
  `duration_seconds` INT DEFAULT 60 COMMENT '持续时间超过阈值才触发',
  `severity` ENUM('info', 'warning', 'error', 'critical') NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `notification_channels` JSON DEFAULT NULL COMMENT '通知渠道',
  `db_types` JSON DEFAULT NULL COMMENT '适用的数据库类型，从关联指标继承；NULL=所有类型',
  `instance_ids` JSON DEFAULT NULL COMMENT '适用的实例ID列表，NULL=所有实例',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_enabled` (`enabled`),
  INDEX `idx_metric` (`metric_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 指标定义表
CREATE TABLE IF NOT EXISTS `metric_definitions` (
  `id` VARCHAR(64) NOT NULL COMMENT '指标 ID，如 cpu_usage',
  `name` VARCHAR(100) NOT NULL COMMENT '指标名称',
  `description` TEXT DEFAULT NULL,
  `unit` VARCHAR(20) NOT NULL COMMENT '单位：%, count, ops/s, score',
  `db_types` JSON NOT NULL COMMENT '支持的数据库类型',
  `aggregation` ENUM('avg', 'max', 'min', 'sum', 'last') NOT NULL DEFAULT 'avg',
  `default_interval` INT NOT NULL DEFAULT 60 COMMENT '默认采集间隔（秒）',
  `threshold_template` JSON DEFAULT NULL COMMENT '默认阈值模板 {warning, error, critical}',
  `is_collected` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '是否已启用采集',
  `is_builtin` BOOLEAN NOT NULL DEFAULT FALSE COMMENT '是否预定义指标（预定义指标不可删除）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_collected` (`is_collected`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '监控指标定义注册表';

-- 种子数据：预定义指标
INSERT IGNORE INTO `metric_definitions` (`id`, `name`, `description`, `unit`, `db_types`, `aggregation`, `default_interval`, `threshold_template`, `is_collected`, `is_builtin`) VALUES
('cpu_usage', 'CPU 使用率（估算）', '数据库实例的 CPU 使用率（基于线程数和活跃事务加权估算，非 OS 级真实 CPU）', '%', '["mysql", "postgresql"]', 'avg', 30, '{"warning": 80, "error": 90, "critical": 95}', TRUE, TRUE),
('memory_usage', '内存使用率（估算）', '数据库实例的内存使用率（基于 InnoDB buffer pool + key buffer 估算，非 OS 级真实内存）', '%', '["mysql", "postgresql"]', 'avg', 30, '{"warning": 80, "error": 90, "critical": 95}', TRUE, TRUE),
('disk_usage', '磁盘使用率（估算）', '数据库实例的磁盘使用率（基于 information_schema.tables 数据大小估算）', '%', '["mysql", "postgresql"]', 'last', 300, '{"warning": 75, "error": 85, "critical": 95}', TRUE, TRUE),
('connections', '活跃连接数', '当前活跃数据库连接数', 'count', '["mysql", "postgresql"]', 'max', 30, '{"warning": 80, "error": 150, "critical": 200}', TRUE, TRUE),
('qps', '每秒查询数', '数据库每秒处理的查询数量（delta 计算）', 'ops/s', '["mysql", "postgresql"]', 'avg', 30, '{"warning": 1000, "error": 5000, "critical": 10000}', TRUE, TRUE),
('tps', '每秒事务数', '数据库每秒处理的事务数量（delta 计算）', 'ops/s', '["mysql", "postgresql"]', 'avg', 30, '{"warning": 500, "error": 2000, "critical": 5000}', TRUE, TRUE),
('slow_queries', '慢查询数', '统计周期内的慢查询数量', 'count', '["mysql", "postgresql"]', 'sum', 300, '{"warning": 10, "error": 50, "critical": 100}', TRUE, TRUE),
('buffer_pool_hit_rate', '缓冲池命中率', 'InnoDB 缓冲池命中率（越高越好，仅 MySQL）', '%', '["mysql"]', 'avg', 30, '{"warning": 95, "error": 90, "critical": 80}', TRUE, TRUE),
('health_score', '健康评分', '数据库实例综合健康评分（越高越好）', 'score', '["mysql", "postgresql"]', 'last', 60, '{"warning": 70, "error": 50, "critical": 30}', TRUE, TRUE),
-- MySQL 扩增指标
('table_open_cache_hit_rate', '表缓存命中率', 'MySQL Table_open_cache 命中率（越高越好）', '%', '["mysql"]', 'avg', 30, '{"warning": 95, "error": 90, "critical": 80}', TRUE, TRUE),
('handler_read_rnd_next', '全表扫次数', 'MySQL Handler_read_rnd_next 累计值，高值提示大量全表扫', 'count', '["mysql"]', 'sum', 60, '{"warning": 100000, "error": 500000, "critical": 1000000}', TRUE, TRUE),
('handler_read_rnd_next_rate', '全表扫速率', 'MySQL 全表扫速率（次/秒）', 'ops/s', '["mysql"]', 'avg', 30, '{"warning": 100, "error": 500, "critical": 1000}', TRUE, TRUE),
('key_blocks_usage', 'Key Buffer 使用率', 'MySQL MyISAM key buffer 使用率', '%', '["mysql"]', 'avg', 30, '{"warning": 80, "error": 90, "critical": 95}', TRUE, TRUE),
('open_files', '打开文件数', 'MySQL 当前打开文件数', 'count', '["mysql"]', 'last', 60, '{"warning": 5000, "error": 8000, "critical": 10000}', TRUE, TRUE),
('aborted_connects', '拒绝连接数', 'MySQL 拒绝连接累计次数', 'count', '["mysql"]', 'sum', 60, '{"warning": 10, "error": 50, "critical": 100}', TRUE, TRUE),
('aborted_connects_rate', '拒绝连接速率', 'MySQL 拒绝连接速率（次/秒）', 'ops/s', '["mysql"]', 'avg', 30, '{"warning": 1, "error": 5, "critical": 10}', TRUE, TRUE),
-- PostgreSQL 扩增指标
('idx_scan_ratio', '索引扫描比例', 'PG 索引扫描占全部扫描的比例（越高越好）', '%', '["postgresql"]', 'avg', 60, '{"warning": 90, "error": 80, "critical": 50}', TRUE, TRUE),
('dead_tuples', '死元组数', 'PG 死元组总数（需要 vacuum 清理）', 'count', '["postgresql"]', 'last', 60, '{"warning": 10000, "error": 50000, "critical": 100000}', TRUE, TRUE),
('cache_hit_ratio', '缓冲命中率', 'PG shared_buffers 缓存命中率（越高越好）', '%', '["postgresql"]', 'avg', 30, '{"warning": 95, "error": 90, "critical": 80}', TRUE, TRUE),
('connections_used', '连接使用数', 'PG 当前使用连接数', 'count', '["postgresql"]', 'last', 30, '{"warning": 80, "error": 100, "critical": 150}', TRUE, TRUE),
('vacuum_count', 'Vacuum 次数', 'PG 手动 vacuum 运行次数', 'count', '["postgresql"]', 'sum', 300, '{"warning": 0, "error": 0, "critical": 0}', TRUE, TRUE),
('autovacuum_count', 'AutoVacuum 次数', 'PG 自动 vacuum 运行次数', 'count', '["postgresql"]', 'sum', 300, '{"warning": 0, "error": 0, "critical": 0}', TRUE, TRUE),
('replication_lag_seconds', '复制延迟', 'PG 主从复制延迟（秒）', 'seconds', '["postgresql"]', 'last', 30, '{"warning": 5, "error": 30, "critical": 60}', TRUE, TRUE),
-- 通用扩增指标
('data_size_gb', '数据大小', '数据库数据总大小（GB）', 'GB', '["mysql", "postgresql"]', 'last', 300, '{"warning": 100, "error": 500, "critical": 1000}', TRUE, TRUE);

-- 告警事件表
CREATE TABLE IF NOT EXISTS `alert_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_id` VARCHAR(64) NOT NULL UNIQUE COMMENT '事件唯一 ID (UUID)',
  `title` VARCHAR(200) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `status` ENUM('open', 'investigating', 'handled', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  `severity` ENUM('info', 'warning', 'error', 'critical', 'p0') NOT NULL,
  `source_type` VARCHAR(50) DEFAULT NULL COMMENT '事件来源类型',
  `source_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '来源记录 ID',
  `instance_id` INT UNSIGNED DEFAULT NULL,
  `triggered_by_rule_id` INT UNSIGNED DEFAULT NULL COMMENT '触发的告警规则 ID',
  `assigned_to` INT UNSIGNED DEFAULT NULL,
  `resolved_by` INT UNSIGNED DEFAULT NULL,
  `resolved_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_event_id` (`event_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_severity` (`severity`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '告警事件管理';

-- 告警事件成员表
CREATE TABLE IF NOT EXISTS `alert_event_members` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_id` BIGINT UNSIGNED NOT NULL,
  `alert_id` BIGINT UNSIGNED NOT NULL COMMENT '关联的原始告警 ID',
  `role` ENUM('triggered', 'related', 'correlated') NOT NULL DEFAULT 'triggered',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_event_alert` (`event_id`, `alert_id`),
  INDEX `idx_alert_id` (`alert_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '告警事件与原始告警的关联关系';

-- 升级规则表
CREATE TABLE IF NOT EXISTS `escalation_rules` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `from_level` ENUM('info', 'warning', 'error', 'critical', 'p0') NOT NULL,
  `to_level` ENUM('info', 'warning', 'error', 'critical', 'p0') NOT NULL,
  `trigger_condition` VARCHAR(100) NOT NULL COMMENT '触发条件，如: timeout_minutes',
  `trigger_value` INT NOT NULL,
  `notification_channel_ids` JSON DEFAULT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_from_level` (`from_level`),
  INDEX `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '告警升级规则';

-- 维护窗口表
CREATE TABLE IF NOT EXISTS `maintenance_windows` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `instance_id` INT UNSIGNED DEFAULT NULL COMMENT '适用的实例，NULL 表示全局',
  `day_of_week` VARCHAR(50) NOT NULL COMMENT '星期几，如: 1,2,3,4,5 或 *',
  `start_time` TIME NOT NULL,
  `end_time` TIME NOT NULL,
  `timezone` VARCHAR(50) NOT NULL DEFAULT 'Asia/Shanghai',
  `suppress_evaluation` BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'TRUE=不评估也不通知, FALSE=评估但不通知',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_enabled` (`enabled`),
  INDEX `idx_day` (`day_of_week`),
  INDEX `idx_instance` (`instance_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '维护窗口配置';

-- 静默期表
CREATE TABLE IF NOT EXISTS `silence_periods` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `metric_name` VARCHAR(100) NOT NULL,
  `silenced_until` DATETIME NOT NULL,
  `created_by_alert_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL COMMENT '手动创建静默的用户',
  `reason` TEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_metric_until` (`instance_id`, `metric_name`, `silenced_until`),
  INDEX `idx_silenced_until` (`silenced_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '告警静默期';

-- 告警事件日志表
CREATE TABLE IF NOT EXISTS `alert_event_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '关联事件 ID，单个告警操作为 NULL',
  `alert_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '关联告警 ID',
  `action` ENUM('escalated', 'assigned', 'unassigned', 'acknowledged', 'note_added', 'status_changed', 'resolved', 'closed', 'silenced') NOT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL COMMENT '操作人 ID',
  `details` JSON DEFAULT NULL COMMENT '操作详情',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_event_id` (`event_id`),
  INDEX `idx_action` (`action`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '告警事件操作日志';

-- 指标基线表
CREATE TABLE IF NOT EXISTS `metric_baselines` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `metric_name` VARCHAR(100) NOT NULL,
  `mean_val` DECIMAL(15,4) DEFAULT NULL,
  `stddev_val` DECIMAL(15,4) DEFAULT NULL,
  `lower_bound` DECIMAL(15,4) DEFAULT NULL COMMENT 'mean - sigma * stddev',
  `upper_bound` DECIMAL(15,4) DEFAULT NULL COMMENT 'mean + sigma * stddev',
  `sigma` DECIMAL(3,1) NOT NULL DEFAULT 2.0,
  `lookback_days` INT NOT NULL DEFAULT 7,
  `sample_count` INT DEFAULT NULL,
  `computed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_instance_metric` (`instance_id`, `metric_name`),
  INDEX `idx_computed_at` (`computed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '指标基线数据';

-- ============================================
-- 6. 故障诊断
-- ============================================

-- 故障诊断记录表
CREATE TABLE IF NOT EXISTS `fault_diagnoses` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `fault_type` ENUM('connection_storm', 'lock_contention', 'slow_query', 'replication_lag', 'disk_full', 'memory_pressure', 'cpu_spike', 'custom') NOT NULL,
  `fault_name` VARCHAR(200) NOT NULL,
  `severity` ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  `confidence` INT DEFAULT 80 COMMENT '置信度 %',
  `diagnosis` TEXT NOT NULL,
  `evidence` JSON DEFAULT NULL,
  `solution` TEXT DEFAULT NULL,
  `status` ENUM('pending', 'investigating', 'resolved', 'dismissed') NOT NULL DEFAULT 'pending',
  `auto_heal_possible` BOOLEAN DEFAULT FALSE,
  `actions_taken` JSON DEFAULT NULL,
  `healed` BOOLEAN DEFAULT FALSE,
  `healed_at` DATETIME DEFAULT NULL,
  `resolved_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_severity` (`severity`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 7. LLM 和 AI 配置
-- ============================================

-- LLM 提供商配置表
CREATE TABLE IF NOT EXISTS `llm_providers` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50) NOT NULL,
  `display_name` VARCHAR(100) NOT NULL,
  `deployment_type` ENUM('local', 'cloud', 'api') NOT NULL DEFAULT 'api' COMMENT '部署方式：local=本地，cloud=云服务，api=厂商 API',
  `api_key_encrypted` VARCHAR(255) DEFAULT NULL,
  `api_base_url` VARCHAR(255) DEFAULT NULL,
  `default_model` VARCHAR(100) DEFAULT NULL,
  `models_supported` JSON DEFAULT NULL COMMENT '支持的模型列表 JSON: [{"id":"qwen-plus","name":"Qwen-Plus","recommended":true}]',
  `context_window` INT DEFAULT 4096 COMMENT '最大上下文长度 (tokens)',
  `supports_function_call` BOOLEAN DEFAULT FALSE,
  `supports_vision` BOOLEAN DEFAULT FALSE,
  `input_cost_per_1k` DECIMAL(10,6) DEFAULT 0 COMMENT '每 1K 输入 token 价格 (USD)',
  `output_cost_per_1k` DECIMAL(10,6) DEFAULT 0 COMMENT '每 1K 输出 token 价格 (USD)',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `is_default` BOOLEAN NOT NULL DEFAULT FALSE,
  `temperature` DECIMAL(3,2) DEFAULT 0.7,
  `max_tokens` INT DEFAULT 2048,
  `timeout_ms` INT DEFAULT 30000,
  `rate_limit_per_minute` INT DEFAULT 60,
  `daily_quota` INT DEFAULT NULL COMMENT '每日 token 配额限制',
  `daily_quota_alert_threshold` INT DEFAULT 80 COMMENT '每日配额告警阈值 (%)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_name` (`name`),
  INDEX `idx_enabled` (`enabled`),
  INDEX `idx_is_default` (`is_default`),
  INDEX `idx_deployment_type` (`deployment_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- AI 对话历史记录表
CREATE TABLE IF NOT EXISTS `ai_chat_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(64) NOT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `instance_id` INT UNSIGNED DEFAULT NULL,
  `provider_id` INT UNSIGNED DEFAULT NULL COMMENT '使用的 LLM 提供商 ID',
  `role` ENUM('user', 'assistant', 'system') NOT NULL,
  `content` TEXT NOT NULL,
  `model` VARCHAR(100) DEFAULT NULL,
  `tokens_used` INT DEFAULT 0,
  `input_tokens` INT DEFAULT 0,
  `output_tokens` INT DEFAULT 0,
  `cost_usd` DECIMAL(10,6) DEFAULT 0 COMMENT '本次调用成本 (USD)',
  `duration_ms` INT DEFAULT 0,
  `purpose` VARCHAR(50) DEFAULT NULL COMMENT '调用目的：sql_analysis, fault_diagnosis, health_check, chat',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_session_id` (`session_id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_provider_id` (`provider_id`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 7b. LLM 用量追踪
-- ============================================

-- LLM 用量记录表（明细）
CREATE TABLE IF NOT EXISTS `llm_usage_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_id` INT UNSIGNED NOT NULL,
  `provider_name` VARCHAR(50) NOT NULL,
  `model` VARCHAR(100) NOT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `session_id` VARCHAR(64) NOT NULL,
  `instance_id` INT UNSIGNED DEFAULT NULL,
  `input_tokens` INT NOT NULL DEFAULT 0,
  `output_tokens` INT NOT NULL DEFAULT 0,
  `total_tokens` INT NOT NULL DEFAULT 0,
  `cost_usd` DECIMAL(10,6) DEFAULT 0,
  `duration_ms` INT DEFAULT 0,
  `status` ENUM('success', 'error') NOT NULL DEFAULT 'success',
  `error_message` TEXT DEFAULT NULL,
  `purpose` VARCHAR(50) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_provider_id` (`provider_id`),
  INDEX `idx_provider_name` (`provider_name`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_session_id` (`session_id`),
  INDEX `idx_created_at` (`created_at`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- LLM 每日用量统计表
CREATE TABLE IF NOT EXISTS `llm_usage_daily_stats` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_id` INT UNSIGNED NOT NULL,
  `provider_name` VARCHAR(50) NOT NULL,
  `model` VARCHAR(100) NOT NULL,
  `date` DATE NOT NULL,
  `total_requests` INT NOT NULL DEFAULT 0,
  `total_input_tokens` BIGINT NOT NULL DEFAULT 0,
  `total_output_tokens` BIGINT NOT NULL DEFAULT 0,
  `total_tokens` BIGINT NOT NULL DEFAULT 0,
  `total_cost_usd` DECIMAL(10,6) DEFAULT 0,
  `failed_requests` INT DEFAULT 0,
  `avg_duration_ms` INT DEFAULT 0,
  `unique_users` INT DEFAULT 0 COMMENT '独立用户数',
  `unique_sessions` INT DEFAULT 0 COMMENT '独立会话数',
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_provider_date_model` (`provider_id`, `date`, `model`),
  INDEX `idx_date` (`date`),
  INDEX `idx_provider_name` (`provider_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- LLM 配额告警配置表
CREATE TABLE IF NOT EXISTS `llm_quota_alerts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_id` INT UNSIGNED NOT NULL,
  `alert_type` ENUM('daily_quota', 'cost_limit', 'rate_limit') NOT NULL,
  `threshold_value` DECIMAL(10,2) NOT NULL COMMENT '阈值 (百分比或金额)',
  `notification_channel_ids` JSON DEFAULT NULL COMMENT '通知渠道 ID 列表',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `last_triggered_at` DATETIME DEFAULT NULL,
  `trigger_count_today` INT DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_provider_id` (`provider_id`),
  INDEX `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 7c. AI 分析
-- ============================================

-- AI 分析记录表
CREATE TABLE IF NOT EXISTS `ai_analysis` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `analysis_type` ENUM('topsql_analysis', 'alert_rca', 'fault_diagnosis', 'capacity_prediction', 'sql_audit', 'log_analysis') NOT NULL,
  `instance_id` INT UNSIGNED NOT NULL,
  `related_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '关联的 slow_query_id / alert_id / diagnosis_id',
  `status` ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  `trigger_type` ENUM('manual', 'auto') NOT NULL DEFAULT 'manual',
  `cache_key` VARCHAR(255) DEFAULT NULL COMMENT '缓存键：sql_hash:instance_id 或 alert_id:instance_id',
  `result` JSON DEFAULT NULL COMMENT 'LLM 分析结果',
  `error_message` TEXT DEFAULT NULL,
  `usage` JSON DEFAULT NULL COMMENT 'LLM 用量: {input_tokens, output_tokens, cost_usd, provider, model}',
  `duration_ms` INT DEFAULT NULL,
  `ttl_minutes` INT NOT NULL DEFAULT 1440 COMMENT '缓存 TTL，默认 24 小时',
  `started_at` DATETIME DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_analysis_type` (`analysis_type`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_cache_key` (`cache_key`),
  INDEX `idx_created_at` (`created_at` DESC),
  INDEX `idx_cache_status` (`cache_key`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'AI 分析记录：TopSQL 分析、告警根因分析、故障诊断、容量预测、SQL审核';

-- SQL 审核记录表
CREATE TABLE IF NOT EXISTS `sql_audit_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `sql_text` TEXT NOT NULL COMMENT '待审核的 SQL 语句',
  `sql_hash` VARCHAR(64) DEFAULT NULL COMMENT 'SQL 哈希（去重）',
  `audit_level` ENUM('info', 'warning', 'error') NOT NULL DEFAULT 'info' COMMENT '审核级别',
  `risk_level` ENUM('P0', 'P1', 'P2') NOT NULL DEFAULT 'P2' COMMENT '风险等级',
  `status` ENUM('pending', 'running', 'completed', 'failed', 'reviewed') NOT NULL DEFAULT 'pending',
  `reviewer_id` INT UNSIGNED DEFAULT NULL COMMENT 'DBA 审核人 ID',
  `review_comment` TEXT DEFAULT NULL COMMENT 'DBA 补充意见',
  `created_by` VARCHAR(100) DEFAULT NULL COMMENT '提交人',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_risk_level` (`risk_level`),
  INDEX `idx_sql_hash` (`sql_hash`),
  INDEX `idx_created_at` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'SQL 审核记录：用户提交的事前审核请求';

-- 数据库错误日志表
CREATE TABLE IF NOT EXISTS `database_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `log_level` ENUM('info', 'warning', 'error', 'critical') NOT NULL DEFAULT 'info' COMMENT '日志级别',
  `source` ENUM('mysql_slow', 'mysql_error', 'pg_log', 'other') NOT NULL DEFAULT 'other' COMMENT '日志来源',
  `message` TEXT NOT NULL COMMENT '日志消息（截断版）',
  `raw_content` TEXT COMMENT '原始日志内容',
  `detected_patterns` JSON DEFAULT NULL COMMENT '检测到的错误模式: [{pattern, severity, message}]',
  `collected_at` DATETIME NOT NULL COMMENT '日志在原数据库中的时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_log_level` (`log_level`),
  INDEX `idx_collected_at` (`collected_at` DESC),
  INDEX `idx_instance_collected` (`instance_id`, `collected_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '数据库错误日志：通过 SQL 查询采集的 MySQL/PostgreSQL 错误日志';

-- ============================================
-- 8. 通知渠道
-- ============================================

-- 通知渠道表
CREATE TABLE IF NOT EXISTS `notification_channels` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `type` ENUM('email', 'dingtalk', 'wecom', 'feishu', 'webhook') NOT NULL,
  `config` JSON NOT NULL COMMENT '渠道配置，如 webhook URL、secret 等',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_type` (`type`),
  INDEX `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 通知记录表
CREATE TABLE IF NOT EXISTS `notification_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `alert_id` BIGINT UNSIGNED NOT NULL,
  `channel_id` INT UNSIGNED NOT NULL,
  `status` ENUM('pending', 'sent', 'failed', 'suppressed') NOT NULL DEFAULT 'pending',
  `error` TEXT DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_alert_id` (`alert_id`),
  INDEX `idx_channel_id` (`channel_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 9. 技能（Skills）管理
-- ============================================

-- 技能配置表
CREATE TABLE IF NOT EXISTS `skills` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL UNIQUE,
  `display_name` VARCHAR(100) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `category` VARCHAR(50) DEFAULT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `config_schema` JSON DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_enabled` (`enabled`),
  INDEX `idx_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 技能执行记录表
CREATE TABLE IF NOT EXISTS `skill_executions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `skill_id` INT UNSIGNED NOT NULL,
  `execution_id` VARCHAR(64) NOT NULL UNIQUE,
  `instance_id` INT UNSIGNED DEFAULT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `status` ENUM('pending', 'running', 'completed', 'failed') NOT NULL,
  `progress` INT DEFAULT 0,
  `message` VARCHAR(500) DEFAULT NULL,
  `args` JSON DEFAULT NULL,
  `result` JSON DEFAULT NULL,
  `error` TEXT DEFAULT NULL,
  `started_at` DATETIME DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_skill_id` (`skill_id`),
  INDEX `idx_execution_id` (`execution_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 10. 报告和报表
-- ============================================

-- 报告表
CREATE TABLE IF NOT EXISTS `reports` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `type` ENUM('health', 'performance', 'slow_query', 'capacity', 'audit', 'custom') NOT NULL,
  `format` ENUM('pdf', 'html', 'json', 'csv') NOT NULL DEFAULT 'html',
  `instance_id` INT UNSIGNED DEFAULT NULL,
  `content` LONGTEXT DEFAULT NULL,
  `data` JSON DEFAULT NULL,
  `generated_by` INT UNSIGNED DEFAULT NULL,
  `status` ENUM('pending', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  `scheduled_at` DATETIME DEFAULT NULL,
  `expires_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_type` (`type`),
  INDEX `idx_instance_id` (`instance_id`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 11. 系统配置
-- ============================================

-- 系统配置表
CREATE TABLE IF NOT EXISTS `system_config` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `config_key` VARCHAR(100) NOT NULL UNIQUE,
  `config_value` TEXT NOT NULL,
  `value_type` ENUM('string', 'number', 'boolean', 'json') NOT NULL DEFAULT 'string',
  `description` VARCHAR(500) DEFAULT NULL,
  `updated_by` INT UNSIGNED DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_config_key` (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 初始化数据
-- ============================================

-- 插入默认管理员账户 (密码：Tpam1234)
-- !!! 安全警告：以下使用 SHA-256 哈希，不适用于生产环境 !!!
-- TODO: 改为在应用初始化代码中使用 bcrypt 创建用户（参见 apps/db-ops-api/CLAUDE.md 认证章节）
-- 测试/开发环境下保留以下种子数据以支持 init-db.ts 引导
-- 密码使用 SHA256 哈希：4f32fc2ba7f8dfa43328d1ee7e5eb7607c78ab2e73c5cd001979aeaf5532c817
INSERT INTO `users` (`username`, `password_hash`, `email`, `status`, `role_backup`) VALUES
('admin', '4f32fc2ba7f8dfa43328d1ee7e5eb7607c78ab2e73c5cd001979aeaf5532c817', 'admin@example.com', 'active', 'admin'),
('user', '4f32fc2ba7f8dfa43328d1ee7e5eb7607c78ab2e73c5cd001979aeaf5532c817', 'user@example.com', 'active', 'viewer');

-- 插入默认 LLM 提供商配置
INSERT INTO `llm_providers` (`name`, `display_name`, `deployment_type`, `default_model`, `models_supported`, `context_window`, `supports_function_call`, `supports_vision`, `input_cost_per_1k`, `output_cost_per_1k`, `enabled`, `is_default`, `temperature`, `max_tokens`) VALUES
('aliyun', '阿里云百炼', 'cloud', 'qwen-plus',
 '[{"id":"qwen-plus","name":"Qwen-Plus","recommended":true,"desc":"平衡性能与成本"},{"id":"qwen-max","name":"Qwen-Max","desc":"最强性能"},{"id":"qwen-turbo","name":"Qwen-Turbo","desc":"快速响应"},{"id":"qwen-long","name":"Qwen-Long","desc":"长文本处理"}]',
 128000, TRUE, FALSE, 0.002, 0.006, TRUE, TRUE, 0.70, 2048),
('ollama', 'Ollama 本地', 'local', 'qwen2.5-coder:32b',
 '[{"id":"qwen2.5-coder:32b","name":"Qwen2.5-Coder 32B","desc":"代码生成"},{"id":"qwen2.5:32b","name":"Qwen2.5 32B","desc":"通用对话"},{"id":"deepseek-coder:33b","name":"DeepSeek-Coder 33B","desc":"代码专用"},{"id":"llama3.1:70b","name":"Llama 3.1 70B","desc":"Meta 开源"}]',
 32768, TRUE, FALSE, 0, 0, FALSE, FALSE, 0.70, 2048),
('kimi', 'Kimi 月之暗面', 'cloud', 'moonshot-v1-8k',
 '[{"id":"moonshot-v1-8k","name":"Moonshot-v1-8k","desc":"8K 上下文"},{"id":"moonshot-v1-32k","name":"Moonshot-v1-32K","desc":"32K 上下文"},{"id":"moonshot-v1-128k","name":"Moonshot-v1-128K","desc":"128K 上下文"}]',
 128000, FALSE, FALSE, 0.005, 0.015, FALSE, FALSE, 0.70, 2048),
('anthropic', 'Anthropic Claude', 'api', 'claude-sonnet-4-6',
 '[{"id":"claude-sonnet-4-6","name":"Claude Sonnet 4.6","recommended":true,"desc":"性价比最高"},{"id":"claude-opus-4-6","name":"Claude Opus 4.6","desc":"最强性能"},{"id":"claude-haiku-4-5","name":"Claude Haiku 4.5","desc":"快速轻量"}]',
 200000, TRUE, TRUE, 0.003, 0.015, FALSE, FALSE, 0.70, 2048),
('openai', 'OpenAI GPT', 'api', 'gpt-4.1',
 '[{"id":"gpt-4.1","name":"GPT-4.1","recommended":true,"desc":"最新模型"},{"id":"gpt-4.1-mini","name":"GPT-4.1 Mini","desc":"轻量版"},{"id":"gpt-4-turbo","name":"GPT-4 Turbo","desc":"快速"},{"id":"o3-pro","name":"o3 Pro","desc":"推理最强"}]',
 128000, TRUE, TRUE, 0.005, 0.015, FALSE, FALSE, 0.70, 2048),
('deepseek', '深度求索', 'api', 'deepseek-chat',
 '[{"id":"deepseek-chat","name":"DeepSeek Chat","recommended":true,"desc":"对话模型"},{"id":"deepseek-coder","name":"DeepSeek Coder","desc":"代码模型"}]',
 128000, TRUE, FALSE, 0.001, 0.002, FALSE, FALSE, 0.70, 2048);

-- 插入默认技能配置
INSERT INTO `skills` (`name`, `display_name`, `description`, `category`, `enabled`) VALUES
('check_slow_queries', '慢查询分析', '分析慢查询并提供优化建议', '性能优化', TRUE),
('health_check', '健康检查', '检查数据库实例健康状态', '健康检查', TRUE),
('index_recommend', '索引推荐', '基于查询模式推荐索引', '性能优化', TRUE),
('backup_status', '备份检查', '检查数据库备份状态', '运维检查', TRUE),
('connection_analysis', '连接分析', '分析当前连接和会话状态', '性能优化', TRUE),
('table_stats', '表统计', '获取数据表统计信息', '运维检查', TRUE),
('replication_check', '复制检查', '检查主从复制状态', '健康检查', FALSE);

-- 插入默认告警规则
INSERT INTO `alert_rules` (`name`, `description`, `metric_name`, `operator`, `threshold`, `duration_seconds`, `severity`) VALUES
('CPU 使用率过高', 'CPU 使用率超过 80%', 'cpu_usage', '>', 80.00, 300, 'warning'),
('内存使用率过高', '内存使用率超过 85%', 'memory_usage', '>', 85.00, 300, 'warning'),
('连接数过多', '连接数超过 100', 'connections', '>', 100.00, 60, 'warning'),
('QPS 过高', '每秒查询数超过 5000', 'qps', '>', 5000.00, 60, 'warning'),
('慢查询过多', '慢查询数量超过 10', 'slow_queries', '>', 10.00, 300, 'warning'),
('健康分数过低', '健康分数低于 60', 'health_score', '<', 60.00, 0, 'critical');

-- 插入系统配置
INSERT INTO `system_config` (`config_key`, `config_value`, `value_type`, `description`) VALUES
('system.name', '数据库智能运维系统', 'string', '系统名称'),
('system.version', '1.0.0', 'string', '系统版本'),
('auth.jwt_expiration_minutes', '1440', 'number', 'JWT 令牌过期时间（分钟）'),
('monitor.collect_interval_seconds', '30', 'number', '监控采集间隔'),
('monitor.history_retention_days', '30', 'number', '监控历史保留天数'),
('alert.enabled', 'true', 'boolean', '是否启用告警'),
('notification.dingtalk_enabled', 'false', 'boolean', '钉钉通知是否启用'),
('notification.wecom_enabled', 'false', 'boolean', '企业微信通知是否启用'),
('notification.feishu_enabled', 'false', 'boolean', '飞书通知是否启用'),
('ai_analysis.default_ttl_minutes', '1440', 'number', 'AI 分析结果默认缓存时长（分钟），默认 24 小时');

-- ============================================
-- 9. Chat 会话管理（新增）
-- ============================================

-- Chat 会话表
CREATE TABLE IF NOT EXISTS `chat_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(100) NOT NULL UNIQUE COMMENT '会话 UUID',
  `user_id` INT UNSIGNED DEFAULT NULL COMMENT '所属用户 ID',
  `title` VARCHAR(200) NOT NULL COMMENT '会话标题',
  `instance_id` INT UNSIGNED DEFAULT NULL COMMENT '关联的数据库实例',
  `message_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '消息数量',
  `last_message_at` DATETIME DEFAULT NULL COMMENT '最后消息时间',
  `metadata` JSON DEFAULT NULL COMMENT '元数据',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_session_id` (`session_id`),
  INDEX `idx_last_message` (`last_message_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chat 消息表
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(100) NOT NULL COMMENT '会话 ID',
  `message_id` VARCHAR(100) NOT NULL UNIQUE COMMENT '消息 UUID',
  `parent_id` VARCHAR(100) DEFAULT NULL COMMENT 'Parent message ID for DAG/chained structure',
  `role` ENUM('user', 'assistant', 'system') NOT NULL COMMENT '消息角色',
  `content` TEXT NOT NULL COMMENT '消息内容',
  `related_tool` VARCHAR(100) DEFAULT NULL COMMENT '关联的工具',
  `related_skill` VARCHAR(100) DEFAULT NULL COMMENT '关联的技能',
  `metadata` JSON DEFAULT NULL COMMENT '元数据（模型、用量等）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_message_id` (`message_id`),
  INDEX `idx_session_id` (`session_id`),
  INDEX `idx_session_parent` (`session_id`, `parent_id`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Chat messages with DAG-compatible parent_id DAG support';

-- ============================================
-- 10. Skill 执行历史（用于模式挖掘）
-- ============================================

-- Skill 执行历史表
CREATE TABLE IF NOT EXISTS `skill_execution_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(100) NOT NULL COMMENT '会话 ID',
  `user_id` INT UNSIGNED DEFAULT NULL COMMENT '用户 ID',
  `tool_name` VARCHAR(100) NOT NULL COMMENT '工具名称',
  `input_params` JSON DEFAULT NULL COMMENT '输入参数',
  `output_result` JSON DEFAULT NULL COMMENT '输出结果',
  `success` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '是否成功',
  `error_message` TEXT DEFAULT NULL COMMENT '错误信息',
  `duration_ms` INT DEFAULT NULL COMMENT '执行时长（毫秒）',
  `executed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '执行时间',
  PRIMARY KEY (`id`),
  INDEX `idx_session_id` (`session_id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_tool_name` (`tool_name`),
  INDEX `idx_executed_at` (`executed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 技能使用模式表（预计算的模式统计）
CREATE TABLE IF NOT EXISTS `skill_usage_patterns` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pattern_key` VARCHAR(255) NOT NULL UNIQUE COMMENT '模式键（工具序列）',
  `tools` JSON NOT NULL COMMENT '工具列表',
  `sequence` JSON NOT NULL COMMENT '工具调用顺序',
  `frequency` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '出现频率',
  `avg_execution_time_ms` INT DEFAULT NULL COMMENT '平均执行时间',
  `success_rate` DECIMAL(5,4) DEFAULT NULL COMMENT '成功率',
  `last_detected_at` DATETIME DEFAULT NULL COMMENT '最后检测时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_pattern_key` (`pattern_key`),
  INDEX `idx_frequency` (`frequency`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 自动生成的技能表
CREATE TABLE IF NOT EXISTS `generated_skills` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL UNIQUE COMMENT '技能名称',
  `description` TEXT NOT NULL COMMENT '技能描述',
  `source` ENUM('intent', 'pattern', 'manual') NOT NULL COMMENT '来源类型',
  `skill_markdown` TEXT DEFAULT NULL COMMENT 'SKILL.md 内容',
  `tool_code` TEXT DEFAULT NULL COMMENT '工具代码',
  `tools` JSON NOT NULL COMMENT '工具定义列表',
  `pattern_key` VARCHAR(255) DEFAULT NULL COMMENT '关联的模式键',
  `confidence` DECIMAL(5,4) DEFAULT NULL COMMENT '置信度',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '是否启用',
  `created_by` INT UNSIGNED DEFAULT NULL COMMENT '创建者',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_name` (`name`),
  INDEX `idx_source` (`source`),
  INDEX `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 11. 表结构管理（Schema Management）
-- ============================================

-- 表结构快照表
CREATE TABLE IF NOT EXISTS `schema_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `snapshot_time` DATETIME NOT NULL DEFAULT NOW(),
  `table_name` VARCHAR(128) NOT NULL,
  `column_name` VARCHAR(128) NOT NULL,
  `column_type` VARCHAR(128) NOT NULL,
  `is_nullable` VARCHAR(3) DEFAULT 'YES',
  `column_default` TEXT DEFAULT NULL,
  `column_key` VARCHAR(8) DEFAULT '',
  `extra` VARCHAR(32) DEFAULT '',
  `column_comment` TEXT DEFAULT NULL,
  `table_comment` TEXT DEFAULT NULL,
  `table_rows` BIGINT DEFAULT 0,
  `data_length` BIGINT DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_time` (`instance_id`, `snapshot_time`),
  INDEX `idx_instance_table` (`instance_id`, `table_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='表结构快照数据';

-- ============================================
-- 12. 索引管理（Index Management）
-- ============================================

-- 索引信息表
CREATE TABLE IF NOT EXISTS `index_info` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `table_name` VARCHAR(128) NOT NULL,
  `index_name` VARCHAR(128) NOT NULL,
  `column_name` VARCHAR(128) NOT NULL,
  `seq_in_index` INT DEFAULT 0,
  `non_unique` TINYINT DEFAULT 1,
  `cardinality` BIGINT DEFAULT 0,
  `sub_part` INT COMMENT '前缀索引长度',
  `nullable` VARCHAR(3) DEFAULT 'YES',
  `index_type` VARCHAR(16) DEFAULT 'BTREE',
  `comment` TEXT,
  `collected_at` DATETIME DEFAULT NOW(),
  `is_unused` BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_table` (`instance_id`, `table_name`),
  UNIQUE KEY `idx_instance_table_col_seq` (`instance_id`, `table_name`, `index_name`, `column_name`, `seq_in_index`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='索引信息采集数据';

-- 索引冗余报告表
CREATE TABLE IF NOT EXISTS `index_redundancy_report` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `table_name` VARCHAR(128) NOT NULL,
  `redundant_index` VARCHAR(128) NOT NULL,
  `covered_by_index` VARCHAR(128) NOT NULL,
  `reason` TEXT NOT NULL,
  `created_at` DATETIME DEFAULT NOW(),
  PRIMARY KEY (`id`),
  INDEX `idx_instance_table` (`instance_id`, `table_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='索引冗余检测报告';

-- ============================================
-- Phase 06 Schema Migration
-- ============================================

-- 扩展 alert_rules 表：添加动态阈值支持
ALTER TABLE `alert_rules` ADD COLUMN `threshold_type` ENUM('static', 'dynamic') NOT NULL DEFAULT 'static' COMMENT '静态/动态阈值' AFTER `severity`;
ALTER TABLE `alert_rules` ADD COLUMN `dynamic_config` JSON DEFAULT NULL COMMENT '动态阈值配置 {metric, sigma, lookback_days, aggregation}' AFTER `threshold_type`;
ALTER TABLE `alert_rules` ADD COLUMN `silence_minutes` INT NOT NULL DEFAULT 5 COMMENT '告警触发后自动静默时长（分钟）' AFTER `dynamic_config`;

-- 容量历史表
CREATE TABLE IF NOT EXISTS `capacity_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `total_size_gb` DECIMAL(10,2) DEFAULT 0 COMMENT '总容量 GB',
  `db_count` INT DEFAULT 0 COMMENT '数据库数量',
  `table_count` INT DEFAULT 0 COMMENT '总表数量',
  `recorded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_instance_time` (`instance_id`, `recorded_at`),
  INDEX `idx_recorded_at` (`recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='容量历史数据';

-- 容量数据库明细表
CREATE TABLE IF NOT EXISTS `capacity_databases` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `capacity_id` BIGINT UNSIGNED NOT NULL COMMENT '关联 capacity_history.id',
  `instance_id` INT UNSIGNED NOT NULL,
  `db_name` VARCHAR(128) NOT NULL,
  `size_gb` DECIMAL(10,2) DEFAULT 0,
  `table_count` INT DEFAULT 0,
  `recorded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_capacity_id` (`capacity_id`),
  INDEX `idx_instance_time` (`instance_id`, `recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='容量数据库明细';

-- 扩展 alerts 表：添加 p0 级别
ALTER TABLE `alerts` MODIFY COLUMN `level` ENUM('info', 'warning', 'error', 'critical', 'p0') NOT NULL COMMENT '告警级别';

-- SQL 审批请求表
CREATE TABLE IF NOT EXISTS `approval_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance_id` INT UNSIGNED NOT NULL,
  `sql_text` TEXT NOT NULL,
  `sql_hash` VARCHAR(64) NOT NULL,
  `risk_level` ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'low',
  `ai_recommendation` JSON DEFAULT NULL COMMENT 'LLM 评估 {risk_level, recommendation, reasoning}',
  `status` ENUM('pending', 'approved', 'rejected', 'executed', 'cancelled') NOT NULL DEFAULT 'pending',
  `submitted_by` INT UNSIGNED DEFAULT NULL,
  `reviewed_by` INT UNSIGNED DEFAULT NULL,
  `review_notes` TEXT DEFAULT NULL,
  `execution_result` JSON DEFAULT NULL COMMENT '{columns, rowCount, duration_ms}',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_submitted_by` (`submitted_by`),
  INDEX `idx_instance_id` (`instance_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phase 10: AI 分析扩展
ALTER TABLE ai_analysis ADD COLUMN session_key VARCHAR(128) DEFAULT NULL;
ALTER TABLE ai_analysis ADD COLUMN cache_ttl_minutes INT DEFAULT NULL;

-- Phase 87: Approval Enhancement - Approval Events Timeline
CREATE TABLE IF NOT EXISTS `approval_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` BIGINT UNSIGNED NOT NULL,
  `event_type` ENUM('submitted','ai_reviewed','approved','rejected','executed','execution_failed','notified') NOT NULL,
  `event_data` JSON DEFAULT NULL COMMENT 'Event-specific payload (risk_level for ai_reviewed, {rows,duration} for executed)',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_request_id` (`request_id`),
  INDEX `idx_event_type` (`event_type`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- RBAC (Phase 84) — 基于角色的权限控制
-- ============================================

-- Role-Based Access Control tables
CREATE TABLE IF NOT EXISTS `roles` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50) NOT NULL UNIQUE,
  `description` VARCHAR(255) DEFAULT NULL,
  `is_system` BOOLEAN NOT NULL DEFAULT FALSE COMMENT '系统角色不可删除',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `permissions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(100) NOT NULL UNIQUE COMMENT 'resource:action 格式',
  `name` VARCHAR(100) NOT NULL COMMENT '权限名称',
  `description` VARCHAR(255) DEFAULT NULL,
  `resource` VARCHAR(50) NOT NULL COMMENT '资源类别',
  `action` VARCHAR(50) NOT NULL COMMENT '操作类型',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_code` (`code`),
  INDEX `idx_resource` (`resource`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `role_permissions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `role_id` INT UNSIGNED NOT NULL,
  `permission_id` INT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_permission` (`role_id`, `permission_id`),
  CONSTRAINT `fk_rp_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rp_permission` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_roles` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `role_id` INT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_role` (`user_id`, `role_id`),
  CONSTRAINT `fk_ur_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ur_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `instance_permissions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `instance_id` INT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_instance` (`user_id`, `instance_id`),
  CONSTRAINT `fk_ip_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ip_instance` FOREIGN KEY (`instance_id`) REFERENCES `database_instances`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed system roles
INSERT IGNORE INTO `roles` (`name`, `description`, `is_system`) VALUES
('admin',     '超级管理员，拥有所有权限', TRUE),
('dba',       '数据库管理员，拥有运维相关权限', TRUE),
('developer', '开发人员，SQL 分析和优化权限', TRUE),
('analyst',   '分析师，只读和分析权限', TRUE),
('viewer',    '访客，基础查看权限', TRUE),
('auditor',   '审计员，查看 + 审计日志权限', TRUE);

-- Seed permission codes (resource:action format)
INSERT IGNORE INTO `permissions` (`code`, `name`, `description`, `resource`, `action`) VALUES
('instance:view',   '查看实例',    '查看数据库实例列表和详情', 'instance', 'view'),
('instance:create', '创建实例',    '创建新的数据库实例', 'instance', 'create'),
('instance:update', '更新实例',    '更新数据库实例配置', 'instance', 'update'),
('instance:delete', '删除实例',    '删除数据库实例', 'instance', 'delete'),
('instance:query',  '执行查询',    '在实例上执行 SQL 查询', 'instance', 'query'),
('instance:manage', '管理实例',    '重载连接、采集容量等管理操作', 'instance', 'manage'),
('user:view',   '查看用户',   '查看用户列表', 'user', 'view'),
('user:create', '创建用户',   '创建新用户', 'user', 'create'),
('user:update', '修改用户',   '修改用户信息', 'user', 'update'),
('user:delete', '删除用户',   '删除用户', 'user', 'delete'),
('notification:view',   '查看通知渠道',   '查看通知渠道列表', 'notification', 'view'),
('notification:manage', '管理通知渠道',   '创建/修改/删除/测试通知渠道', 'notification', 'manage'),
('llm:view',   '查看 LLM',   '查看 LLM 提供商配置', 'llm', 'view'),
('llm:manage', '管理 LLM',   '创建/修改/删除 LLM 配置', 'llm', 'manage'),
('alert:view',   '查看告警',   '查看告警列表和详情', 'alert', 'view'),
('alert:manage', '管理告警',   '确认/解决/删除告警', 'alert', 'manage'),
('approval:view',   '查看审批',   '查看审批请求', 'approval', 'view'),
('approval:approve','审批操作',   '审批/驳回 SQL 执行请求', 'approval', 'approve'),
('report:view',   '查看报告',   '查看报告列表', 'report', 'view'),
('report:create', '生成报告',   '生成新报告', 'report', 'create'),
('report:export', '导出报告',   '导出/下载报告', 'report', 'export'),
('metric:view',   '查看指标',   '查看指标注册表和监控数据', 'metric', 'view'),
('metric:manage', '管理指标',   '创建/修改指标定义', 'metric', 'manage'),
	('metric:write',  '管理自定义指标',  '创建/编辑/删除自定义指标定义', 'metric', 'write'),
('schema:view',   '查看表结构', '查看数据库表结构信息', 'schema', 'view'),
('schema:manage', '管理表结构', '创建/修改表结构', 'schema', 'manage'),
('index:view',   '查看索引',   '查看索引信息', 'index', 'view'),
('index:manage', '管理索引',   '创建/删除索引', 'index', 'manage'),
('chat:view',   '查看聊天',   '查看聊天历史', 'chat', 'view'),
('chat:delete', '删除聊天',   '删除聊天记录', 'chat', 'delete'),
('config:view',   '查看配置',   '查看系统配置', 'config', 'view'),
('config:manage', '管理配置',   '修改系统配置', 'config', 'manage'),
('audit:view',   '查看审计',   '查看审计日志', 'audit', 'view'),
('audit:export', '导出审计',   '导出审计日志', 'audit', 'export'),
('collector:view',   '查看采集任务',   '查看采集任务状态', 'collector', 'view'),
('collector:manage', '管理采集任务',   '启动/停止采集任务', 'collector', 'manage'),
('*',            '所有权限',   '通配符，匹配所有操作', 'system', '*');

-- Seed role-permission mappings (using INSERT IGNORE for idempotency)
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.code = '*';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'dba' AND p.code IN (
  'instance:view','instance:create','instance:update','instance:delete','instance:query','instance:manage',
  'user:view','notification:view','llm:view','alert:view','alert:manage',
  'approval:view','approval:approve','metric:view','metric:manage','metric:write',
  'schema:view','schema:manage','index:view','index:manage',
  'report:view','report:create','report:export','config:view','audit:view',
  'collector:view','collector:manage'
);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'developer' AND p.code IN (
  'instance:view','instance:query','instance:update','alert:view','approval:view',
  'schema:view','index:view','metric:view','report:view','llm:view','config:view'
);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'analyst' AND p.code IN (
  'instance:view','instance:query','alert:view','metric:view','report:view','schema:view','config:view'
);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'viewer' AND p.code IN (
  'instance:view','alert:view','metric:view'
);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'auditor' AND p.code IN (
  'instance:view','alert:view','metric:view','report:view','config:view','audit:view','audit:export'
);

-- ============================================
-- 13. SQL 执行历史
-- ============================================

-- SQL 执行历史表（Phase 97）
CREATE TABLE IF NOT EXISTS `sql_execution_history` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT DEFAULT NULL,
  `username` VARCHAR(100) DEFAULT NULL,
  `instance_id` INT DEFAULT NULL,
  `instance_name` VARCHAR(200) DEFAULT NULL,
  `db_type` VARCHAR(20) DEFAULT NULL,
  `database_name` VARCHAR(100) DEFAULT NULL,
  `sql_text` TEXT,
  `status` VARCHAR(20) DEFAULT 'success',
  `duration_ms` INT DEFAULT 0,
  `row_count` INT DEFAULT 0,
  `error_message` TEXT DEFAULT NULL,
  `ip_address` VARCHAR(45) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_instance_id (instance_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  FULLTEXT INDEX idx_sql_text (sql_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================
-- 14. Phase 106: 指标采集可配置化 - Schema 变更
-- ============================================

-- metric_definitions 新列
ALTER TABLE metric_definitions
  ADD COLUMN `collection_sql` TEXT DEFAULT NULL COMMENT '自定义采集 SQL（用户自定义指标用）' AFTER `threshold_template`,
  ADD COLUMN `value_type` ENUM('gauge', 'counter', 'histogram') NOT NULL DEFAULT 'gauge' COMMENT '指标值类型' AFTER `collection_sql`,
  ADD COLUMN `category` VARCHAR(50) DEFAULT NULL COMMENT '指标分类标签' AFTER `value_type`,
  ADD COLUMN `updated_by` INT UNSIGNED DEFAULT NULL COMMENT '最后修改人用户 ID' AFTER `category`,
  ADD INDEX `idx_category` (`category`);

-- metrics_history 追加 JSON 列
ALTER TABLE metrics_history
  ADD COLUMN `metrics_data` JSON DEFAULT NULL COMMENT '动态指标数据（自定义指标写入此列，与固定列双轨并行）' AFTER `is_estimated`;

-- 为 DBA 角色追加 metric:write 权限（INSERT IGNORE 确保幂等）
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'dba' AND p.code = 'metric:write';

-- ============================================
-- 16. 指标模板系统 (Phase: metric-templates)
-- ============================================

-- 指标模板定义表
CREATE TABLE IF NOT EXISTS `metric_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL COMMENT '模板名称，如 "MySQL 生产模板"',
  `description` TEXT DEFAULT NULL,
  `db_type` VARCHAR(32) DEFAULT NULL COMMENT '限定的数据库类型',
  `macro_defaults` JSON DEFAULT NULL COMMENT '默认宏变量: {"tps_warning": 500}',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_name` (`name`),
  INDEX `idx_db_type` (`db_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '指标模板定义';

-- 实例 → 模板关联表
CREATE TABLE IF NOT EXISTS `instance_templates` (
  `instance_id` INT UNSIGNED NOT NULL,
  `template_id` INT UNSIGNED NOT NULL,
  `macro_overrides` JSON DEFAULT NULL COMMENT '实例级宏覆盖',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`instance_id`, `template_id`),
  CONSTRAINT `fk_it_instance` FOREIGN KEY (`instance_id`) REFERENCES `database_instances`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_it_template` FOREIGN KEY (`template_id`) REFERENCES `metric_templates`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '实例到模板的关联';

-- metric_definitions 和 alert_rules 已有 template_id 列（通过 migration 011 添加）
-- 如果 migration 011 未运行，手动执行：
-- ALTER TABLE `metric_definitions` ADD COLUMN `template_id` INT UNSIGNED DEFAULT NULL AFTER `updated_by`, ADD INDEX `idx_template_id` (`template_id`);
-- ALTER TABLE `alert_rules` ADD COLUMN `template_id` INT UNSIGNED DEFAULT NULL AFTER `instance_ids`, ADD INDEX `idx_template_id` (`template_id`);

-- Phase: UI个性化 Layer 5 (migration 014)
CREATE TABLE IF NOT EXISTS `user_preferences` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT UNSIGNED NOT NULL UNIQUE,
  `preferences` JSON NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_up_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Per-user UI preferences and personalization settings';
