-- Migration 011: Add api_format column to llm_providers
ALTER TABLE `llm_providers`
  ADD COLUMN `api_format` ENUM('openai-completions', 'anthropic-messages', 'google-generative-ai') DEFAULT NULL
  COMMENT 'API 兼容格式：openai-completions / anthropic-messages / google-generative-ai'
  AFTER `deployment_type`;
