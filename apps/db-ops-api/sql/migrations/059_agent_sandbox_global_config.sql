INSERT IGNORE INTO `system_config`
  (`config_key`, `config_value`, `value_type`, `description`)
VALUES
  ('agent_sandbox_enabled', 'false', 'boolean', 'Enable Agent-generated Shell, Python, and Node execution through Sandbox Controller');

INSERT IGNORE INTO `permissions` (`code`, `name`, `description`, `resource`, `action`)
VALUES ('ai:execute', '执行 Agent 代码', '在隔离 Sandbox 中执行经过审批的 Agent Shell、Python 或 Node 代码', 'ai', 'execute');
