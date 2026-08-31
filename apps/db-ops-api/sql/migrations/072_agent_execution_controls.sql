INSERT IGNORE INTO `system_config`
  (`config_key`, `config_value`, `value_type`, `description`)
VALUES
  ('agent_tool_approval_enabled', 'true', 'boolean', 'Require approval before Agent code execution and database network discovery'),
  ('agent_sandbox_network_enabled', 'false', 'boolean', 'Allow Agent code execution to request the dedicated restricted sandbox network');
