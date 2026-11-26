-- Retain the existing phase column comment when appending the discovery audit stage.
ALTER TABLE agent_tool_audit
  MODIFY COLUMN phase ENUM('decision','result','discovery') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '阶段';
