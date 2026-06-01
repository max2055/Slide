-- ============================================
-- Migration 010: Task Description + Log Columns
-- Phase 113 - AI Agent Cron
-- ============================================
-- Purpose: Replace handler column with task_description (NL text)
--          and expand cron_job_logs with JSON columns for agent trace.
-- ============================================

START TRANSACTION;

-- =========================================================================
-- 1. Replace handler with task_description in cron_jobs
-- =========================================================================

ALTER TABLE cron_jobs
  DROP COLUMN handler,
  ADD COLUMN task_description TEXT NOT NULL AFTER name;

-- =========================================================================
-- 2. Expand cron_job_logs for agent execution trace
-- =========================================================================

ALTER TABLE cron_job_logs
  MODIFY COLUMN status ENUM('running','success','error','skipped','timeout','partial') NOT NULL DEFAULT 'running',
  ADD COLUMN result LONGTEXT AFTER result_summary,
  ADD COLUMN tools_used JSON AFTER result,
  ADD COLUMN tool_events JSON AFTER tools_used,
  ADD COLUMN `usage` JSON AFTER tool_events,
  ADD COLUMN stop_reason VARCHAR(50) AFTER usage,
  ADD COLUMN duration_ms INT AFTER stop_reason,
  ADD COLUMN error_trace TEXT AFTER duration_ms,
  ADD COLUMN partial_trace LONGTEXT AFTER error_trace;

-- =========================================================================
-- 3. Update seed data with NL task descriptions
--    First 3 tasks remain disabled (previously guarded by ENABLE_AUTO_AI_ANALYSIS)
-- =========================================================================

UPDATE cron_jobs SET task_description = 'Every 10 seconds, scan all active database instances for slow queries with average execution time >= 10 seconds. For each new slow query found, perform an automated AI analysis to identify optimization opportunities. Skip queries that have already been analyzed within the last 30 minutes. Call slide_complete_cron with your findings summary.' WHERE name = 'TopSQL 自动分析';

UPDATE cron_jobs SET task_description = 'Every 10 seconds, check for new alerts created within the last 30 seconds. For each alert matching configured severity levels (warning, error, critical) and active time windows, perform automated root cause analysis. Use database health checks, performance analysis, and diagnostic tools. Call slide_complete_cron with the RCA findings.' WHERE name = '告警 RCA 分析';

UPDATE cron_jobs SET task_description = 'Every 60 seconds, diagnose database instances that are reporting unhealthy status. For each affected instance, run comprehensive diagnostics: health check, performance analysis, connection check. Generate a diagnostic report with findings and recommendations. Call slide_complete_cron when diagnosis is complete.' WHERE name = '故障自动诊断';

UPDATE cron_jobs SET task_description = 'Every 5 minutes, collect capacity metrics from all active database instances. For each instance, query total storage size in GB, number of databases, and number of tables per database. Record the data for capacity trend analysis. Call slide_complete_cron with capacity summary.' WHERE name = '容量数据采集';

UPDATE cron_jobs SET task_description = 'Every 30 minutes, collect complete schema snapshots (tables, columns, indexes) from all active database instances. Detect and report schema changes since the last snapshot. Note any new tables, altered columns, or dropped objects. Call slide_complete_cron with schema change summary.' WHERE name = 'Schema 快照采集';

UPDATE cron_jobs SET task_description = 'Every 30 minutes (at :15 and :45 past each hour), collect index information from all active database instances. Gather index names, columns, types, and usage statistics. Call slide_complete_cron with the index inventory results.' WHERE name = '索引信息采集';

UPDATE cron_jobs SET task_description = 'Every day at 2:00 AM local time, calculate performance metric baselines for all database instances. For each instance, compute per-metric baselines for CPU usage, memory utilization, IOPS, query latency, and connection counts. Use historical data for the computation. Call slide_complete_cron with baseline computation results.' WHERE name = '基线计算';

UPDATE cron_jobs SET task_description = 'Every Sunday at 3:00 AM, clean up baseline data that is older than 30 days. Remove old baseline records to free storage space. Only keep the most recent 30 days of baseline data. Call slide_complete_cron when cleanup is complete.' WHERE name = '基线清理';

UPDATE cron_jobs SET task_description = 'Every 5 minutes, collect and store database logs from all available sources. Capture error logs, activity logs, and any diagnostic log output. Call slide_complete_cron with a summary of collected log entries.' WHERE name = '数据库日志采集';

UPDATE cron_jobs SET task_description = 'Every hour, check for expired alert silence rules. Remove any silence rules whose validity period has ended. Call slide_complete_cron with the count of expired rules cleaned.' WHERE name = '静默过期清理';

UPDATE cron_jobs SET task_description = 'Every 60 seconds, scan all enabled report configurations. For each configuration, check if the current time matches its cron schedule. If it matches, generate the scheduled report in the configured format (health, performance, slow_query, or capacity). Call slide_complete_cron with the report generation results.' WHERE name = '定时报表调度';

UPDATE cron_jobs SET task_description = 'Every 10 seconds, check alert escalation rules for any pending escalations. Process auto-escalation logic for unacknowledged alerts. This is a placeholder -- if escalation functionality is not yet implemented, report ''escalation monitoring running, no action needed''. Call slide_complete_cron with status.' WHERE name = '(预留) 升级规则监控';

UPDATE cron_jobs SET task_description = 'Every 30 seconds, check the notification queue for pending notifications. Process and deliver queued notifications to their configured channels. This is a placeholder -- if notification delivery is not yet implemented, report ''notification check running, no pending notifications''. Call slide_complete_cron with status.' WHERE name = '(预留) 通知推送检查';

COMMIT;
