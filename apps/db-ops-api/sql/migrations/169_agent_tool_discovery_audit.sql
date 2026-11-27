ALTER TABLE agent_tool_audit
  MODIFY COLUMN phase ENUM('decision','result','discovery') NOT NULL;
