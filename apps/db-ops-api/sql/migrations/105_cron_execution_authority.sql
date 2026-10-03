-- Additive migration. Preview the owner-required inventory before rollout;
-- no legacy Agent task is assigned to an administrator or system identity.
ALTER TABLE cron_jobs
  ADD COLUMN owner_user_id INT UNSIGNED NULL COMMENT 'Authenticated job owner; NULL requires explicit administrator binding',
  ADD COLUMN principal_type ENUM('user','system-maintenance') NOT NULL DEFAULT 'user' COMMENT 'Execution principal: user owner or fixed maintenance capability',
  ADD COLUMN resource_scope JSON NULL COMMENT 'Persisted resource ceiling intersected with current owner grants at execution',
  ADD COLUMN identity_status ENUM('bound','owner-required') NOT NULL DEFAULT 'owner-required' COMMENT 'Owner binding status; owner-required jobs remain paused',
  ADD COLUMN identity_audit JSON NULL COMMENT 'Trusted identity binding provenance and administrator rebind audit';
ALTER TABLE cron_job_logs ADD COLUMN execution_authority JSON NULL COMMENT 'Per-run execution owner, trigger actor and effective resource authority';

-- W01 pinned bindings contain a server-authenticated numeric authorizer.
-- migration:092 and arbitrary usernames are intentionally not owner evidence.
UPDATE cron_jobs j JOIN users u
  ON JSON_UNQUOTE(JSON_EXTRACT(j.script_binding, '$.authorizedBy')) REGEXP '^[1-9][0-9]*$'
  AND CAST(JSON_UNQUOTE(JSON_EXTRACT(j.script_binding, '$.authorizedBy')) AS UNSIGNED) = u.id
SET j.owner_user_id = u.id, j.identity_status = 'bound',
  j.resource_scope = JSON_OBJECT('version', 1, 'targetInstanceId', j.target_instance_id, 'instanceIds', IF(j.target_instance_id IS NULL, JSON_ARRAY(), JSON_ARRAY(j.target_instance_id)),
    'serverIds', JSON_ARRAY(), 'networkDeviceIds', JSON_ARRAY()),
  j.identity_audit = JSON_OBJECT('source', 'migration:105:pinned-script-authorizer', 'ownerUserId', u.id)
WHERE j.task_type = 'script' AND JSON_EXTRACT(j.script_binding, '$.version') = 1;

-- Only existing typed maintenance capabilities survive without a user owner.
UPDATE cron_jobs SET principal_type = 'system-maintenance', identity_status = 'bound',
  resource_scope = JSON_OBJECT('version', 1, 'targetInstanceId', NULL, 'instanceIds', JSON_ARRAY(), 'serverIds', JSON_ARRAY(), 'networkDeviceIds', JSON_ARRAY()),
  identity_audit = JSON_OBJECT('source', 'migration:105:typed-handler', 'capability', handler_key)
WHERE (name = '容量数据采集' AND handler_key = 'capacity.collect')
  OR (name = '基线清理' AND handler_key = 'baseline.cleanup')
  OR (name = '定时报表调度' AND handler_key = 'report.schedule')
  OR (name = '(预留) 升级规则监控' AND handler_key = 'alert.evaluate')
  OR (name = '(预留) 通知推送检查' AND handler_key = 'notification.dispatch')
  OR (name = '故障自动诊断' AND handler_key = 'fault.diagnose-unhealthy');

UPDATE cron_jobs SET enabled = 0, last_result = 'owner-required',
  identity_audit = JSON_OBJECT('source', 'migration:105', 'reason', '可信 owner 缺失；管理员须重新绑定')
WHERE identity_status = 'owner-required';
