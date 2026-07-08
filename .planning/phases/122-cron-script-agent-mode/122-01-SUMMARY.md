---
phase: 122-cron-script-agent-mode
plan: 01
subsystem: database, cron
tags: cron-scripts, script-mode, migration, cron-job-service, script-service
requires:
  - phase: 113
    provides: AI Agent Cron infrastructure, cron_jobs/cron_job_logs tables
provides:
  - Script storage layer (cron_scripts table + ScriptService CRUD)
  - Extended cron_jobs columns (task_type/script_id/target_instance_id)
  - 6 predefined seed scripts with SQL content for data collection
  - Auto-migration of existing 6 data-collection jobs to script mode
affects:
  - 122-02: Builds on this storage layer for CronManager script execution branch
  - 122-03: Relies on extended SELECTs and ScriptService for API endpoints + frontend
tech-stack:
  added: []
  patterns:
    - "ScriptService follows CronJobDatabaseService singleton pattern"
    - "Migration SQL follows existing numbered naming convention with comments/doc sections"
key-files:
  created:
    - apps/db-ops-api/sql/migrations/017_add_cron_scripts.sql
    - apps/db-ops-api/src/cron/script-service.ts
  modified:
    - apps/db-ops-api/src/cron/types.ts
    - apps/db-ops-api/src/cron/cron-job-service.ts
key-decisions:
  - "baseline_cleanup and silence_cleanup leave target_instance_id NULL (operate on Slide's own MySQL, not managed instances)"
  - "Seed scripts target_db_type='mysql' for all 6 (PG/Oracle/DM variants deferred to user-created scripts)"
  - "Followed existing CronJobDatabaseService pattern for ScriptService (getPool/isConnected, parameterized queries, singleton)"
requirements-completed: [SCRIPT-01, SCRIPT-02, SCRIPT-06]
duration: 8min
completed: 2026-06-26
---

# Phase 122 Plan 01: Script Storage Layer

**Migration SQL 017 creating cron_scripts table with 6 seed scripts, extending cron_jobs for dual-mode (script/agent), ScriptService CRUD, and updated CronJobService SELECTs**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-26T06:31:55Z (approx)
- **Completed:** 2026-06-26T06:39:55Z (approx)
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Migration SQL `017_add_cron_scripts.sql` (174 lines) -- creates cron_scripts table, extends cron_jobs with task_type/script_id/target_instance_id columns, inserts 6 seed scripts (capacity_collection, schema_collection, index_collection, baseline_cleanup, silence_cleanup, log_collection), auto-migrates 6 existing Chinese-named jobs to script mode
- Extended `CronJobConfig` type with `task_type: 'script' | 'agent'`, `script_id: number | null`, `target_instance_id: number | null`
- Added `CronScript`, `CreateScriptInput`, `UpdateScriptInput` interfaces to types.ts
- Created `ScriptService` class with full CRUD (getAllScripts, getScriptById, createScript, updateScript, deleteScript) following existing CronJobDatabaseService singleton pattern
- Updated all 3 CronJobService SELECTs (getJobs, getEnabledJobs, getJobById) to include the 3 new columns
- Updated `updateJob()` and `createJob()` methods to accept task_type, script_id, target_instance_id

## Task Commits

Each task was committed atomically:

1. **Task 1: Create migration SQL 017 + extend types** - `ebd55f6` (feat)
2. **Task 2: Create ScriptService + update CronJobService SELECT queries** - `c4f6f27` (feat)

## Files Created/Modified

- `apps/db-ops-api/sql/migrations/017_add_cron_scripts.sql` - Migration SQL: cron_scripts table, ALTER cron_jobs, 6 seed scripts, auto-migration (174 lines)
- `apps/db-ops-api/src/cron/types.ts` - Extended CronJobConfig with task_type/script_id/target_instance_id; added CronScript, CreateScriptInput, UpdateScriptInput
- `apps/db-ops-api/src/cron/script-service.ts` - ScriptService class with full CRUD + singleton export (163 lines)
- `apps/db-ops-api/src/cron/cron-job-service.ts` - Updated 3 SELECTs, updateJob(), createJob() with new columns

## Decisions Made

- Followed the minimum-line thresholds from `must_haves` (migration SQL: 174 > 80, script-service: 163 > 60)
- Seed scripts use `target_db_type='mysql'` for all 6 (PG/Oracle/DM variants left for user-created scripts)
- baseline_cleanup and silence_cleanup leave `target_instance_id` as NULL -- the executor routes to Slide's internal MySQL pool (Pitfall 4 avoidance)
- Per D-07: ScriptService.updateScript directly overwrites content (no version history)
- ScriptService pattern matches CronJobDatabaseService exactly (getPool, isConnected, parameterized queries, singleton export)

## Deviations from Plan

None -- plan executed exactly as written. No auto-fixes were needed; all changes matched the plan specification.

## Issues Encountered

None -- both tasks executed without complications.

## User Setup Required

None -- migration runs at server startup, no external service configuration required.

## Next Phase Readiness

- Phase 122-02 (Script Execution Path) can use ScriptService and the extended cron_jobs columns directly
- Phase 122-03 (API Endpoints + Frontend) can use ScriptService for script CRUD and CronJobService for dual-mode job management
- The DEFAULT 'agent' on task_type ensures backward compatibility for existing agent-mode jobs

---

*Phase: 122-cron-script-agent-mode*
*Completed: 2026-06-26*
