-- ============================================
-- Migration 009: Cron Jobs Tables + Seed Data
-- Phase 112 - Cron Jobs Configurable
-- ============================================
-- Purpose: Replace 13 hardcoded CronJob definitions in
--          server.ts with database-driven cron management.
--          Creates cron_jobs, cron_job_logs, cron_job_params
--          tables, seeds initial 13 job configs, and registers
--          cron:view / cron:manage permission codes.
-- ============================================

START TRANSACTION;

-- =========================================================================
-- 1. Create cron_jobs table (D-13)
-- =========================================================================

CREATE TABLE IF NOT EXISTS `cron_jobs` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL COMMENT '任务名称',
  `handler` VARCHAR(100) NOT NULL COMMENT '处理函数标识符',
  `cron_expr` VARCHAR(100) NOT NULL COMMENT 'cron 表达式',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE COMMENT '启用开关',
  `timezone` VARCHAR(50) NOT NULL DEFAULT 'Asia/Shanghai' COMMENT '时区',
  `description` VARCHAR(500) DEFAULT NULL COMMENT '任务描述',
  `last_run_at` DATETIME DEFAULT NULL COMMENT '上次执行时间',
  `next_run_at` DATETIME DEFAULT NULL COMMENT '下次执行时间',
  `last_result` VARCHAR(50) DEFAULT NULL COMMENT '上次执行结果',
  `timeout_seconds` INT UNSIGNED NOT NULL DEFAULT 300 COMMENT '超时时间（秒）',
  `retry_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '重试次数',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================================
-- 2. Create cron_job_logs table (D-13)
-- =========================================================================

CREATE TABLE IF NOT EXISTS `cron_job_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` INT UNSIGNED NOT NULL COMMENT '关联任务ID',
  `started_at` DATETIME NOT NULL COMMENT '开始时间',
  `finished_at` DATETIME DEFAULT NULL COMMENT '结束时间',
  `status` ENUM('running','success','error','skipped') NOT NULL DEFAULT 'running' COMMENT '执行状态',
  `result_summary` VARCHAR(500) DEFAULT NULL COMMENT '结果摘要',
  `error_message` TEXT DEFAULT NULL COMMENT '错误信息',
  PRIMARY KEY (`id`),
  INDEX `idx_job_started` (`job_id`, `started_at` DESC),
  CONSTRAINT `fk_cron_job_logs_job` FOREIGN KEY (`job_id`) REFERENCES `cron_jobs`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================================
-- 3. Create cron_job_params table (D-13)
-- =========================================================================

CREATE TABLE IF NOT EXISTS `cron_job_params` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` INT UNSIGNED NOT NULL COMMENT '关联任务ID',
  `param_key` VARCHAR(100) NOT NULL COMMENT '参数键',
  `param_value` TEXT DEFAULT NULL COMMENT '参数值',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_job_param` (`job_id`, `param_key`),
  CONSTRAINT `fk_cron_job_params_job` FOREIGN KEY (`job_id`) REFERENCES `cron_jobs`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================================
-- 4. Seed 13 cron job configs (D-14, D-15)
--    Handler names match cron-job-handlers.ts exports exactly.
--    First 3 jobs have enabled=false (guarded by ENABLE_AUTO_AI_ANALYSIS config).
-- =========================================================================

INSERT INTO `cron_jobs` (`name`, `handler`, `cron_expr`, `enabled`, `timezone`, `description`) VALUES
('TopSQL 自动分析',         'topsqlAnalysis',     '*/10 * * * * *', false, 'Asia/Shanghai', '自动分析 TopSQL（受 ENABLE_AUTO_AI_ANALYSIS 控制）'),
('告警 RCA 分析',           'rcaAnalysis',        '*/10 * * * * *', false, 'Asia/Shanghai', '告警根因自动分析（受 ENABLE_AUTO_AI_ANALYSIS 控制）'),
('故障自动诊断',             'faultDiagnosis',     '*/60 * * * * *', false, 'Asia/Shanghai', '自动诊断不健康实例（受 ENABLE_AUTO_AI_ANALYSIS 控制）'),
('容量数据采集',             'capacityCollection',   '*/5 * * * *',    true,  'Asia/Shanghai', '每 5 分钟采集实例容量数据'),
('Schema 快照采集',         'schemaCollection',    '*/30 * * * *',    true,  'Asia/Shanghai', '每 30 分钟采集 Schema 快照并检测变更'),
('索引信息采集',             'indexCollection',     '15,45 * * * *',  true,  'Asia/Shanghai', '每 30 分钟采集索引信息（与 Schema 错开 15 分钟）'),
('基线计算',                'baselineCalculation', '0 2 * * *',       true,  'Asia/Shanghai', '每天凌晨 2 点计算指标基线'),
('基线清理',                'baselineCleanup',     '0 3 * * 0',       true,  'Asia/Shanghai', '每周日凌晨 3 点清理过期基线（保留 30 天）'),
('数据库日志采集',           'logCollection',       '0 */5 * * * *',  true,  'Asia/Shanghai', '每 5 分钟采集数据库日志'),
('静默过期清理',             'silenceCleanup',      '0 * * * *',       true,  'Asia/Shanghai', '每小时清理过期静默规则'),
('定时报表调度',             'reportScheduling',    '*/60 * * * * *', true,  'Asia/Shanghai', '每 60 秒扫描并触发定时报表'),
('(预留) 升级规则监控',      'escalationMonitoring', '*/10 * * * * *', true,  'Asia/Shanghai', '告警升级规则定时检查'),
('(预留) 通知推送检查',      'notificationCheck',   '*/30 * * * * *', false, 'Asia/Shanghai', '通知推送队列检查（待完善通知渠道 UI）');

-- =========================================================================
-- 5. Register cron permission codes (D-20)
-- =========================================================================

INSERT IGNORE INTO `permissions` (`code`, `name`, `description`, `resource`, `action`) VALUES
('cron:view',   '查看定时任务', '查看定时任务列表和日志', 'cron', 'view'),
('cron:manage', '管理定时任务', '启停/修改/手动触发定时任务', 'cron', 'manage');

-- Assign cron permissions to dba role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'dba' AND p.code IN ('cron:view', 'cron:manage');

-- admin already has '*' wildcard, covered automatically

COMMIT;
