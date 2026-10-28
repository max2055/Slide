-- MAX-238 R1: a client operation key covers the whole activate intent, not only
-- its publication. A row now records the canonical request intent (so a replay
-- is compared with what was actually sent, never with current configuration) and
-- a pending/committed lifecycle (so an in-flight or unknown activate cannot be
-- reported as absent or retried into a second trial). The published binding
-- remains the only configuration fact; this journal records intents and results.
ALTER TABLE metric_policy_apply_operations
  MODIFY COLUMN configuration_digest CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'sha256 of the canonical configuration fingerprint; null until committed',
  MODIFY COLUMN result JSON NULL COMMENT 'Published result returned on replay; null while pending; never credentials',
  MODIFY COLUMN committed_at VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'Trusted policy clock at publication; null while pending',
  ADD COLUMN intent_digest CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
    DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
    COMMENT 'sha256 of the canonical client request; replays compare only this' AFTER target_revision,
  ADD COLUMN state ENUM('pending','committed') NOT NULL DEFAULT 'committed'
    COMMENT 'pending = activate reserved or unknown after a restart; committed = publication recorded' AFTER configuration_digest,
  ADD COLUMN claimed_at VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT ''
    COMMENT 'Trusted policy clock when the intent was reserved' AFTER state,
  ADD KEY idx_metric_policy_apply_operation_state (state);

-- Rows written before this migration stored a publication but not the request,
-- so their intent can never be proven equal to a retried request. They keep the
-- zero digest and are rejected as a collision instead of replaying silently.
UPDATE metric_policy_apply_operations SET claimed_at = COALESCE(committed_at, '') WHERE claimed_at = '';
