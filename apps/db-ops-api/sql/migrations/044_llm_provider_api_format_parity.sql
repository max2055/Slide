-- The historical baseline covered the original 011 API-format migration even
-- though that column was not present in schema.sql.  Add it forward-only so
-- new and already-baselined installations share the runtime contract.
SET @api_format_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_providers' AND COLUMN_NAME = 'api_format'
);
SET @sql := IF(@api_format_exists = 0,
  "ALTER TABLE llm_providers ADD COLUMN api_format ENUM('openai-completions', 'anthropic-messages', 'google-generative-ai') DEFAULT NULL COMMENT 'API compatibility format' AFTER deployment_type",
  'SELECT 1');
PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

UPDATE llm_providers
SET api_format = 'anthropic-messages'
WHERE name = 'anthropic' AND api_format IS NULL;
UPDATE llm_providers
SET api_format = 'openai-completions'
WHERE name IN ('openai', 'aliyun', 'deepseek', 'kimi', 'bailian', 'minimax', 'glm') AND api_format IS NULL;
UPDATE llm_providers
SET api_format = 'openai-completions'
WHERE deployment_type = 'local' AND api_format IS NULL;
