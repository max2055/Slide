-- Read-only anomaly/candidate inventory. No historical state or actor inference.
-- Review the original logs and external evidence per event; a candidate is NOT a repair instruction.
-- No secret or user-authored basis contents are emitted.
SELECT e.id AS event_id, e.status, 'closed_without_confirmation' AS finding
FROM alert_events e WHERE e.status = 'closed' AND e.verification_passed_at IS NULL
UNION ALL
SELECT e.id, e.status, 'confirmation_basis_or_actor_missing'
FROM alert_events e WHERE e.verification_passed_at IS NOT NULL
  AND (e.verification_actor_id IS NULL OR e.verification_reason IS NULL OR TRIM(e.verification_reason) = '')
UNION ALL
SELECT e.id, e.status, 'confirmation_log_missing_or_mismatched'
FROM alert_events e WHERE e.verification_passed_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM alert_event_logs l WHERE l.event_id = e.id AND l.action = 'status_changed'
    AND l.actor_id <=> e.verification_actor_id
    AND JSON_UNQUOTE(JSON_EXTRACT(l.details, '$.action')) IN ('verification_passed', 'manual_recovery_confirmed')
    AND JSON_UNQUOTE(JSON_EXTRACT(l.details, '$.reason')) = e.verification_reason
)
UNION ALL
SELECT e.id, e.status, 'resolved_without_resolution_log'
FROM alert_events e WHERE e.status IN ('resolved', 'closed') AND NOT EXISTS (
  SELECT 1 FROM alert_event_logs l WHERE l.event_id = e.id AND l.action = 'resolved'
)
UNION ALL
SELECT e.id, e.status, 'closed_without_close_log'
FROM alert_events e WHERE e.status = 'closed' AND NOT EXISTS (
  SELECT 1 FROM alert_event_logs l WHERE l.event_id = e.id
    AND (l.action = 'closed' OR (l.action = 'status_changed' AND JSON_UNQUOTE(JSON_EXTRACT(l.details, '$.action')) = 'closed'))
)
UNION ALL
SELECT e.id, e.status, 'resolved_with_active_members'
FROM alert_events e WHERE e.status IN ('resolved', 'closed') AND EXISTS (
  SELECT 1 FROM alert_event_members m JOIN alerts a ON a.id = m.alert_id
  WHERE m.event_id = e.id AND a.status IN ('unread', 'read', 'acknowledged')
)
UNION ALL
SELECT e.id, e.status, 'current_members_resolved_history_unknown'
FROM alert_events e WHERE e.status IN ('open', 'investigating', 'handled')
  AND EXISTS (SELECT 1 FROM alert_event_members m WHERE m.event_id = e.id)
  AND NOT EXISTS (
    SELECT 1 FROM alert_event_members m LEFT JOIN alerts a ON a.id = m.alert_id
    WHERE m.event_id = e.id AND (a.id IS NULL OR a.status NOT IN ('resolved', 'closed'))
  )
UNION ALL
SELECT DISTINCT m.event_id, NULL, 'orphan_membership'
FROM alert_event_members m LEFT JOIN alert_events e ON e.id = m.event_id LEFT JOIN alerts a ON a.id = m.alert_id
WHERE e.id IS NULL OR a.id IS NULL
ORDER BY event_id, finding;
