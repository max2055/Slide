---
phase: 113-ai-cron-agent
plan: 01
subsystem: db-ops-api
tags: [cron, migration, types, service-layer, ai-agent]
requires: []
provides: [cron-task-description-column, cron-log-trace-columns, cron-crud-methods]
affects: [cron-manager, cron-executor, cron-job-handlers]
tech-stack:
  added: []
  patterns: []
key-files:
  created:
    - apps/db-ops-api/sql/migrations/010_add_task_description_log_columns.sql
  modified:
    - apps/db-ops-api/src/cron/types.ts
    - apps/db-ops-api/src/cron/cron-job-service.ts
decisions: []
metrics:
  duration: 5m
  completed: 2026-05-27T15:45+08:00
---

# Phase 113 Plan 01: Schema Migration + Type + Service Layer Summary

Migration SQL, type definitions, and database service layer for AI Agent Cron infrastructure. Replaces `handler` column with `task_description` (NL text), expands `cron_job_logs` with 8 agent trace columns, updates TypeScript types, and adds `createJob`/`deleteJob` methods to the service layer.

## Tasks Executed

### Task 1: SQL Migration (010_add_task_description_log_columns.sql)

Created transactional migration covering three changes:

- **ALTER TABLE cron_jobs** -- drops `handler` column, adds `task_description TEXT NOT NULL AFTER name`
- **ALTER TABLE cron_job_logs** -- extends `status` ENUM with `'timeout' | 'partial'`, adds 8 columns for agent execution trace: `result` (LONGTEXT), `tools_used` (JSON), `tool_events` (JSON), `usage` (JSON), `stop_reason` (VARCHAR(50)), `duration_ms` (INT), `error_trace` (TEXT), `partial_trace` (LONGTEXT)
- **13 UPDATE statements** -- converts hardcoded handler seed data to NL task descriptions sourced from RESEARCH.md. First 3 tasks (TopSQL, RCA analysis, fault diagnosis) remain `enabled=false` (previously gated by `ENABLE_AUTO_AI_ANALYSIS`)

All within `START TRANSACTION ... COMMIT`, matching the 009 migration header pattern.

**Commit:** `8fe9d6425d4`

### Task 2: Updated types.ts

- `CronJobStatus`: added `'timeout' | 'partial'` to the union
- `HandlerName` type: deleted entirely (13 hardcoded handlers removed per D-05)
- `CronJobConfig.handler`: replaced with `task_description: string`
- `CronJobLog`: added 8 new fields (`result`, `tools_used`, `tool_events`, `usage`, `stop_reason`, `duration_ms`, `error_trace`, `partial_trace`)
- New `AgentRunResult` interface added at file end for `CronExecutor` return type

**Commit:** `fa75dea0785`

### Task 3: Updated cron-job-service.ts

- **3 SELECT queries** (getJobs, getEnabledJobs, getJobById): `handler,` replaced with `task_description,`
- **completeLog()**: extended signature with optional `trace` parameter containing JSON-serializable agent execution data. SQL UPDATE now writes all trace columns. JSON fields serialized via `JSON.stringify()`; undefined fields pass `null`
- **updateJob()**: added `'task_description'` to updatable field Pick and corresponding conditional update logic
- **createJob()**: new method -- `INSERT INTO cron_jobs` with defaults (`timezone: 'Asia/Shanghai'`, `timeout_seconds: 300`), returns `insertId`. Throws if pool is not connected
- **deleteJob()**: new method -- `DELETE FROM cron_jobs WHERE id = ?`, returns `affectedRows > 0`. Returns false if pool is not connected
- **getLogs()**: SELECT expanded to include all 8 new trace columns

**Commit:** `617a781e787`

## Deviations from Plan

None -- plan executed exactly as written.

## Auth Gates

None encountered.

## Known Stubs

None.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes at trust boundaries were introduced beyond what the plan's threat model covered. Migration is transactional (START TRANSACTION/COMMIT). All existing route-level permission checks (`cron:view`, `cron:manage`) remain unchanged.

## Self-Check: PASSED

- `apps/db-ops-api/sql/migrations/010_add_task_description_log_columns.sql` -- exists, 6.4KB, 65 lines
- `apps/db-ops-api/src/cron/types.ts` -- exists, modified with all required changes
- `apps/db-ops-api/src/cron/cron-job-service.ts` -- exists, modified with all required changes
- Commits verified: `8fe9d6425d4`, `fa75dea0785`, `617a781e787`
