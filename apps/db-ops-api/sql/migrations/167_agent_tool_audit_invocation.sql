ALTER TABLE agent_tool_audit
  ADD COLUMN invocation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL COMMENT '工具调用 ID，历史记录及独立决策为空',
  ADD UNIQUE KEY uq_agent_tool_audit_invocation_phase (invocation_id, phase);
