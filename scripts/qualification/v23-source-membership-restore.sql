-- Bind [original investigation id, exact expiry retained by this grant].
-- Same dedicated DB/UUID/allocation and original viewer tuple only.
-- No INSERT, unconditional update, retry-on-unknown or other-user overwrite.
UPDATE investigation_members SET role='viewer',granted_by=7,expires_at=NULL
WHERE investigation_id=? AND user_id=1 AND role='operator' AND granted_by=7 AND expires_at=?
