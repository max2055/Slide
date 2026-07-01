-- Phase 123: Add execution_trace column for Agent tool call tracking
ALTER TABLE ai_analysis ADD COLUMN `execution_trace` JSON DEFAULT NULL COMMENT 'Agent 执行迹：tools_used, tool_events, stop_reason, iteration_count';
