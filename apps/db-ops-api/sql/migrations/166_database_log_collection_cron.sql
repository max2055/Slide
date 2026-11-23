-- Upgrade the original unbound seed in place. Assigned or customized jobs
-- keep their existing authority and SQL. The script itself remains available.
UPDATE cron_jobs j
LEFT JOIN cron_jobs existing_collector ON existing_collector.handler_key = 'database.logs.collect'
LEFT JOIN cron_scripts s ON s.id = j.script_id
LEFT JOIN cron_runs r ON r.job_id = j.id AND r.status = 'queued'
SET j.handler_key = 'database.logs.collect',
    j.task_type = 'agent',
    j.script_id = NULL,
    j.script_binding = NULL,
    j.principal_type = 'system-maintenance',
    j.identity_status = 'bound',
    j.resource_scope = JSON_OBJECT('version', 1, 'targetInstanceId', NULL, 'instanceIds', JSON_ARRAY(),
      'serverIds', JSON_ARRAY(), 'networkDeviceIds', JSON_ARRAY()),
    j.identity_audit = JSON_OBJECT('source', 'migration:166:typed-handler', 'capability', 'database.logs.collect'),
    j.task_description = '采集 MySQL 错误日志与 PostgreSQL 统计异常信号',
    j.description = '采集 MySQL 错误日志与 PostgreSQL 统计异常信号',
    j.output_schema = NULL,
    j.last_result = IF(j.last_result = 'owner-required', NULL, j.last_result),
    r.status = 'cancelled',
    r.runner_finished_at = NOW(3),
    r.error_code = 'CRON_JOB_DEFINITION_CHANGED'
WHERE j.name = '数据库日志采集'
  AND existing_collector.id IS NULL
  AND j.handler_key IS NULL
  AND j.principal_type = 'user'
  AND j.identity_status = 'owner-required'
  AND j.owner_user_id IS NULL
  AND j.target_instance_id IS NULL
  AND (
    (j.task_type = 'script' AND s.name = 'log_collection'
      AND JSON_UNQUOTE(JSON_EXTRACT(j.script_binding, '$.authorizedBy')) = 'migration:092'
      AND j.task_description = 'Every 5 minutes, collect and store database logs from all available sources. Capture error logs, activity logs, and any diagnostic log output. Call slide_complete_cron with a summary of collected log entries.')
    OR (j.task_type = 'agent' AND j.script_id IS NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(j.identity_audit, '$.source')) = 'trusted-seed'
      AND j.task_description = 'Every 5 minutes, collect and store database logs from all available sources. Call slide_complete_cron with a summary of collected log entries.')
  );

-- Install a missing seed disabled, preferring the original name, then the
-- system name. One suffix per existing job ID supplies more distinct names
-- than there are jobs, so occupied numbered names cannot exhaust the choices.
INSERT INTO cron_jobs (name, task_description, cron_expr, enabled, task_type, handler_key, timezone,
  description, principal_type, identity_status, resource_scope, identity_audit)
SELECT candidate.name,
  '采集 MySQL 错误日志与 PostgreSQL 统计异常信号', '0 */5 * * * *', 0, 'agent', 'database.logs.collect',
  'Asia/Shanghai', '采集 MySQL 错误日志与 PostgreSQL 统计异常信号', 'system-maintenance', 'bound',
  JSON_OBJECT('version', 1, 'targetInstanceId', NULL, 'instanceIds', JSON_ARRAY(),
    'serverIds', JSON_ARRAY(), 'networkDeviceIds', JSON_ARRAY()),
  JSON_OBJECT('source', 'migration:166:typed-handler', 'capability', 'database.logs.collect')
FROM (
  SELECT '数据库日志采集' AS name, 0 AS priority, 0 AS suffix
  UNION ALL SELECT '数据库日志采集（系统）', 1, 0
  UNION ALL SELECT CONCAT('数据库日志采集（系统） #', id), 2, id FROM cron_jobs
) AS candidate
WHERE NOT EXISTS (SELECT 1 FROM cron_jobs WHERE handler_key = 'database.logs.collect')
  AND NOT EXISTS (SELECT 1 FROM cron_jobs WHERE name = candidate.name)
ORDER BY candidate.priority, candidate.suffix
LIMIT 1;
