---
phase: 112-frontend-cleanup-cron
plan: 02
subsystem: api, database
tags: cron, cron-job, sql-migration, mysql, rbac, cron-manager

requires: []
provides:
  - "cron_jobs / cron_job_logs / cron_job_params database tables with 13 seed records"
  - "CronJobDatabaseService with full CRUD for cron jobs and execution logs"
  - "CronManager: DB-driven scheduler replacing 13 hardcoded CronJob blocks"
  - "13 handler functions wrapping original cron job logic"
  - "6 REST API endpoints for cron job management with RBAC permissions"
  - "cron:view and cron:manage permission codes"

affects:
  - "112-03-frontend (cron management UI tab)"
  - "Server startup sequence (CronManager.start() replaces individual cron blocks)"

tech-stack:
  added: []
  patterns:
    - "DatabaseService singleton pattern for CRUD operations"
    - "Handler dispatch table (string name -> handler function)"
    - "Concurrency guard via Set for overlapping cron execution prevention"

key-files:
  created:
    - "apps/db-ops-api/sql/migrations/009_add_cron_jobs_tables.sql"
    - "apps/db-ops-api/run-migration-009.ts"
    - "apps/db-ops-api/src/cron/types.ts"
    - "apps/db-ops-api/src/cron/cron-job-service.ts"
    - "apps/db-ops-api/src/cron/cron-job-handlers.ts"
    - "apps/db-ops-api/src/cron/cron-manager.ts"
  modified:
    - "apps/db-ops-api/server.ts"

key-decisions:
  - "Handler name validation at CronManager startup: warn for unknown handler names (Pitfall 3)"
  - "Concurrency guard (runningFlags Set) to prevent overlapping job execution (Pitfall 5)"
  - "Parameterized queries in all SQL operations (Security Domain)"
  - "runningFlags maintained in CronManager, dedup state (topsqlProcessedKeys, rcaProcessedAlerts) in handler module scope"

patterns-established:
  - "CronManager constructor takes CronJobDatabaseService for DI/testability"
  - "Each handler wrapped in try/catch - no exceptions propagate to CronManager"
  - "Cron expression validation via try-catch new CronJob() before persisting"
  - "Reload on every config change (PUT/POST toggle triggers cronManager.reload())"

requirements-completed: []
---

# Phase 112 Plan 02: Backend Cron Jobs Infrastructure Summary

**SQL migration for cron_jobs/cron_job_logs/cron_job_params tables with 13 seed records, CronJobDatabaseService for full CRUD, CronManager scheduler replacing 13 hardcoded CronJob blocks, 6 REST API routes with RBAC permission checks, and handler dispatch for all 13 cron job types**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-27T11:05:00Z (worktree reset)
- **Completed:** 2026-05-27T11:25:00Z (estimated)
- **Tasks:** 3
- **Files modified:** 7 (6 created, 1 modified)

## Accomplishments

- Created 3 database tables (cron_jobs, cron_job_logs, cron_job_params) with migration 009 and 13 seed records matching the existing hardcoded CronJobs exactly
- Registered `cron:view` and `cron:manage` permission codes, assigned to dba role (admin already has wildcard)
- Built `CronJobDatabaseService` with 11 CRUD methods following the ReportConfigDatabaseService pattern
- Extracted all 13 cron job handler functions into a dispatch table with getHandler() lookup
- Built `CronManager` scheduler: reads enabled jobs from DB, schedules via cron.CronJob, prevents overlapping execution via runningFlags Set, logs all executions to cron_job_logs
- Replaced 260 lines of hardcoded CronJob blocks (13 individual new CronJob() calls) with `CronManager.start()` - 139 lines net added
- Added 6 REST API routes (list, get, update, toggle, manual run, logs) with JWT auth and RBAC permission checks
- Preserved alert escalation service, notification service comment, instance connection loading loop, and maintenance window cache refresh

## Task Commits

Each task was committed atomically:

