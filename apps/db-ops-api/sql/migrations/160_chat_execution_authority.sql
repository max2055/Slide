-- Ordinary chat executions retain the verified initiating credential, never JWT text.
-- NULL identifies legacy/unbound runs; they cannot resume external execution or
-- commit staged answers. Investigation execution continues to use its own binding.
ALTER TABLE agent_runs
  ADD COLUMN chat_session_version BIGINT UNSIGNED NULL COMMENT 'Ordinary chat initiating identity version',
  ADD COLUMN chat_credential_ref CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'SHA256 reference of verified initiating access token',
  ADD COLUMN chat_credential_expires_ms BIGINT UNSIGNED NULL COMMENT 'Verified initiating access token expiry in Unix milliseconds';
