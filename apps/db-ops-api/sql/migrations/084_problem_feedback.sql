CREATE TABLE IF NOT EXISTS `problem_feedback` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '问题反馈 ID',
  `title` VARCHAR(160) NOT NULL COMMENT '问题标题',
  `description` TEXT NOT NULL COMMENT '面向开发者的问题描述',
  `source` ENUM('manual','agent') NOT NULL DEFAULT 'manual' COMMENT '记录来源',
  `created_by` INT UNSIGNED DEFAULT NULL COMMENT '创建人用户 ID',
  `updated_by` INT UNSIGNED DEFAULT NULL COMMENT '最后修改人用户 ID',
  `idempotency_key` CHAR(64) DEFAULT NULL COMMENT 'Agent 工具幂等键摘要',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT '创建时间',
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT '最后更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_problem_feedback_idempotency` (`created_by`, `source`, `idempotency_key`),
  KEY `idx_problem_feedback_created_at` (`created_at`, `id`),
  KEY `idx_problem_feedback_creator` (`created_by`, `created_at`, `id`),
  CONSTRAINT `fk_problem_feedback_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_problem_feedback_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户和 Agent 记录的问题反馈';
