-- 数据治理整改：补齐应用有效范围内全部表和字段注释。
-- 范围排除历史临时备份表 llm_providers_backup 与废弃台账 schema_migrations。
-- 注释内容不改变字段类型、默认值、索引、约束或业务数据。

ALTER TABLE `agent_credential_references`
  COMMENT = '智能体临时凭据引用表',
  MODIFY COLUMN `ref_id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '凭据引用 UUID',
  MODIFY COLUMN `owner_id` int unsigned NOT NULL COMMENT '所有人 ID',
  MODIFY COLUMN `tool_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '工具名称',
  MODIFY COLUMN `secret_encrypted` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '加密后的临时凭据',
  MODIFY COLUMN `status` enum('active','consumed','expired','revoked') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active' COMMENT '业务状态',
  MODIFY COLUMN `expires_at` datetime NOT NULL COMMENT '失效时间',
  MODIFY COLUMN `consumed_at` datetime DEFAULT NULL COMMENT '消费时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `agent_runs`
  COMMENT = '智能体运行记录表',
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `actor_id` int unsigned NOT NULL COMMENT '操作人 ID',
  MODIFY COLUMN `session_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '会话 ID',
  MODIFY COLUMN `message_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '消息 ID',
  MODIFY COLUMN `idempotency_key` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '幂等键',
  MODIFY COLUMN `state` enum('running','completed','partial','failed','cancelled','timed_out') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '处理状态',
  MODIFY COLUMN `result_json` json DEFAULT NULL COMMENT '执行结果 JSON',
  MODIFY COLUMN `error_json` json DEFAULT NULL COMMENT '错误信息 JSON',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `finished_at` datetime DEFAULT NULL COMMENT '结束时间',
  MODIFY COLUMN `expires_at` datetime NOT NULL COMMENT '失效时间';

ALTER TABLE `agent_security_policies`
  COMMENT = '智能体安全策略表',
  MODIFY COLUMN `agent_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '智能体 ID',
  MODIFY COLUMN `tool_allowlist` json DEFAULT NULL COMMENT '工具允许列表',
  MODIFY COLUMN `skill_allowlist` json DEFAULT NULL COMMENT '技能允许列表',
  MODIFY COLUMN `allowed_effects` json NOT NULL COMMENT '允许操作效果',
  MODIFY COLUMN `resource_scope` json NOT NULL COMMENT '资源范围',
  MODIFY COLUMN `version` int unsigned NOT NULL DEFAULT '1' COMMENT '版本号',
  MODIFY COLUMN `updated_by` int unsigned DEFAULT NULL COMMENT '更新人用户 ID',
  MODIFY COLUMN `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间';