1. **Task 1: SQL migration 009** - `108d9c5` (feat: migration file + runner)
2. **Task 2: Service + Manager + Handlers** - `706aeca` (feat: 4 src/cron/ files)
3. **Task 3: server.ts replacement** - `f97716c` (feat: CronManager init + API routes)

## Files Created/Modified

- `apps/db-ops-api/sql/migrations/009_add_cron_jobs_tables.sql` - 3 tables, 13 seed records, cron permission codes
- `apps/db-ops-api/run-migration-009.ts` - Migration runner following existing pattern
- `apps/db-ops-api/src/cron/types.ts` - CronJobConfig, CronJobLog, CronJobParam, HandlerName types
- `apps/db-ops-api/src/cron/cron-job-service.ts` - Full CRUD (getJobs, getEnabledJobs, getJobById, updateJob, toggleJob, updateRunResult, updateNextRun, startLog, completeLog, getLogs, getParams)
- `apps/db-ops-api/src/cron/cron-job-handlers.ts` - 13 handlers (topsqlAnalysis, rcaAnalysis, faultDiagnosis, capacityCollection, schemaCollection, indexCollection, baselineCalculation, baselineCleanup, logCollection, silenceCleanup, reportScheduling, escalationMonitoring, notificationCheck)
- `apps/db-ops-api/src/cron/cron-manager.ts` - CronManager class with start/stop/reload, concurrency guard, execution logging
- `apps/db-ops-api/server.ts` - Added imports, CronManager init, 6 API routes; removed 260 lines of hardcoded CronJobs

## Decisions Made

- **Handler-name validation at startup**: CronManager warns for unknown handler names from DB but doesn't crash, matching RESEARCH.md Pitfall 3 mitigation
- **Module-level dedup state**: topsqlProcessedKeys and rcaProcessedAlerts live in handler module scope (not CronManager) to preserve dedup state across reloads
- **Synchronous manual run**: POST /api/cron/jobs/:id/run executes the handler synchronously in the request lifecycle (per D-22, frontend will poll logs for result)
- **Only enabled=1 jobs scheduled**: CronManager.getEnabledJobs() feeds scheduleJob(), disabled jobs ignored until toggled on

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- **Worktree path safety**: Initial Write calls wrote to main repo (/Users/max/Coding/39-Slide/) instead of worktree (/Users/max/Coding/39-Slide/.claude/worktrees/agent-*/). Cleaning up and rewriting to correct path fixed it.
- **Node.js for bulk edits**: Edit tool had difficulty matching long multi-line strings with tabs. Used Node.js to remove the enableAutoAI block and data collection cron job blocks by line range.

## Stub Check

No stubs found - all 13 handlers have real implementations wrapping existing server.ts logic.

## Threat Surface Scan

No new threat flags beyond those documented in the plan's threat model. All SQL uses parameterized queries (T-112-06). All write routes are protected by requirePermission('cron:manage') (T-112-03). All read routes are protected by requirePermission('cron:view') (T-112-04). Cron expression validation on PUT is implemented (T-112-05). Concurrency guard via runningFlags Set prevents overlapping executions (T-112-08). No new npm packages added (T-112-SC).

## User Setup Required

**Manual migration step required after deploy:**
```bash
cd apps/db-ops-api && npx tsx run-migration-009.ts
```
This creates the 3 cron tables, inserts 13 seed records, and registers cron permission codes.

## Next Phase Readiness

- Backend cron infrastructure complete and ready for 112-03 (frontend cron management UI tab)
- All 6 API endpoints ready to be consumed by the Settings cron management tab
- Server startup no longer has hardcoded CronJob blocks - all config driven from DB
- CronManager logs execution results to cron_job_logs table for the frontend to display

## Self-Check: PASSED

All 6 created files verified on disk. All 3 commits verified in git log. All file claims match actual state.

---
*Phase: 112-frontend-cleanup-cron*
*Completed: 2026-05-27*
