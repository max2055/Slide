-- Pin existing scripts without granting any maintenance writes. Legacy writes
-- fail closed until an unrestricted cron manager explicitly selects a capability.
ALTER TABLE cron_jobs ADD COLUMN script_binding JSON DEFAULT NULL COMMENT 'Pinned SQL content, target, capability and authorizing actor';
UPDATE cron_jobs j JOIN cron_scripts s ON s.id = j.script_id
SET j.script_binding = JSON_OBJECT(
  'version', 1, 'scriptId', s.id, 'targetInstanceId', j.target_instance_id,
  'content', s.content, 'sha256', SHA2(s.content, 256),
  'capability', 'read-only', 'authorizedBy', 'migration:092'
)
WHERE j.task_type = 'script' AND s.script_type = 'sql'
  AND (j.target_instance_id IS NOT NULL OR s.target_db_type = 'mysql');
