-- READ ONLY. Run against an explicitly selected database; never bulk-repair from this inventory.
SELECT id, lifecycle_state, status, removal_requested_at, removed_at, removal_reasons
FROM database_instances WHERE lifecycle_state <> 'available' ORDER BY id;

-- Actual deployment FK inventory (name/action only; no credentials or SQL contents).
SELECT TABLE_NAME, CONSTRAINT_NAME, DELETE_RULE
FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'database_instances'
ORDER BY TABLE_NAME, CONSTRAINT_NAME;

-- Legacy deleted/missing targets remain instance-scoped; do not fill them with NULL.
SELECT j.id, j.target_instance_id, j.enabled,
  CASE WHEN i.id IS NULL THEN 'missing-target' ELSE i.lifecycle_state END AS reason
FROM cron_jobs j LEFT JOIN database_instances i ON i.id = j.target_instance_id
WHERE j.target_instance_id IS NOT NULL AND (i.id IS NULL OR i.lifecycle_state <> 'available');

SELECT r.id, r.source_type, r.source_id, r.target_type, r.target_id
FROM resource_relations r
LEFT JOIN database_instances s ON r.source_type = 'instance' AND s.id = r.source_id
LEFT JOIN database_instances t ON r.target_type = 'instance' AND t.id = r.target_id
WHERE (r.valid_until IS NULL OR r.valid_until > NOW(6))
  AND ((r.source_type = 'instance' AND (s.id IS NULL OR s.lifecycle_state <> 'available'))
    OR (r.target_type = 'instance' AND (t.id IS NULL OR t.lifecycle_state <> 'available')));
