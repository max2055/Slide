-- User/final messages remain authoritative in chat_messages. This table stores
-- only actual tool calls/results, anchored to the persisted user turn.
CREATE TABLE IF NOT EXISTS agent_canonical_facts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Stable pagination tie breaker',
  session_id VARCHAR(100) NOT NULL COMMENT 'Actor-owned chat session',
  message_id VARCHAR(100) NOT NULL COMMENT 'Stable canonical message ID',
  turn_sequence BIGINT UNSIGNED NOT NULL COMMENT 'Persisted user message database sequence',
  ordinal BIGINT UNSIGNED NOT NULL COMMENT 'Tool batch iteration and member order',
  entry_json JSON NOT NULL COMMENT 'Original assistant call or returned tool fact',
  PRIMARY KEY (id),
  UNIQUE KEY uq_canonical_session_message (session_id, message_id),
  KEY idx_canonical_page (session_id, turn_sequence, ordinal),
  CONSTRAINT fk_canonical_session FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Canonical tool facts independent of model projection';