ALTER TABLE `agent_security_policy_history`
  COMMENT = '智能体安全策略变更历史表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `agent_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '智能体 ID',
  MODIFY COLUMN `version` int unsigned NOT NULL COMMENT '版本号',
  MODIFY COLUMN `policy_json` json NOT NULL COMMENT '策略内容 JSON',
  MODIFY COLUMN `change_note` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '变更说明',
  MODIFY COLUMN `changed_by` int unsigned NOT NULL COMMENT '变更人用户 ID',
  MODIFY COLUMN `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间';

ALTER TABLE `agent_tool_approvals`
  COMMENT = '智能体工具调用审批表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `tool_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '工具名称',
  MODIFY COLUMN `requester_id` int unsigned NOT NULL COMMENT '申请人 ID',
  MODIFY COLUMN `binding_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '绑定哈希',
  MODIFY COLUMN `args_redacted` json NOT NULL COMMENT '参数脱敏',
  MODIFY COLUMN `resource_json` json NOT NULL COMMENT '资源范围 JSON',
  MODIFY COLUMN `policy_snapshot` json NOT NULL COMMENT '策略快照',
  MODIFY COLUMN `status` enum('pending','approved','rejected','consumed','expired') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '业务状态',
  MODIFY COLUMN `reviewer_id` int unsigned DEFAULT NULL COMMENT '审批人 ID',
  MODIFY COLUMN `review_note` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '审批意见',
  MODIFY COLUMN `reviewed_at` datetime DEFAULT NULL COMMENT '审批时间',
  MODIFY COLUMN `expires_at` datetime NOT NULL COMMENT '失效时间',
  MODIFY COLUMN `consumed_at` datetime DEFAULT NULL COMMENT '消费时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `agent_tool_audit`
  COMMENT = '智能体工具调用审计表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `phase` enum('decision','result') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '阶段',
  MODIFY COLUMN `actor_id` int unsigned NOT NULL COMMENT '操作人 ID',
  MODIFY COLUMN `agent_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'slide-db-ops' COMMENT '智能体 ID',
  MODIFY COLUMN `request_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '请求 ID',
  MODIFY COLUMN `tool_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '工具名称',
  MODIFY COLUMN `allowed` tinyint(1) NOT NULL COMMENT '是否允许',
  MODIFY COLUMN `reason_code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '原因代码',
  MODIFY COLUMN `resource_json` json NOT NULL COMMENT '资源范围 JSON',
  MODIFY COLUMN `policy_snapshot` json NOT NULL COMMENT '策略快照',
  MODIFY COLUMN `args_redacted` json NOT NULL COMMENT '参数脱敏',
  MODIFY COLUMN `result_redacted` json DEFAULT NULL COMMENT '结果脱敏',
  MODIFY COLUMN `approval_id` bigint unsigned DEFAULT NULL COMMENT '审批 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `ai_analysis`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `analysis_type` enum('topsql_analysis','alert_rca','fault_diagnosis','capacity_prediction','sql_audit','log_analysis') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '分析类型',
  MODIFY COLUMN `target_type` enum('instance','server') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'instance' COMMENT '目标类型',
  MODIFY COLUMN `instance_id` int unsigned DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `server_id` int unsigned DEFAULT NULL COMMENT '服务器 ID',
  MODIFY COLUMN `status` enum('pending','running','completed','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '业务状态',
  MODIFY COLUMN `trigger_type` enum('manual','auto') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual' COMMENT '触发类型',
  MODIFY COLUMN `error_message` text COLLATE utf8mb4_unicode_ci COMMENT '错误信息',
  MODIFY COLUMN `duration_ms` int DEFAULT NULL COMMENT '持续时间（毫秒）',
  MODIFY COLUMN `started_at` datetime DEFAULT NULL COMMENT '开始时间',
  MODIFY COLUMN `completed_at` datetime DEFAULT NULL COMMENT '完成时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  MODIFY COLUMN `session_key` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '会话键',
  MODIFY COLUMN `cache_ttl_minutes` int DEFAULT NULL COMMENT '缓存缓存有效期分钟';

ALTER TABLE `ai_chat_history`
  COMMENT = 'AI 对话历史表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `session_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '会话 ID',
  MODIFY COLUMN `user_id` int unsigned DEFAULT NULL COMMENT '用户 ID',
  MODIFY COLUMN `instance_id` int unsigned DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `role` enum('user','assistant','system') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '消息角色',
  MODIFY COLUMN `content` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '内容正文',
  MODIFY COLUMN `model` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '模型名称',
  MODIFY COLUMN `tokens_used` int DEFAULT '0' COMMENT '令牌使用',
  MODIFY COLUMN `duration_ms` int DEFAULT '0' COMMENT '持续时间（毫秒）',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `alert_event_logs`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `action` enum('escalated','assigned','unassigned','acknowledged','note_added','status_changed','resolved','closed','silenced') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `alert_event_members`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `event_id` bigint unsigned NOT NULL COMMENT '事件 ID',
  MODIFY COLUMN `role` enum('triggered','related','correlated') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'triggered' COMMENT '消息角色',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `alert_events`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `title` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '标题',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `status` enum('open','investigating','handled','resolved','closed','reviewed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'open' COMMENT '业务状态',
  MODIFY COLUMN `severity` enum('info','warning','error','critical','p0') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '严重级别',
  MODIFY COLUMN `instance_id` int unsigned DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `server_id` int unsigned DEFAULT NULL COMMENT '服务器 ID',
  MODIFY COLUMN `assigned_to` int unsigned DEFAULT NULL COMMENT '受理人用户 ID',
  MODIFY COLUMN `resolved_by` int unsigned DEFAULT NULL COMMENT '解决人用户 ID',
  MODIFY COLUMN `resolution_notes` text COLLATE utf8mb4_unicode_ci COMMENT '解决说明',
  MODIFY COLUMN `resolved_at` datetime DEFAULT NULL COMMENT '解决时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  MODIFY COLUMN `verification_passed_at` datetime DEFAULT NULL COMMENT '核验通过时间',
  MODIFY COLUMN `verification_actor_id` int unsigned DEFAULT NULL COMMENT '核验操作人 ID',
  MODIFY COLUMN `verification_reason` varchar(1024) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '核验原因';

ALTER TABLE `alert_rule_templates`
  COMMENT = '告警规则模板表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `target_type` enum('instance','server') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'instance' COMMENT '目标类型',
  MODIFY COLUMN `metric_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '指标编码',
  MODIFY COLUMN `operator` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '比较运算符',
  MODIFY COLUMN `threshold_template` json DEFAULT NULL COMMENT '阈值模板',
  MODIFY COLUMN `duration_seconds` int DEFAULT '60' COMMENT '持续时间秒',
  MODIFY COLUMN `severity` enum('info','warning','error','critical') COLLATE utf8mb4_unicode_ci DEFAULT 'warning' COMMENT '严重级别',
  MODIFY COLUMN `silence_minutes` int DEFAULT '5' COMMENT '静默分钟',
  MODIFY COLUMN `enabled` tinyint(1) DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `created_by` int unsigned DEFAULT NULL COMMENT '创建人用户 ID',
  MODIFY COLUMN `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `alert_rules`
  COMMENT = '告警规则表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `target_type` enum('instance','server') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'instance' COMMENT '目标类型',
  MODIFY COLUMN `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `metric_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '指标编码',
  MODIFY COLUMN `operator` enum('>','<','>=','<=','=','!=') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '比较运算符',
  MODIFY COLUMN `threshold` decimal(15,2) NOT NULL COMMENT '阈值',
  MODIFY COLUMN `severity` enum('info','warning','error','critical') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '严重级别',
  MODIFY COLUMN `enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `server_id` int unsigned DEFAULT NULL COMMENT '服务器 ID',
  MODIFY COLUMN `template_id` int unsigned DEFAULT NULL COMMENT '模板 ID',
  MODIFY COLUMN `created_by` int unsigned DEFAULT NULL COMMENT '创建人用户 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  MODIFY COLUMN `threshold_type` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'static' COMMENT '阈值类型',
  MODIFY COLUMN `dynamic_config` json DEFAULT NULL COMMENT '动态配置',
  MODIFY COLUMN `silence_minutes` int DEFAULT '5' COMMENT '静默分钟';

ALTER TABLE `alerts`
  COMMENT = '告警记录表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `server_id` int unsigned DEFAULT NULL COMMENT '服务器 ID',
  MODIFY COLUMN `alert_type` enum('performance','availability','security','backup','replication','capacity') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '告警类型',
  MODIFY COLUMN `title` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '标题',
  MODIFY COLUMN `message` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '消息',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `status` enum('unread','read','acknowledged','resolved','closed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unread' COMMENT '业务状态',
  MODIFY COLUMN `acknowledged_by` int unsigned DEFAULT NULL COMMENT '确认人用户 ID',
  MODIFY COLUMN `acknowledged_at` datetime DEFAULT NULL COMMENT '确认时间',
  MODIFY COLUMN `resolved_by` int unsigned DEFAULT NULL COMMENT '解决人用户 ID',
  MODIFY COLUMN `resolved_at` datetime DEFAULT NULL COMMENT '解决时间',
  MODIFY COLUMN `assigned_to` int unsigned DEFAULT NULL COMMENT '受理人用户 ID',
  MODIFY COLUMN `metric_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '指标编码',
  MODIFY COLUMN `metric_value` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '指标值',
  MODIFY COLUMN `threshold_value` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '触发阈值',
  MODIFY COLUMN `tags` json DEFAULT NULL COMMENT '标签 JSON',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `app_schema_migrations`
  COMMENT = '应用数据库迁移台账表',
  MODIFY COLUMN `migration_id` varchar(255) NOT NULL COMMENT '迁移文件标识',
  MODIFY COLUMN `checksum` char(64) NOT NULL COMMENT '迁移文件校验值',
  MODIFY COLUMN `status` enum('running','completed','failed','baselined','repaired') NOT NULL COMMENT '业务状态',
  MODIFY COLUMN `statement_index` int DEFAULT NULL COMMENT '失败语句序号',
  MODIFY COLUMN `error` text COMMENT '错误信息',
  MODIFY COLUMN `started_at` datetime DEFAULT NULL COMMENT '开始时间',
  MODIFY COLUMN `finished_at` datetime DEFAULT NULL COMMENT '结束时间';

ALTER TABLE `approval_events`
  COMMENT = '审批事件表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `request_id` bigint unsigned NOT NULL COMMENT '请求 ID',
  MODIFY COLUMN `event_type` enum('submitted','ai_reviewed','claimed','approved','rejected','executed','execution_failed','notified') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '事件类型',
  MODIFY COLUMN `event_data` json DEFAULT NULL COMMENT '事件数据',
  MODIFY COLUMN `created_by` int unsigned DEFAULT NULL COMMENT '创建人用户 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `approval_requests`
  COMMENT = 'SQL 执行审批申请表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `target_database` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '目标数据库',
  MODIFY COLUMN `sql_text` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'SQL 文本',
  MODIFY COLUMN `sql_hash` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'SQL 内容哈希值',
  MODIFY COLUMN `risk_level` enum('low','medium','high','critical') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'low' COMMENT '风险等级',
  MODIFY COLUMN `ai_recommendation` json DEFAULT NULL COMMENT 'AI建议',
  MODIFY COLUMN `status` enum('pending','executing','approved','rejected','executed','execution_failed','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '业务状态',
  MODIFY COLUMN `submitted_by` int unsigned DEFAULT NULL COMMENT '提交人用户 ID',
  MODIFY COLUMN `reviewed_by` int unsigned DEFAULT NULL COMMENT '审批人用户 ID',
  MODIFY COLUMN `review_notes` text COLLATE utf8mb4_unicode_ci COMMENT '审批意见',
  MODIFY COLUMN `execution_result` json DEFAULT NULL COMMENT '执行结果',
  MODIFY COLUMN `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  MODIFY COLUMN `operation_id` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '运维操作 ID';

ALTER TABLE `capacity_databases`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `capacity_id` bigint unsigned NOT NULL COMMENT '容量 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `db_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '数据库名称',
  MODIFY COLUMN `size_gb` decimal(10,2) DEFAULT '0.00' COMMENT '大小（GB）',
  MODIFY COLUMN `table_count` int DEFAULT '0' COMMENT '表数量',
  MODIFY COLUMN `recorded_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间';

ALTER TABLE `capacity_history`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `total_size_gb` decimal(10,2) DEFAULT '0.00' COMMENT '总计大小（GB）',
  MODIFY COLUMN `db_count` int DEFAULT '0' COMMENT '数据库数量',
  MODIFY COLUMN `table_count` int DEFAULT '0' COMMENT '表数量',
  MODIFY COLUMN `recorded_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间';

ALTER TABLE `chat_messages`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `chat_session_shares`
  COMMENT = '对话会话共享授权表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `session_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '会话 ID',
  MODIFY COLUMN `granted_by` int unsigned NOT NULL COMMENT '授权人用户 ID',
  MODIFY COLUMN `recipient_user_id` int unsigned NOT NULL COMMENT '接收人用户 ID',
  MODIFY COLUMN `permission` enum('read') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'read' COMMENT '权限',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `chat_sessions`
  COMMENT = '对话会话表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `collection_schedule_state`
  COMMENT = '指标采集调度状态表',
  MODIFY COLUMN `resource_type` enum('instance','server') NOT NULL COMMENT '资源类型',
  MODIFY COLUMN `resource_id` bigint unsigned NOT NULL COMMENT '资源 ID',
  MODIFY COLUMN `provider_id` varchar(128) NOT NULL COMMENT '提供方 ID',
  MODIFY COLUMN `metric_id` varchar(128) NOT NULL COMMENT '指标 ID',
  MODIFY COLUMN `schedule_version` bigint unsigned NOT NULL DEFAULT '1' COMMENT '调度版本',
  MODIFY COLUMN `last_success_at` datetime DEFAULT NULL COMMENT '最近成功时间',
  MODIFY COLUMN `next_due_at` datetime NOT NULL COMMENT '下次到期时间',
  MODIFY COLUMN `last_result` enum('success','failure','skipped') DEFAULT NULL COMMENT '最近结果',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `cron_job_logs`
  COMMENT = '定时任务执行日志表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `status` enum('running','success','error','skipped','timeout','partial') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'running' COMMENT '业务状态',
  MODIFY COLUMN `result_summary` text COLLATE utf8mb4_unicode_ci COMMENT '结果摘要',
  MODIFY COLUMN `result` longtext COLLATE utf8mb4_unicode_ci COMMENT '执行结果',
  MODIFY COLUMN `structured_result` json DEFAULT NULL COMMENT '结构化结果',
  MODIFY COLUMN `tools_used` json DEFAULT NULL COMMENT '工具使用',
  MODIFY COLUMN `tool_events` json DEFAULT NULL COMMENT '工具事件',
  MODIFY COLUMN `usage` json DEFAULT NULL COMMENT '用量',
  MODIFY COLUMN `stop_reason` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '停止原因',
  MODIFY COLUMN `duration_ms` int DEFAULT NULL COMMENT '持续时间（毫秒）',
  MODIFY COLUMN `error_trace` text COLLATE utf8mb4_unicode_ci COMMENT '错误轨迹',
  MODIFY COLUMN `partial_trace` longtext COLLATE utf8mb4_unicode_ci COMMENT '部分轨迹';

ALTER TABLE `cron_job_params`
  COMMENT = '定时任务参数表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID';

ALTER TABLE `cron_jobs`
  COMMENT = '定时任务定义表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `task_description` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '任务说明',
  MODIFY COLUMN `output_schema` json DEFAULT NULL COMMENT '输出元数据结构',
  MODIFY COLUMN `task_type` enum('script','agent') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'agent' COMMENT '任务类型',
  MODIFY COLUMN `handler_key` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '处理器键',
  MODIFY COLUMN `script_id` int unsigned DEFAULT NULL COMMENT '脚本 ID',
  MODIFY COLUMN `target_instance_id` int unsigned DEFAULT NULL COMMENT '目标实例 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `database_instances`
  COMMENT = '纳管数据库实例表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `environment` enum('development','staging','production','testing') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'development' COMMENT '运行环境',
  MODIFY COLUMN `db_type` enum('mysql','postgresql','mongodb','redis','elasticsearch','dameng','oracle') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'mysql' COMMENT '数据库类型',
  MODIFY COLUMN `db_version` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '数据库版本',
  MODIFY COLUMN `data_size_gb` decimal(10,2) DEFAULT NULL COMMENT '数据大小（GB）',
  MODIFY COLUMN `host` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '主机地址',
  MODIFY COLUMN `port` int NOT NULL COMMENT '服务端口',
  MODIFY COLUMN `username` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录用户名',
  MODIFY COLUMN `password_encrypted` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '加密后的数据库密码',
  MODIFY COLUMN `database_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '数据库名称',
  MODIFY COLUMN `connection_string` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '数据库连接串',
  MODIFY COLUMN `max_connections` int DEFAULT '100' COMMENT '最大连接',
  MODIFY COLUMN `connection_timeout_ms` int DEFAULT '30000' COMMENT '连接超时时间（毫秒）',
  MODIFY COLUMN `status` enum('active','inactive','error') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active' COMMENT '业务状态',
  MODIFY COLUMN `health_status` enum('healthy','warning','critical','unknown','error') COLLATE utf8mb4_unicode_ci DEFAULT 'unknown' COMMENT '健康状态',
  MODIFY COLUMN `last_health_check_at` datetime DEFAULT NULL COMMENT '最近健康检查时间',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `created_by` int unsigned DEFAULT NULL COMMENT '创建人用户 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `database_logs`
  COMMENT = '数据库日志采集表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `log_level` enum('info','warning','error','critical') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'info' COMMENT '日志级别',
  MODIFY COLUMN `source` enum('mysql_slow','mysql_error','pg_log','other') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'other' COMMENT '来源',
  MODIFY COLUMN `message` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '消息',
  MODIFY COLUMN `raw_content` text COLLATE utf8mb4_unicode_ci COMMENT '原始内容',
  MODIFY COLUMN `detected_patterns` json DEFAULT NULL COMMENT '检测模式',
  MODIFY COLUMN `collected_at` datetime NOT NULL COMMENT '采集时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `escalation_rules`
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `from_level` enum('info','warning','error','critical','p0') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '来源级别',
  MODIFY COLUMN `to_level` enum('info','warning','error','critical','p0') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'TO级别',
  MODIFY COLUMN `trigger_value` int NOT NULL COMMENT '触发值',
  MODIFY COLUMN `notification_channel_ids` json DEFAULT NULL COMMENT '通知渠道 ID 列表',
  MODIFY COLUMN `enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `fault_diagnoses`
  COMMENT = '故障诊断记录表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `fault_type` enum('connection_storm','lock_contention','slow_query','replication_lag','disk_full','memory_pressure','cpu_spike','custom') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '故障类型',
  MODIFY COLUMN `fault_name` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '故障名称',
  MODIFY COLUMN `severity` enum('low','medium','high','critical') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '严重级别',
  MODIFY COLUMN `diagnosis` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '诊断结论',
  MODIFY COLUMN `evidence` json DEFAULT NULL COMMENT '判定依据',
  MODIFY COLUMN `solution` text COLLATE utf8mb4_unicode_ci COMMENT '解决方案',
  MODIFY COLUMN `status` enum('pending','investigating','resolved','dismissed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '业务状态',
  MODIFY COLUMN `auto_heal_possible` tinyint(1) DEFAULT '0' COMMENT '自动恢复可行',
  MODIFY COLUMN `actions_taken` json DEFAULT NULL COMMENT '操作已执行',
  MODIFY COLUMN `healed` tinyint(1) DEFAULT '0' COMMENT '是否已恢复',
  MODIFY COLUMN `healed_at` datetime DEFAULT NULL COMMENT '已恢复时间',
  MODIFY COLUMN `resolved_by` int unsigned DEFAULT NULL COMMENT '解决人用户 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `health_check_history`
  COMMENT = '健康检查历史表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `status` enum('healthy','warning','critical','unknown') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '业务状态',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `index_info`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `table_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '表名称',
  MODIFY COLUMN `index_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '索引名称',
  MODIFY COLUMN `column_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '字段名称',
  MODIFY COLUMN `seq_in_index` int DEFAULT '0' COMMENT '序号IN索引',
  MODIFY COLUMN `non_unique` tinyint DEFAULT '1' COMMENT '非唯一',
  MODIFY COLUMN `cardinality` bigint DEFAULT '0' COMMENT '基数',
  MODIFY COLUMN `nullable` varchar(3) COLLATE utf8mb4_unicode_ci DEFAULT 'YES' COMMENT '可空',
  MODIFY COLUMN `index_type` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT 'BTREE' COMMENT '索引类型',
  MODIFY COLUMN `comment` text COLLATE utf8mb4_unicode_ci COMMENT '注释',
  MODIFY COLUMN `collected_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '采集时间',
  MODIFY COLUMN `is_unused` tinyint(1) DEFAULT '0' COMMENT '是否未被使用';

ALTER TABLE `index_redundancy_report`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `table_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '表名称',
  MODIFY COLUMN `redundant_index` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '冗余索引',
  MODIFY COLUMN `covered_by_index` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '覆盖BY索引',
  MODIFY COLUMN `reason` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '原因说明',
  MODIFY COLUMN `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `instance_permissions`
  COMMENT = '用户实例访问授权表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `user_id` int unsigned NOT NULL COMMENT '用户 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `access_level` enum('read-only','read-write','admin') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'read-only' COMMENT '访问级别',
  MODIFY COLUMN `grant_expiry` datetime DEFAULT NULL COMMENT '授权有效期';

ALTER TABLE `instance_pool_stats`
  COMMENT = '实例连接池状态表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `active_connections` int DEFAULT '0' COMMENT '活跃连接',
  MODIFY COLUMN `idle_connections` int DEFAULT '0' COMMENT '空闲连接',
  MODIFY COLUMN `waiting_requests` int DEFAULT '0' COMMENT '等待请求',
  MODIFY COLUMN `recorded_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间';

ALTER TABLE `instance_templates`
  COMMENT = '实例指标模板关联表',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `template_id` int unsigned NOT NULL COMMENT '模板 ID',
  MODIFY COLUMN `macro_overrides` json DEFAULT NULL COMMENT '宏变量覆盖值',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `llm_providers`
  COMMENT = '大语言模型服务提供方配置表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `display_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '显示名称',
  MODIFY COLUMN `api_key_encrypted` text COLLATE utf8mb4_unicode_ci COMMENT '加密后的 API 密钥',
  MODIFY COLUMN `api_base_url` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'API 基础地址',
  MODIFY COLUMN `default_model` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '默认模型',
  MODIFY COLUMN `enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `is_default` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否为默认项',
  MODIFY COLUMN `temperature` decimal(3,2) DEFAULT '0.70' COMMENT '模型采样温度',
  MODIFY COLUMN `max_tokens` int DEFAULT '2048' COMMENT '单次最大令牌数',
  MODIFY COLUMN `timeout_ms` int DEFAULT '30000' COMMENT '超时时间（毫秒）',
  MODIFY COLUMN `rate_limit_per_minute` int DEFAULT '60' COMMENT '每分钟调用限额',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  MODIFY COLUMN `supports_function_call` tinyint(1) DEFAULT '0' COMMENT '是否支持工具调用',
  MODIFY COLUMN `supports_vision` tinyint(1) DEFAULT '0' COMMENT '是否支持视觉输入';

ALTER TABLE `llm_quota_alerts`
  COMMENT = '大语言模型配额告警配置表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `provider_id` int unsigned NOT NULL COMMENT '提供方 ID',
  MODIFY COLUMN `alert_type` enum('daily_quota','cost_limit','rate_limit') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '告警类型',
  MODIFY COLUMN `enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `last_triggered_at` datetime DEFAULT NULL COMMENT '最近触发时间',
  MODIFY COLUMN `trigger_count_today` int DEFAULT '0' COMMENT '触发数量当日',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `llm_usage_daily_stats`
  COMMENT = '大语言模型日用量统计表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `provider_id` int unsigned NOT NULL COMMENT '提供方 ID',
  MODIFY COLUMN `provider_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '提供方名称',
  MODIFY COLUMN `model` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '模型名称',
  MODIFY COLUMN `date` date NOT NULL COMMENT '统计日期',
  MODIFY COLUMN `total_requests` int NOT NULL DEFAULT '0' COMMENT '总计请求',
  MODIFY COLUMN `total_input_tokens` bigint NOT NULL DEFAULT '0' COMMENT '总计输入令牌',
  MODIFY COLUMN `total_output_tokens` bigint NOT NULL DEFAULT '0' COMMENT '总计输出令牌',
  MODIFY COLUMN `total_tokens` bigint NOT NULL DEFAULT '0' COMMENT '令牌总数',
  MODIFY COLUMN `total_cost_usd` decimal(10,6) DEFAULT '0.000000' COMMENT '总计成本（美元）',
  MODIFY COLUMN `failed_requests` int DEFAULT '0' COMMENT '失败请求',
  MODIFY COLUMN `avg_duration_ms` int DEFAULT '0' COMMENT '平均持续时间（毫秒）';

ALTER TABLE `llm_usage_records`
  COMMENT = '大语言模型调用用量明细表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `provider_id` int unsigned NOT NULL COMMENT '提供方 ID',
  MODIFY COLUMN `provider_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '提供方名称',
  MODIFY COLUMN `model` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '模型名称',
  MODIFY COLUMN `user_id` int unsigned DEFAULT NULL COMMENT '用户 ID',
  MODIFY COLUMN `session_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '会话 ID',
  MODIFY COLUMN `instance_id` int unsigned DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `input_tokens` int NOT NULL DEFAULT '0' COMMENT '输入令牌数',
  MODIFY COLUMN `output_tokens` int NOT NULL DEFAULT '0' COMMENT '输出令牌数',
  MODIFY COLUMN `total_tokens` int NOT NULL DEFAULT '0' COMMENT '令牌总数',
  MODIFY COLUMN `cost_usd` decimal(10,6) DEFAULT '0.000000' COMMENT '调用成本（美元）',
  MODIFY COLUMN `duration_ms` int DEFAULT '0' COMMENT '持续时间（毫秒）',
  MODIFY COLUMN `status` enum('success','error') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'success' COMMENT '业务状态',
  MODIFY COLUMN `error_message` text COLLATE utf8mb4_unicode_ci COMMENT '错误信息',
  MODIFY COLUMN `purpose` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '调用用途',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `maintenance_windows`
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `start_time` time NOT NULL COMMENT '开始时间',
  MODIFY COLUMN `end_time` time NOT NULL COMMENT '结束时间',
  MODIFY COLUMN `timezone` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Asia/Shanghai' COMMENT '时区',
  MODIFY COLUMN `enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `metric_baselines`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `metric_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '指标编码',
  MODIFY COLUMN `mean_val` decimal(15,4) DEFAULT NULL COMMENT '均值值',
  MODIFY COLUMN `stddev_val` decimal(15,4) DEFAULT NULL COMMENT '标准差值',
  MODIFY COLUMN `sigma` decimal(3,1) NOT NULL DEFAULT '2.0' COMMENT '标准差倍数',
  MODIFY COLUMN `lookback_days` int NOT NULL DEFAULT '7' COMMENT '回看天数',
  MODIFY COLUMN `sample_count` int DEFAULT NULL COMMENT '样本数量',
  MODIFY COLUMN `computed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '计算时间';

ALTER TABLE `metric_definitions`
  MODIFY COLUMN `target_type` enum('instance','server') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'instance' COMMENT '目标类型',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `aggregation` enum('avg','max','min','sum','last') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'avg' COMMENT '聚合方式',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  MODIFY COLUMN `collection_sqls` json DEFAULT NULL COMMENT '各数据库类型的采集 SQL JSON',
  MODIFY COLUMN `compute_expr` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '计算表达式',
  MODIFY COLUMN `template_id` int unsigned DEFAULT NULL COMMENT '模板 ID';

ALTER TABLE `metric_templates`
  COMMENT = '指标模板表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `db_type` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '数据库类型',
  MODIFY COLUMN `macro_defaults` json DEFAULT NULL COMMENT '宏变量默认值',
  MODIFY COLUMN `enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `created_by` int unsigned DEFAULT NULL COMMENT '创建人用户 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `metrics_history`
  COMMENT = '数据库指标历史表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `active_transactions` int DEFAULT '0' COMMENT '活跃事务',
  MODIFY COLUMN `slow_queries` int DEFAULT '0' COMMENT '慢查询查询',
  MODIFY COLUMN `threads_running` int DEFAULT '0' COMMENT '线程运行',
  MODIFY COLUMN `threads_connected` int DEFAULT '0' COMMENT '线程已连接',
  MODIFY COLUMN `bytes_received` bigint DEFAULT '0' COMMENT '字节接收',
  MODIFY COLUMN `bytes_sent` bigint DEFAULT '0' COMMENT '字节发送',
  MODIFY COLUMN `queries_total` bigint DEFAULT '0' COMMENT '查询总计',
  MODIFY COLUMN `commits_total` bigint DEFAULT '0' COMMENT '提交事务总计',
  MODIFY COLUMN `rollbacks_total` bigint DEFAULT '0' COMMENT '回滚事务总计',
  MODIFY COLUMN `recorded_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
  MODIFY COLUMN `table_open_cache_hit_rate` decimal(5,2) DEFAULT NULL COMMENT '表打开缓存命中率',
  MODIFY COLUMN `handler_read_rnd_next` bigint DEFAULT NULL COMMENT '处理器读取随机读下次',
  MODIFY COLUMN `handler_read_rnd_next_rate` decimal(10,2) DEFAULT NULL COMMENT '处理器读取随机读下次率',
  MODIFY COLUMN `key_blocks_usage` decimal(5,2) DEFAULT NULL COMMENT '键块用量',
  MODIFY COLUMN `open_files` int DEFAULT NULL COMMENT '打开文件',
  MODIFY COLUMN `aborted_connects` int DEFAULT NULL COMMENT '异常中止连接',
  MODIFY COLUMN `aborted_connects_rate` decimal(10,2) DEFAULT NULL COMMENT '异常中止连接率',
  MODIFY COLUMN `idx_scan_ratio` decimal(5,2) DEFAULT NULL COMMENT '索引扫描比例',
  MODIFY COLUMN `dead_tuples` bigint DEFAULT NULL COMMENT '死元组',
  MODIFY COLUMN `cache_hit_ratio` decimal(5,2) DEFAULT NULL COMMENT '缓存命中比例',
  MODIFY COLUMN `connections_used` int DEFAULT NULL COMMENT '连接使用',
  MODIFY COLUMN `connections_max` int DEFAULT NULL COMMENT '连接最大',
  MODIFY COLUMN `vacuum_count` int DEFAULT NULL COMMENT '清理数量',
  MODIFY COLUMN `autovacuum_count` int DEFAULT NULL COMMENT '自动清理数量',
  MODIFY COLUMN `replication_lag_seconds` decimal(10,2) DEFAULT NULL COMMENT '复制延迟秒',
  MODIFY COLUMN `data_size_gb` decimal(10,2) DEFAULT NULL COMMENT '数据大小（GB）',
  MODIFY COLUMN `is_estimated` tinyint(1) DEFAULT '0' COMMENT '是否为估算值';

ALTER TABLE `notification_channels`
  COMMENT = '通知渠道配置表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `type` enum('email','dingtalk','wecom','feishu','webhook') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '业务类型',
  MODIFY COLUMN `enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `delivery_start_at` datetime NOT NULL COMMENT '投递开始时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `notification_delivery_attempts`
  COMMENT = '告警通知投递尝试表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `workflow_job_id` char(36) NOT NULL COMMENT '工作流任务 ID',
  MODIFY COLUMN `alert_id` bigint unsigned NOT NULL COMMENT '告警 ID',
  MODIFY COLUMN `channel_id` int unsigned NOT NULL COMMENT '渠道 ID',
  MODIFY COLUMN `attempt_number` int unsigned NOT NULL COMMENT '尝试编号',
  MODIFY COLUMN `status` enum('started','sent','failed') NOT NULL COMMENT '业务状态',
  MODIFY COLUMN `error_code` varchar(128) DEFAULT NULL COMMENT '错误代码',
  MODIFY COLUMN `error_message` varchar(1024) DEFAULT NULL COMMENT '错误信息',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `finished_at` datetime DEFAULT NULL COMMENT '结束时间';

ALTER TABLE `notification_delivery_replays`
  COMMENT = '告警通知重放记录表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `workflow_job_id` char(36) NOT NULL COMMENT '工作流任务 ID',
  MODIFY COLUMN `actor_id` int unsigned NOT NULL COMMENT '操作人 ID',
  MODIFY COLUMN `reason` varchar(512) NOT NULL COMMENT '原因说明',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `notification_records`
  COMMENT = '通知发送记录表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `alert_id` bigint unsigned NOT NULL COMMENT '告警 ID',
  MODIFY COLUMN `channel_id` int unsigned NOT NULL COMMENT '渠道 ID',
  MODIFY COLUMN `status` enum('pending','sent','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '业务状态',
  MODIFY COLUMN `error` text COLLATE utf8mb4_unicode_ci COMMENT '错误信息',
  MODIFY COLUMN `sent_at` datetime DEFAULT NULL COMMENT '发送时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `operation_events`
  COMMENT = '运维操作状态事件表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `operation_id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '运维操作 ID',
  MODIFY COLUMN `from_state` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '来源状态',
  MODIFY COLUMN `to_state` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'TO状态',
  MODIFY COLUMN `reason_code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '原因代码',
  MODIFY COLUMN `actor_id` int unsigned DEFAULT NULL COMMENT '操作人 ID',
  MODIFY COLUMN `metadata` json DEFAULT NULL COMMENT '扩展元数据',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `operations`
  COMMENT = '运维操作主表',
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `actor_id` int unsigned NOT NULL COMMENT '操作人 ID',
  MODIFY COLUMN `origin` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '来源',
  MODIFY COLUMN `resource_type` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '资源类型',
  MODIFY COLUMN `resource_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '资源 ID',
  MODIFY COLUMN `command_type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '命令类型',
  MODIFY COLUMN `risk` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '风险',
  MODIFY COLUMN `idempotency_key` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '幂等键',
  MODIFY COLUMN `approval_id` bigint unsigned DEFAULT NULL COMMENT '审批 ID',
  MODIFY COLUMN `correlation_id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '关联 ID',
  MODIFY COLUMN `state` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '处理状态',
  MODIFY COLUMN `attempt` int unsigned NOT NULL DEFAULT '1' COMMENT '尝试',
  MODIFY COLUMN `lease_owner` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '租约所有人',
  MODIFY COLUMN `lease_expires_at` datetime DEFAULT NULL COMMENT '租约失效时间',
  MODIFY COLUMN `result_json` json DEFAULT NULL COMMENT '执行结果 JSON',
  MODIFY COLUMN `error_json` json DEFAULT NULL COMMENT '错误信息 JSON',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  MODIFY COLUMN `finished_at` datetime DEFAULT NULL COMMENT '结束时间';

ALTER TABLE `outbox_events`
  COMMENT = '事务消息发件箱表',
  MODIFY COLUMN `id` char(36) NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `event_type` varchar(128) NOT NULL COMMENT '事件类型',
  MODIFY COLUMN `schema_version` int unsigned NOT NULL COMMENT '数据结构版本',
  MODIFY COLUMN `aggregate_type` varchar(64) NOT NULL COMMENT '聚合对象类型',
  MODIFY COLUMN `aggregate_id` varchar(128) NOT NULL COMMENT '聚合对象 ID',
  MODIFY COLUMN `aggregate_version` bigint unsigned NOT NULL COMMENT '聚合对象版本',
  MODIFY COLUMN `payload` json NOT NULL COMMENT '事件载荷',
  MODIFY COLUMN `idempotency_key` varchar(255) NOT NULL COMMENT '幂等键',
  MODIFY COLUMN `available_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '可处理时间',
  MODIFY COLUMN `published_at` datetime DEFAULT NULL COMMENT '发布时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `permissions`
  COMMENT = '权限定义表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '说明',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `refresh_tokens`
  COMMENT = '登录刷新令牌表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `token_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '令牌 SHA-256 哈希值',
  MODIFY COLUMN `user_id` int unsigned NOT NULL COMMENT '用户 ID',
  MODIFY COLUMN `expires_at` datetime NOT NULL COMMENT '失效时间',
  MODIFY COLUMN `revoked` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否已撤销',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `report_configs`
  COMMENT = '报告生成配置表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `type` enum('health','performance','slow_query','capacity','server_health') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'health' COMMENT '业务类型',
  MODIFY COLUMN `instance_id` int unsigned DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `server_id` int unsigned DEFAULT NULL COMMENT '服务器 ID',
  MODIFY COLUMN `notification_channel_ids` json DEFAULT NULL COMMENT '通知渠道 ID 列表',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `report_notification_deliveries`
  COMMENT = '报告通知投递记录表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `workflow_job_id` varchar(128) NOT NULL COMMENT '工作流任务 ID',
  MODIFY COLUMN `report_id` bigint unsigned NOT NULL COMMENT '报告 ID',
  MODIFY COLUMN `channel_id` int unsigned NOT NULL COMMENT '渠道 ID',
  MODIFY COLUMN `attempt_number` int unsigned NOT NULL COMMENT '尝试编号',
  MODIFY COLUMN `status` enum('started','sent','failed','skipped') NOT NULL COMMENT '业务状态',
  MODIFY COLUMN `error_code` varchar(128) DEFAULT NULL COMMENT '错误代码',
  MODIFY COLUMN `error_message` varchar(1024) DEFAULT NULL COMMENT '错误信息',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `finished_at` datetime DEFAULT NULL COMMENT '结束时间';

ALTER TABLE `report_schedule_occurrences`
  COMMENT = '报告调度实例表',
  MODIFY COLUMN `config_id` int unsigned NOT NULL COMMENT '配置 ID',
  MODIFY COLUMN `occurrence_at` datetime NOT NULL COMMENT '调度实例时间',
  MODIFY COLUMN `state` enum('queued','running','completed','failed') NOT NULL DEFAULT 'queued' COMMENT '处理状态',
  MODIFY COLUMN `report_id` bigint unsigned DEFAULT NULL COMMENT '报告 ID',
  MODIFY COLUMN `last_error` text COMMENT '最近错误',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `reports`
  COMMENT = '运维报告表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `type` enum('health','performance','slow_query','capacity','audit','custom','server_health') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '业务类型',
  MODIFY COLUMN `format` enum('pdf','html','json','csv') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'html' COMMENT '输出格式',
  MODIFY COLUMN `instance_id` int unsigned DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `server_id` int unsigned DEFAULT NULL COMMENT '服务器 ID',
  MODIFY COLUMN `content` longtext COLLATE utf8mb4_unicode_ci COMMENT '内容正文',
  MODIFY COLUMN `data` json DEFAULT NULL COMMENT '业务数据',
  MODIFY COLUMN `generated_by` int unsigned DEFAULT NULL COMMENT '生成人用户 ID',
  MODIFY COLUMN `status` enum('pending','completed','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '业务状态',
  MODIFY COLUMN `scheduled_at` datetime DEFAULT NULL COMMENT '计划执行时间',
  MODIFY COLUMN `expires_at` datetime DEFAULT NULL COMMENT '失效时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `resource_capabilities`
  COMMENT = '资源能力探测结果表',
  MODIFY COLUMN `resource_type` enum('instance','server') NOT NULL COMMENT '资源类型',
  MODIFY COLUMN `resource_id` bigint unsigned NOT NULL COMMENT '资源 ID',
  MODIFY COLUMN `capability_key` varchar(128) NOT NULL COMMENT '能力键',
  MODIFY COLUMN `state` enum('declared','configured','verified','degraded','unsupported') NOT NULL COMMENT '处理状态',
  MODIFY COLUMN `evidence` json DEFAULT NULL COMMENT '判定依据',
  MODIFY COLUMN `reason` varchar(512) DEFAULT NULL COMMENT '原因说明',
  MODIFY COLUMN `checked_at` datetime NOT NULL COMMENT '检查时间',
  MODIFY COLUMN `valid_until` datetime DEFAULT NULL COMMENT '有效截止';

ALTER TABLE `resource_relations`
  COMMENT = '运维资源关系表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `source_type` enum('instance','server') NOT NULL COMMENT '来源类型',
  MODIFY COLUMN `source_id` bigint unsigned NOT NULL COMMENT '来源 ID',
  MODIFY COLUMN `target_type` enum('instance','server') NOT NULL COMMENT '目标类型',
  MODIFY COLUMN `target_id` bigint unsigned NOT NULL COMMENT '目标 ID',
  MODIFY COLUMN `relation_type` enum('runs_on','hosts','replicates_to','depends_on') NOT NULL COMMENT '关系类型',
  MODIFY COLUMN `provenance` varchar(64) NOT NULL COMMENT '来源依据',
  MODIFY COLUMN `valid_from` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '有效来源',
  MODIFY COLUMN `valid_until` datetime DEFAULT NULL COMMENT '有效截止';

ALTER TABLE `role_permissions`
  COMMENT = '角色权限关联表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `role_id` int unsigned NOT NULL COMMENT '角色 ID',
  MODIFY COLUMN `permission_id` int unsigned NOT NULL COMMENT '权限 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `roles`
  COMMENT = '角色定义表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '说明',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `schema_snapshots`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `snapshot_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '快照时间',
  MODIFY COLUMN `table_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '表名称',
  MODIFY COLUMN `column_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '字段名称',
  MODIFY COLUMN `column_type` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '字段类型',
  MODIFY COLUMN `is_nullable` varchar(3) COLLATE utf8mb4_unicode_ci DEFAULT 'YES' COMMENT '是否允许为空',
  MODIFY COLUMN `column_default` text COLLATE utf8mb4_unicode_ci COMMENT '字段默认',
  MODIFY COLUMN `column_key` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '字段键',
  MODIFY COLUMN `extra` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '扩展属性',
  MODIFY COLUMN `column_comment` text COLLATE utf8mb4_unicode_ci COMMENT '字段注释',
  MODIFY COLUMN `table_comment` text COLLATE utf8mb4_unicode_ci COMMENT '表注释',
  MODIFY COLUMN `table_rows` bigint DEFAULT '0' COMMENT '表行',
  MODIFY COLUMN `data_length` bigint DEFAULT '0' COMMENT '数据长度';

ALTER TABLE `security_events`
  COMMENT = '安全事件审计表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `event_type` varchar(64) NOT NULL COMMENT '事件类型',
  MODIFY COLUMN `reason_code` varchar(96) NOT NULL COMMENT '原因代码',
  MODIFY COLUMN `actor_id` bigint DEFAULT NULL COMMENT '操作人 ID',
  MODIFY COLUMN `resource_type` varchar(64) DEFAULT NULL COMMENT '资源类型',
  MODIFY COLUMN `resource_id` varchar(128) DEFAULT NULL COMMENT '资源 ID',
  MODIFY COLUMN `request_id` varchar(128) DEFAULT NULL COMMENT '请求 ID',
  MODIFY COLUMN `fingerprint` char(64) NOT NULL COMMENT '指纹',
  MODIFY COLUMN `occurrence_count` int unsigned NOT NULL DEFAULT '1' COMMENT '调度实例数量',
  MODIFY COLUMN `first_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '首次发现时间',
  MODIFY COLUMN `last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '最近发现时间';

ALTER TABLE `server_metrics`
  COMMENT = '服务器指标历史表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `server_id` int unsigned NOT NULL COMMENT '服务器 ID',
  MODIFY COLUMN `dimensions` json DEFAULT NULL COMMENT '指标维度 JSON',
  MODIFY COLUMN `recorded_at` datetime NOT NULL COMMENT '记录时间';

ALTER TABLE `servers`
  COMMENT = '纳管服务器表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `status` enum('online','offline','error','unreachable') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'offline' COMMENT '业务状态',
  MODIFY COLUMN `last_check_at` datetime DEFAULT NULL COMMENT '最近检查时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `silence_periods`
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `metric_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '指标编码',
  MODIFY COLUMN `silenced_until` datetime NOT NULL COMMENT '静默截止',
  MODIFY COLUMN `created_by_alert_id` bigint unsigned DEFAULT NULL COMMENT '创建BY告警 ID',
  MODIFY COLUMN `reason` text COLLATE utf8mb4_unicode_ci COMMENT '原因说明',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `skill_executions`
  COMMENT = '技能执行任务表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `skill_id` int unsigned NOT NULL COMMENT '技能 ID',
  MODIFY COLUMN `execution_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '执行 ID',
  MODIFY COLUMN `instance_id` int unsigned DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `user_id` int unsigned DEFAULT NULL COMMENT '用户 ID',
  MODIFY COLUMN `status` enum('pending','running','completed','failed') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '业务状态',
  MODIFY COLUMN `progress` int DEFAULT '0' COMMENT '执行进度',
  MODIFY COLUMN `message` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '消息',
  MODIFY COLUMN `args` json DEFAULT NULL COMMENT '调用参数',
  MODIFY COLUMN `result` json DEFAULT NULL COMMENT '执行结果',
  MODIFY COLUMN `error` text COLLATE utf8mb4_unicode_ci COMMENT '错误信息',
  MODIFY COLUMN `started_at` datetime DEFAULT NULL COMMENT '开始时间',
  MODIFY COLUMN `completed_at` datetime DEFAULT NULL COMMENT '完成时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `skills`
  COMMENT = '智能体技能定义表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '名称',
  MODIFY COLUMN `display_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '显示名称',
  MODIFY COLUMN `description` text COLLATE utf8mb4_unicode_ci COMMENT '说明',
  MODIFY COLUMN `category` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '分类',
  MODIFY COLUMN `enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否启用',
  MODIFY COLUMN `config_schema` json DEFAULT NULL COMMENT '配置结构定义 JSON',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `slow_queries`
  COMMENT = '慢 SQL 记录表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `sql_text` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'SQL 文本',
  MODIFY COLUMN `avg_time_ms` decimal(10,2) DEFAULT '0.00' COMMENT '平均时间（毫秒）',
  MODIFY COLUMN `max_time_ms` decimal(10,2) DEFAULT '0.00' COMMENT '最大时间（毫秒）',
  MODIFY COLUMN `min_time_ms` decimal(10,2) DEFAULT '0.00' COMMENT '最小时间（毫秒）',
  MODIFY COLUMN `execution_count` bigint DEFAULT '1' COMMENT '执行数量',
  MODIFY COLUMN `total_time_ms` decimal(12,2) DEFAULT '0.00' COMMENT '总计时间（毫秒）',
  MODIFY COLUMN `rows_examined` bigint DEFAULT '0' COMMENT '行扫描',
  MODIFY COLUMN `rows_sent` bigint DEFAULT '0' COMMENT '行发送',
  MODIFY COLUMN `first_seen` datetime DEFAULT NULL COMMENT '首次发现',
  MODIFY COLUMN `last_seen` datetime DEFAULT NULL COMMENT '最近发现',
  MODIFY COLUMN `schema_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '元数据结构名称',
  MODIFY COLUMN `user_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '用户名称',
  MODIFY COLUMN `host_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '主机名称',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `slow_query_analysis`
  COMMENT = '慢 SQL 分析结果表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `slow_query_id` bigint unsigned NOT NULL COMMENT '慢查询查询 ID',
  MODIFY COLUMN `analysis_type` enum('index_recommend','rewrite_suggest','config_tune') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '分析类型',
  MODIFY COLUMN `analysis_result` json NOT NULL COMMENT '分析结果',
  MODIFY COLUMN `recommendation` text COLLATE utf8mb4_unicode_ci COMMENT '处置建议',
  MODIFY COLUMN `estimated_improvement` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '预估改进幅度',
  MODIFY COLUMN `analyzed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '分析时间',
  MODIFY COLUMN `analyzed_by` int unsigned DEFAULT NULL COMMENT '分析人用户 ID';

ALTER TABLE `sql_audit_records`
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `instance_id` int unsigned NOT NULL COMMENT '实例 ID',
  MODIFY COLUMN `status` enum('pending','running','completed','failed','reviewed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '业务状态',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `sql_execution_history`
  COMMENT = 'SQL 执行历史表',
  MODIFY COLUMN `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `user_id` int DEFAULT NULL COMMENT '用户 ID',
  MODIFY COLUMN `username` varchar(100) DEFAULT NULL COMMENT '登录用户名',
  MODIFY COLUMN `instance_id` int DEFAULT NULL COMMENT '实例 ID',
  MODIFY COLUMN `instance_name` varchar(200) DEFAULT NULL COMMENT '实例名称',
  MODIFY COLUMN `db_type` varchar(20) DEFAULT NULL COMMENT '数据库类型',
  MODIFY COLUMN `database_name` varchar(100) DEFAULT NULL COMMENT '数据库名称',
  MODIFY COLUMN `sql_text` text COMMENT 'SQL 文本',
  MODIFY COLUMN `status` varchar(20) DEFAULT 'success' COMMENT '业务状态',
  MODIFY COLUMN `duration_ms` int DEFAULT '0' COMMENT '持续时间（毫秒）',
  MODIFY COLUMN `row_count` int DEFAULT '0' COMMENT '行数量',
  MODIFY COLUMN `error_message` text COMMENT '错误信息',
  MODIFY COLUMN `ip_address` varchar(45) DEFAULT NULL COMMENT '客户端 IP 地址',
  MODIFY COLUMN `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `system_config`
  COMMENT = '系统配置表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `config_key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '配置项编码',
  MODIFY COLUMN `config_value` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '配置项值',
  MODIFY COLUMN `value_type` enum('string','number','boolean','json') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'string' COMMENT '值类型',
  MODIFY COLUMN `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '说明',
  MODIFY COLUMN `updated_by` int unsigned DEFAULT NULL COMMENT '更新人用户 ID',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `user_action_logs`
  COMMENT = '用户操作日志表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `user_id` int unsigned NOT NULL COMMENT '用户 ID',
  MODIFY COLUMN `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录用户名',
  MODIFY COLUMN `resource_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '资源 ID',
  MODIFY COLUMN `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '客户端 IP 地址',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `user_login_logs`
  COMMENT = '用户登录日志表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `user_id` int unsigned NOT NULL COMMENT '用户 ID',
  MODIFY COLUMN `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录用户名',
  MODIFY COLUMN `login_status` enum('success','failed') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录状态',
  MODIFY COLUMN `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '客户端 IP 地址',
  MODIFY COLUMN `user_agent` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '客户端 User-Agent',
  MODIFY COLUMN `failure_reason` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '失败原因',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';

ALTER TABLE `user_preferences`
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `user_id` int unsigned NOT NULL COMMENT '用户 ID',
  MODIFY COLUMN `preferences` json NOT NULL COMMENT '用户偏好 JSON',
  MODIFY COLUMN `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `user_roles`
  COMMENT = '用户角色关联表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `user_id` int unsigned NOT NULL COMMENT '用户 ID',
  MODIFY COLUMN `role_id` int unsigned NOT NULL COMMENT '角色 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `grant_expiry` datetime DEFAULT NULL COMMENT '授权有效期';

ALTER TABLE `users`
  COMMENT = '系统用户表',
  MODIFY COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录用户名',
  MODIFY COLUMN `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '密码哈希值',
  MODIFY COLUMN `email` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '电子邮箱地址',
  MODIFY COLUMN `role_backup` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '历史角色备份字段',
  MODIFY COLUMN `status` enum('active','inactive','locked') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active' COMMENT '业务状态',
  MODIFY COLUMN `last_login_at` datetime DEFAULT NULL COMMENT '最近登录时间',
  MODIFY COLUMN `last_login_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '最近登录IP',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `worker_leases`
  COMMENT = '后台工作进程租约表',
  MODIFY COLUMN `lease_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '租约名称',
  MODIFY COLUMN `owner_id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '所有人 ID',
  MODIFY COLUMN `fencing_token` bigint unsigned NOT NULL DEFAULT '0' COMMENT '隔离栅栏令牌',
  MODIFY COLUMN `expires_at` datetime NOT NULL COMMENT '失效时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';

ALTER TABLE `workflow_attempts`
  COMMENT = '工作流执行尝试表',
  MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
  MODIFY COLUMN `job_id` char(36) NOT NULL COMMENT '任务 ID',
  MODIFY COLUMN `attempt_number` int unsigned NOT NULL COMMENT '尝试编号',
  MODIFY COLUMN `worker_id` char(36) NOT NULL COMMENT '工作进程 ID',
  MODIFY COLUMN `fencing_token` bigint unsigned NOT NULL COMMENT '隔离栅栏令牌',
  MODIFY COLUMN `state` enum('running','succeeded','failed','abandoned') NOT NULL COMMENT '处理状态',
  MODIFY COLUMN `error_message` text COMMENT '错误信息',
  MODIFY COLUMN `started_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '开始时间',
  MODIFY COLUMN `finished_at` datetime DEFAULT NULL COMMENT '结束时间';

ALTER TABLE `workflow_jobs`
  COMMENT = '工作流任务表',
  MODIFY COLUMN `id` char(36) NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `job_type` varchar(128) NOT NULL COMMENT '任务类型',
  MODIFY COLUMN `schema_version` int unsigned NOT NULL COMMENT '数据结构版本',
  MODIFY COLUMN `payload` json NOT NULL COMMENT '事件载荷',
  MODIFY COLUMN `idempotency_key` varchar(255) NOT NULL COMMENT '幂等键',
  MODIFY COLUMN `state` enum('queued','running','retry','completed','dead_letter','cancelled') NOT NULL DEFAULT 'queued' COMMENT '处理状态',
  MODIFY COLUMN `attempts` int unsigned NOT NULL DEFAULT '0' COMMENT '已尝试次数',
  MODIFY COLUMN `max_attempts` int unsigned NOT NULL DEFAULT '5' COMMENT '最大尝试次数',
  MODIFY COLUMN `available_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '可处理时间',
  MODIFY COLUMN `lease_owner` char(36) DEFAULT NULL COMMENT '租约所有人',
  MODIFY COLUMN `lease_expires_at` datetime DEFAULT NULL COMMENT '租约失效时间',
  MODIFY COLUMN `fencing_token` bigint unsigned NOT NULL DEFAULT '0' COMMENT '隔离栅栏令牌',
  MODIFY COLUMN `last_error` text COMMENT '最近错误',
  MODIFY COLUMN `completed_at` datetime DEFAULT NULL COMMENT '完成时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';
