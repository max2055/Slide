-- ============================================
-- LLM 配置功能升级迁移脚本
-- 执行时间：2026-04-10
-- ============================================

USE `db_ops_ai`;

-- 1. 备份现有数据
CREATE TABLE IF NOT EXISTS `llm_providers_backup` AS SELECT * FROM `llm_providers`;

-- 2. 修改 llm_providers 表结构
-- 注意：MySQL 8.0+ 支持这些 ALTER 操作

-- 添加 deployment_type 字段
ALTER TABLE `llm_providers`
ADD COLUMN `deployment_type_tmp` ENUM('local', 'cloud', 'api') NOT NULL DEFAULT 'api' COMMENT '部署方式：local=本地，cloud=云服务，api=厂商 API';

-- 根据 name 设置 deployment_type
UPDATE `llm_providers` SET `deployment_type_tmp` = 'local' WHERE `name` = 'ollama';
UPDATE `llm_providers` SET `deployment_type_tmp` = 'cloud' WHERE `name` IN ('aliyun', 'kimi');
UPDATE `llm_providers` SET `deployment_type_tmp` = 'api' WHERE `name` IN ('anthropic', 'openai', 'deepseek');

-- 删除旧的 name ENUM 约束，改为 VARCHAR
ALTER TABLE `llm_providers` MODIFY `name` VARCHAR(50) NOT NULL;

-- 重命名临时字段为正式字段
ALTER TABLE `llm_providers` CHANGE `deployment_type_tmp` `deployment_type` ENUM('local', 'cloud', 'api') NOT NULL DEFAULT 'api' COMMENT '部署方式：local=本地，cloud=云服务，api=厂商 API';

-- 添加新字段
ALTER TABLE `llm_providers`
ADD COLUMN `models_supported` JSON DEFAULT NULL COMMENT '支持的模型列表 JSON' AFTER `default_model`,
ADD COLUMN `context_window` INT DEFAULT 4096 COMMENT '最大上下文长度 (tokens)' AFTER `models_supported`,
ADD COLUMN `supports_function_call` BOOLEAN DEFAULT FALSE AFTER `context_window`,
ADD COLUMN `supports_vision` BOOLEAN DEFAULT FALSE AFTER `supports_function_call`,
ADD COLUMN `input_cost_per_1k` DECIMAL(10,6) DEFAULT 0 COMMENT '每 1K 输入 token 价格 (USD)' AFTER `supports_vision`,
ADD COLUMN `output_cost_per_1k` DECIMAL(10,6) DEFAULT 0 COMMENT '每 1K 输出 token 价格 (USD)' AFTER `input_cost_per_1k`,
ADD COLUMN `daily_quota` INT DEFAULT NULL COMMENT '每日 token 配额限制' AFTER `rate_limit_per_minute`,
ADD COLUMN `daily_quota_alert_threshold` INT DEFAULT 80 COMMENT '每日配额告警阈值 (%)' AFTER `daily_quota`;

-- 添加索引
ALTER TABLE `llm_providers`
ADD INDEX `idx_deployment_type` (`deployment_type`);

-- 3. 更新现有 Provider 数据
UPDATE `llm_providers` SET
  `display_name` = '阿里云百炼',
  `models_supported` = '[{"id":"qwen-plus","name":"Qwen-Plus","recommended":true,"desc":"平衡性能与成本"},{"id":"qwen-max","name":"Qwen-Max","desc":"最强性能"},{"id":"qwen-turbo","name":"Qwen-Turbo","desc":"快速响应"}]',
  `context_window` = 128000,
  `supports_function_call` = TRUE,
  `input_cost_per_1k` = 0.002,
  `output_cost_per_1k` = 0.006
WHERE `name` = 'aliyun';

UPDATE `llm_providers` SET
  `display_name` = 'Ollama 本地',
  `models_supported` = '[{"id":"qwen2.5-coder:32b","name":"Qwen2.5-Coder 32B","desc":"代码生成"},{"id":"qwen2.5:32b","name":"Qwen2.5 32B","desc":"通用对话"}]',
  `context_window` = 32768,
  `supports_function_call` = TRUE,
  `input_cost_per_1k` = 0,
  `output_cost_per_1k` = 0
