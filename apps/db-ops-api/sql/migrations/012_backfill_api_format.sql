-- Migration 012: Backfill api_format for existing providers based on name
-- This ensures the api_format column (added in migration 011) has correct values
-- before we switch the code to use api_format instead of hardcoded name switches.

UPDATE llm_providers SET api_format = 'anthropic-messages' WHERE name = 'anthropic' AND api_format IS NULL;
UPDATE llm_providers SET api_format = 'openai-completions' WHERE name IN ('openai', 'aliyun', 'deepseek', 'kimi', 'bailian', 'minimax', 'glm') AND api_format IS NULL;
UPDATE llm_providers SET api_format = 'openai-completions' WHERE deployment_type = 'local' AND api_format IS NULL;
