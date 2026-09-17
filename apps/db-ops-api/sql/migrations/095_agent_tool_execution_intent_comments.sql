-- Preserve migration 094 checksums for databases that already applied it.
ALTER TABLE agent_tool_execution_intents
  COMMENT = 'Durable approval consumption and tool execution recovery intents',
  MODIFY COLUMN id CHAR(36) NOT NULL COMMENT 'Unique execution intent identifier',
  MODIFY COLUMN approval_id BIGINT UNSIGNED NOT NULL COMMENT 'Approval consumed by this execution intent',
  MODIFY COLUMN request_id VARCHAR(255) NOT NULL COMMENT 'Tool request identifier for audit correlation',
  MODIFY COLUMN state ENUM('dispatching', 'released', 'finished') NOT NULL COMMENT 'Dispatching, safely released before handler entry, or finished',
  MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Intent creation time',
  MODIFY COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last intent state change time';
