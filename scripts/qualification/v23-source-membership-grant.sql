-- Reviewed parameterized payload, NOT an automatic migration/startup hook.
-- Bind [exact UTC expiry, original investigation id, original grantor7,
--       same expiry, same expiry, same expiry, new session UTC expiry].
-- Caller must verify exact dedicated schema/UUID/head/allocation before BEGIN;
-- only original investigation2db38cfd/user1 is authorized. affectedRows MUST be1.
UPDATE investigation_members SET role='operator',expires_at=?
WHERE investigation_id=? AND user_id=1 AND role='viewer' AND granted_by=? AND expires_at IS NULL
  AND ?>UTC_TIMESTAMP() AND ?<=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 4 HOUR) AND ?<=?
