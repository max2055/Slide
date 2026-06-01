-- ============================================
-- 011: Zabbix 风格模板系统
-- ============================================

-- 指标模板定义表
CREATE TABLE IF NOT EXISTS `metric_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL COMMENT '模板名称，如 "MySQL 生产模板"',
  `description` TEXT DEFAULT NULL,
  `db_type` VARCHAR(32) DEFAULT NULL COMMENT '限定的数据库类型，NULL=所有类型',
  `macro_defaults` JSON DEFAULT NULL COMMENT '默认宏变量: {"tps_warning": 500, "qps_critical": 10000}',
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_name` (`name`),
  INDEX `idx_db_type` (`db_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '指标模板定义 — Zabbix Template 类比';

-- 实例 → 模板关联表
CREATE TABLE IF NOT EXISTS `instance_templates` (
  `instance_id` INT UNSIGNED NOT NULL,
  `template_id` INT UNSIGNED NOT NULL,
  `macro_overrides` JSON DEFAULT NULL COMMENT '实例级宏覆盖: {"tps_warning": 2000} — 优先级高于模板默认值',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`instance_id`, `template_id`),
  CONSTRAINT `fk_it_instance` FOREIGN KEY (`instance_id`) REFERENCES `database_instances`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_it_template` FOREIGN KEY (`template_id`) REFERENCES `metric_templates`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '实例到模板的关联 — Zabbix Host → Template link 类比';

-- 为 metric_definitions 添加 template_id 外键
ALTER TABLE `metric_definitions`
  ADD COLUMN `template_id` INT UNSIGNED DEFAULT NULL COMMENT '所属模板，NULL=全局指标' AFTER `updated_by`,
  ADD INDEX `idx_template_id` (`template_id`);

-- 为 alert_rules 添加 template_id 外键
ALTER TABLE `alert_rules`
  ADD COLUMN `template_id` INT UNSIGNED DEFAULT NULL COMMENT '所属模板，NULL=全局规则' AFTER `instance_ids`,
  ADD INDEX `idx_template_id` (`template_id`);