WHERE `name` = 'ollama';

UPDATE `llm_providers` SET
  `display_name` = 'Anthropic Claude',
  `models_supported` = '[{"id":"claude-sonnet-4-6","name":"Claude Sonnet 4.6","recommended":true,"desc":"性价比最高"},{"id":"claude-opus-4-6","name":"Claude Opus 4.6","desc":"最强性能"}]',
  `context_window` = 200000,
  `supports_function_call` = TRUE,
  `supports_vision` = TRUE,
  `input_cost_per_1k` = 0.003,
  `output_cost_per_1k` = 0.015
WHERE `name` = 'anthropic';

UPDATE `llm_providers` SET
  `display_name` = 'OpenAI GPT',
  `models_supported` = '[{"id":"gpt-4.1","name":"GPT-4.1","recommended":true,"desc":"最新模型"},{"id":"gpt-4-turbo","name":"GPT-4 Turbo","desc":"快速"}]',
  `context_window` = 128000,
  `supports_function_call` = TRUE,
  `supports_vision` = TRUE,
  `input_cost_per_1k` = 0.005,
  `output_cost_per_1k` = 0.015
WHERE `name` = 'openai';

UPDATE `llm_providers` SET
  `display_name` = '深度求索',
  `models_supported` = '[{"id":"deepseek-chat","name":"DeepSeek Chat","recommended":true,"desc":"对话模型"}]',
  `context_window` = 128000,
  `supports_function_call` = TRUE,
  `input_cost_per_1k` = 0.001,
  `output_cost_per_1k` = 0.002
WHERE `name` = 'deepseek';

-- 4. 创建用量记录表
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

-- 5. 创建每日用量统计表
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
  `unique_users` INT DEFAULT 0,
  `unique_sessions` INT DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_provider_date_model` (`provider_id`, `date`, `model`),
  INDEX `idx_date` (`date`),
  INDEX `idx_provider_name` (`provider_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. 创建配额告警表
CREATE TABLE IF NOT EXISTS `llm_quota_alerts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_id` INT UNSIGNED NOT NULL,
  `alert_type` ENUM('daily_quota', 'cost_limit', 'rate_limit') NOT NULL,
  `threshold_value` DECIMAL(10,2) NOT NULL,
  `notification_channel_ids` JSON DEFAULT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `last_triggered_at` DATETIME DEFAULT NULL,
  `trigger_count_today` INT DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_provider_id` (`provider_id`),
  INDEX `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. 更新 ai_chat_history 表，添加 provider_id 和成本字段
ALTER TABLE `ai_chat_history`
ADD COLUMN `provider_id` INT UNSIGNED DEFAULT NULL COMMENT '使用的 LLM 提供商 ID' AFTER `instance_id`,
ADD COLUMN `input_tokens` INT DEFAULT 0 AFTER `tokens_used`,
ADD COLUMN `output_tokens` INT DEFAULT 0 AFTER `input_tokens`,
ADD COLUMN `cost_usd` DECIMAL(10,6) DEFAULT 0 COMMENT '本次调用成本 (USD)' AFTER `output_tokens`,
ADD COLUMN `purpose` VARCHAR(50) DEFAULT NULL COMMENT '调用目的' AFTER `duration_ms`;

ALTER TABLE `ai_chat_history`
MODIFY COLUMN `model` VARCHAR(100) DEFAULT NULL;

-- 8. 插入默认配额告警配置
INSERT INTO `llm_quota_alerts` (`provider_id`, `alert_type`, `threshold_value`, `enabled`)
SELECT `id`, 'daily_quota', 80, TRUE FROM `llm_providers` WHERE `name` = 'aliyun';

-- 9. 清理备份表（可选）
-- DROP TABLE IF EXISTS `llm_providers_backup`;

-- ============================================
-- 迁移完成
-- ============================================
