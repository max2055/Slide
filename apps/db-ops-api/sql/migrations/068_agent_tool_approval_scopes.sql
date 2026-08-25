ALTER TABLE agent_tool_approvals
  ADD COLUMN scope ENUM('once', 'window', 'session') NOT NULL DEFAULT 'once' COMMENT 'Approval reuse scope.' AFTER status,
  ADD COLUMN session_key VARCHAR(512) NULL COMMENT 'Agent session bound to reusable approval.' AFTER scope,
  ADD COLUMN risk_level ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'high' COMMENT 'Execute code risk classification.' AFTER session_key,
  ADD COLUMN max_uses INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Maximum executions permitted by this approval.' AFTER risk_level,
  ADD COLUMN used_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Executions consumed by this approval.' AFTER max_uses,
  ADD KEY idx_agent_tool_approval_scope (requester_id, tool_name, session_key, status, expires_at);
