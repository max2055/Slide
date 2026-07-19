-- Migration 017: Add cron_scripts table + cron_jobs script mode columns
-- Supports: Phase 122 — Cron job script/agent dual mode
-- =========================================================================
-- Creates the cron_scripts table for storing reusable SQL scripts.
-- Extends cron_jobs with task_type, script_id, target_instance_id columns
-- for dual-mode execution (script vs agent).
-- Seeds 6 predefined data-collection scripts.
-- Auto-migrates 6 existing cron jobs to script mode.
-- =========================================================================

-- =========================================================================
-- 1. CREATE cron_scripts table
-- =========================================================================
CREATE TABLE IF NOT EXISTS `cron_scripts` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT 'Script ID',
  `name` VARCHAR(100) NOT NULL UNIQUE COMMENT 'Unique script identifier name',
  `description` TEXT DEFAULT NULL COMMENT 'Human-readable script description',
  `script_type` ENUM('sql', 'shell') NOT NULL DEFAULT 'sql' COMMENT 'Script type: sql or shell (shell reserved for future use)',
  `content` TEXT NOT NULL COMMENT 'Script body (SQL or shell command)',
  `target_db_type` ENUM('mysql', 'postgresql', 'oracle', 'dameng', 'mongodb', 'redis', 'elasticsearch') NOT NULL COMMENT 'Target database type for dialect selection',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation timestamp',
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
  INDEX `idx_cron_scripts_target_db_type` (`target_db_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Reusable SQL/Shell scripts for cron job execution';

-- =========================================================================
-- 2. ALTER cron_jobs table — add dual-mode columns
-- =========================================================================
ALTER TABLE `cron_jobs`
  ADD COLUMN `task_type` ENUM('script', 'agent') NOT NULL DEFAULT 'agent' AFTER `enabled`
  COMMENT 'Execution mode: script (SQL/shell) or agent (AI-driven)',
  ADD COLUMN `script_id` INT UNSIGNED DEFAULT NULL AFTER `task_type`
  COMMENT 'FK referencing cron_scripts.id for script mode',
  ADD COLUMN `target_instance_id` INT UNSIGNED DEFAULT NULL AFTER `script_id`
  COMMENT 'FK referencing database_instances.id — target managed DB instance for script execution';

-- Add foreign keys after columns are created
ALTER TABLE `cron_jobs`
  ADD CONSTRAINT `fk_cron_jobs_script`
    FOREIGN KEY (`script_id`) REFERENCES `cron_scripts`(`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_cron_jobs_instance`
    FOREIGN KEY (`target_instance_id`) REFERENCES `database_instances`(`id`) ON DELETE SET NULL;

-- =========================================================================
-- 3. Seed 6 predefined scripts
-- =========================================================================

-- 3a. capacity_collection (容量数据采集) — MySQL
INSERT INTO `cron_scripts` (`name`, `description`, `script_type`, `content`, `target_db_type`) VALUES
(
  'capacity_collection',
  '采集所有活跃数据库实例的容量指标：总存储、数据库数、表数',
  'sql',
  'SELECT \n'
  '  ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS total_storage_gb,\n'
  '  COUNT(DISTINCT table_schema) AS total_databases,\n'
  '  COUNT(*) AS total_tables\n'
  'FROM information_schema.tables\n'
  'WHERE table_schema NOT IN (''information_schema'', ''mysql'', ''performance_schema'', ''sys'');',
  'mysql'
);

-- 3b. schema_collection (Schema 快照采集) — MySQL
INSERT INTO `cron_scripts` (`name`, `description`, `script_type`, `content`, `target_db_type`) VALUES
(
  'schema_collection',
  '采集所有数据库的 Schema 快照：表、列、数据类型、键信息',
  'sql',
  'SELECT table_schema, table_name, column_name, data_type, is_nullable, column_key\n'
  'FROM information_schema.columns\n'
  'WHERE table_schema NOT IN (''information_schema'', ''mysql'', ''performance_schema'', ''sys'')\n'
  'ORDER BY table_schema, table_name, ordinal_position;',
  'mysql'
);

-- 3c. index_collection (索引信息采集) — MySQL
INSERT INTO `cron_scripts` (`name`, `description`, `script_type`, `content`, `target_db_type`) VALUES
(
  'index_collection',
  '采集所有活跃数据库实例的索引信息：索引名、列名、类型和基数',
  'sql',
  'SELECT table_schema, table_name, index_name, column_name, \n'
  '       non_unique, index_type, cardinality\n'
  'FROM information_schema.statistics\n'
  'WHERE table_schema NOT IN (''information_schema'', ''mysql'', ''performance_schema'', ''sys'')\n'
  'ORDER BY table_schema, table_name, index_name, seq_in_index;',
  'mysql'
);

-- 3d. baseline_cleanup (基线清理) — Slide 自身 MySQL 库
INSERT INTO `cron_scripts` (`name`, `description`, `script_type`, `content`, `target_db_type`) VALUES
(
  'baseline_cleanup',
  '清理 metric_baselines 中超过 30 天的过期基线记录',
  'sql',
  'DELETE FROM metric_baselines WHERE computed_at < NOW() - INTERVAL 30 DAY;',
  'mysql'
);

-- 3e. silence_cleanup (静默过期清理) — Slide 自身 MySQL 库
INSERT INTO `cron_scripts` (`name`, `description`, `script_type`, `content`, `target_db_type`) VALUES
(
  'silence_cleanup',
  '清理 alert_silence_rules 中已过期的静默规则',
  'sql',
  'DELETE FROM silence_periods WHERE silenced_until < NOW();',
  'mysql'
);

-- 3f. log_collection (数据库日志采集) — MySQL
INSERT INTO `cron_scripts` (`name`, `description`, `script_type`, `content`, `target_db_type`) VALUES
(
  'log_collection',
  '采集最近 5 分钟的慢查询日志记录',
  'sql',
  'SELECT start_time, user_host, query_time, lock_time, rows_sent, rows_examined, sql_text\n'
  'FROM mysql.slow_log\n'
  'WHERE start_time >= NOW() - INTERVAL 5 MINUTE\n'
  'ORDER BY start_time DESC\n'
  'LIMIT 1000;',
  'mysql'
);

-- =========================================================================
-- 4. Auto-migration: Convert 6 existing data-collection jobs to script mode
-- =========================================================================

-- 4a. Set task_type = 'script' for the 6 data-collection jobs
UPDATE `cron_jobs`
SET task_type = 'script'
WHERE name IN (
  '容量数据采集',
  'Schema 快照采集',
  '索引信息采集',
  '基线清理',
  '数据库日志采集',
  '静默过期清理'
);

-- 4b. Link each job to its corresponding seed script
UPDATE `cron_jobs` cj
  JOIN `cron_scripts` cs ON cs.name = 'capacity_collection'
SET cj.script_id = cs.id
WHERE cj.name = '容量数据采集';

UPDATE `cron_jobs` cj
  JOIN `cron_scripts` cs ON cs.name = 'schema_collection'
SET cj.script_id = cs.id
WHERE cj.name = 'Schema 快照采集';

UPDATE `cron_jobs` cj
  JOIN `cron_scripts` cs ON cs.name = 'index_collection'
SET cj.script_id = cs.id
WHERE cj.name = '索引信息采集';

UPDATE `cron_jobs` cj
  JOIN `cron_scripts` cs ON cs.name = 'baseline_cleanup'
SET cj.script_id = cs.id
WHERE cj.name = '基线清理';

UPDATE `cron_jobs` cj
  JOIN `cron_scripts` cs ON cs.name = 'log_collection'
SET cj.script_id = cs.id
WHERE cj.name = '数据库日志采集';

UPDATE `cron_jobs` cj
  JOIN `cron_scripts` cs ON cs.name = 'silence_cleanup'
SET cj.script_id = cs.id
WHERE cj.name = '静默过期清理';

-- Note: task_type='script' jobs that target Slide's own DB (baseline_cleanup, silence_cleanup)
-- leave target_instance_id as NULL. The executor detects NULL and routes to internal MySQL.
-- Other 4 scripts (capacity/schema/index/log) also leave target_instance_id NULL;
-- user selects the target instance at job creation time via the frontend.
