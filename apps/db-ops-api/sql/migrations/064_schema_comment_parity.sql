-- Forward-only comment parity for gaps discovered after migration 058 was
-- recorded. Column definitions preserve the existing schema exactly.
-- Older explicitly baselined deployments only have tokens_used. The current
-- install snapshot also has split input/output counters, so comment them only
-- on schemas where those optional columns exist.
SET @slide_schema_comment_sql = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ai_chat_history'
        AND COLUMN_NAME = 'input_tokens'
    ),
    'ALTER TABLE `ai_chat_history` MODIFY COLUMN `input_tokens` int DEFAULT 0 COMMENT ''输入令牌数''',
    'SELECT 1'
  )
);
PREPARE slide_schema_comment_stmt FROM @slide_schema_comment_sql;
EXECUTE slide_schema_comment_stmt;
DEALLOCATE PREPARE slide_schema_comment_stmt;

SET @slide_schema_comment_sql = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ai_chat_history'
        AND COLUMN_NAME = 'output_tokens'
    ),
    'ALTER TABLE `ai_chat_history` MODIFY COLUMN `output_tokens` int DEFAULT 0 COMMENT ''输出令牌数''',
    'SELECT 1'
  )
);
PREPARE slide_schema_comment_stmt FROM @slide_schema_comment_sql;
EXECUTE slide_schema_comment_stmt;
DEALLOCATE PREPARE slide_schema_comment_stmt;

SET @slide_schema_comment_sql = (
  SELECT IF(
    COUNT(*) = 3,
    'ALTER TABLE `generated_skills` COMMENT = ''自动生成技能表'', MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT ''主键 ID'', MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT ''创建时间'', MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ''更新时间''',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'generated_skills'
    AND COLUMN_NAME IN ('id', 'created_at', 'updated_at')
);
PREPARE slide_schema_comment_stmt FROM @slide_schema_comment_sql;
EXECUTE slide_schema_comment_stmt;
DEALLOCATE PREPARE slide_schema_comment_stmt;

ALTER TABLE `health_check_history`
  MODIFY COLUMN `dimensions` json DEFAULT NULL COMMENT '健康评分维度 JSON';

SET @slide_schema_comment_sql = (
  SELECT IF(
    COUNT(*) = 1,
    'ALTER TABLE `skill_execution_history` COMMENT = ''技能执行历史表'', MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT ''主键 ID''',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'skill_execution_history'
    AND COLUMN_NAME = 'id'
);
PREPARE slide_schema_comment_stmt FROM @slide_schema_comment_sql;
EXECUTE slide_schema_comment_stmt;
DEALLOCATE PREPARE slide_schema_comment_stmt;

SET @slide_schema_comment_sql = (
  SELECT IF(
    COUNT(*) = 3,
    'ALTER TABLE `skill_usage_patterns` COMMENT = ''技能使用模式统计表'', MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT ''主键 ID'', MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT ''创建时间'', MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ''更新时间''',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'skill_usage_patterns'
    AND COLUMN_NAME IN ('id', 'created_at', 'updated_at')
);
PREPARE slide_schema_comment_stmt FROM @slide_schema_comment_sql;
EXECUTE slide_schema_comment_stmt;
DEALLOCATE PREPARE slide_schema_comment_stmt;
