---
phase: 122-cron-script-agent-mode
plan: 02
subsystem: cron, api
tags: cron-scripts, script-execution, cron-manager, api-routes
requires:
  - phase: 122-01
    provides: ScriptService CRUD, extended cron_jobs columns (task_type/script_id/target_instance_id)
provides:
  - CronManager script execution path (executeScriptJob + executeInternalSql)
  - task_type branching in executeJob()
  - /api/cron/scripts CRUD API (GET/POST/PUT/DELETE)
  - POST /api/cron/scripts/:id/test dry-run endpoint
affects:
  - 122-03: Relies on this API for frontend script management
tech-stack:
  added: []
  patterns:
    - "Script execution branches on task_type: script -> SqlExecutor, agent -> CronExecutor"
    - "Scripts targeting Slide's own DB (target_instance_id=null) use internal MySQL pool"
    - "Test endpoint limits result rows to 100 (T-122-04 DoS mitigation)"
key-files:
  modified:
    - apps/db-ops-api/src/cron/cron-manager.ts
    - apps/db-ops-api/server.ts
key-decisions:
  - "executeScriptJob() takes logId from outer executeJob() scope to share the same startLog session"
  - "executeInternalSql() uses dbConnection.getPool() for Slide's own MySQL (matching cron-job-service pattern)"
  - "Test endpoint validates instance_id as required number, limits result rows to 100"
  - "POST/PUT/DELETE routes require cron:manage; GET routes require cron:view (matching existing cron API pattern)"
  - "sqlExecutor import is static (not lazy) since it's always used in the same process"
  - "ScriptService imported lazily inside executeScriptJob (dynamic import) to avoid circular dependency risk"
requirements-completed: [SCRIPT-03, SCRIPT-04]
duration: 3min
completed: 2026-06-26
---

# Phase 122 Plan 02: Script Execution Path

**Script SQL execution in CronManager with task_type branching and full CRUD API for script management**

## Performance

- **Duration:** 3 min
- **Started:** 2026-06-26T06:49:00Z
- **Completed:** 2026-06-26T06:52:28Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

### Task 1: Script execution path in CronManager

- Added `sqlExecutor` and `dbConnection` imports to `cron-manager.ts`
- Added `task_type === 'script'` branching in `executeJob()`: delegates to `executeScriptJob()` before the agent path
- Added `executeScriptJob(config, logId)` private method:
  - Validates `script_id` and loads script via dynamic import of ScriptService
  - For jobs with `target_instance_id`: uses `sqlExecutor.executeSql()` with MySQL timeout guard (`SET SESSION max_execution_time`)
  - For jobs without `target_instance_id` (Slide's own DB): uses `executeInternalSql()` with internal MySQL pool
  - Writes unified `structured_result` format to `cron_job_logs` via `completeLog()`
  - Calls `updateRunResult()` for job-level status tracking
- Added `executeInternalSql(sql)` private method for executing against Slide's own MySQL database
- Agent execution path remains completely unchanged -- full backward compatibility

### Task 2: /api/cron/scripts CRUD routes + dry-run endpoint

- Added `ScriptService` and `scriptService` import to `server.ts`
- **GET /api/cron/scripts** -- List all scripts (`cron:view` permission)
- **POST /api/cron/scripts** -- Create script with field validation (`cron:manage`), requires `name`, `content`, `target_db_type`; returns 201 with `{ id }`
- **PUT /api/cron/scripts/:id** -- Update script content (`cron:manage`), 404 if not found
- **DELETE /api/cron/scripts/:id** -- Delete script (`cron:manage`), 404 if not found
- **POST /api/cron/scripts/:id/test** -- Dry-run script against managed instance (`cron:manage`), requires `{instance_id: number}`; limits result rows to 100

All routes follow the existing `verifyToken` + `requirePermission` pattern consistent with existing cron routes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add executeScriptJob() to CronManager with task_type branching** - `aed7da4` (feat)
2. **Task 2: Add /api/cron/scripts CRUD routes + dry-run test endpoint** - `31f3180` (feat)

## Files Modified

- `apps/db-ops-api/src/cron/cron-manager.ts` - +81 lines: sqlExecutor/dbConnection imports, task_type branching in executeJob(), executeScriptJob(), executeInternalSql()
- `apps/db-ops-api/server.ts` - +127 lines: ScriptService import, 5 route handlers for script CRUD + dry-run test

## Threat Model Compliance

| Threat ID | Category | Mitigation | Status |
|-----------|----------|-----------|--------|
| T-122-03 | Elevation of Privilege | requirePermission('cron:manage') on mutation routes | Implemented |
| T-122-04 | Denial of Service | Test result limited to 100 rows; timeoutSeconds guard before SQL | Implemented |
| T-122-05 | Information Disclosure | Accept (same as existing SqlExecutor responses) | Accepted |
| T-122-06 | Tampering | DDL/DML allowed; audit logging via completeLog captures SQL and result summary | Implemented |
| T-122-SC | Imported packages | No new packages | Verified |

## Decisions Made

- `executeScriptJob()` takes `logId` from outer `executeJob()` scope -- shares the same `startLog` session for both script and agent paths
- `ScriptService` imported dynamically inside `executeScriptJob()` -- avoids potential circular dependency if ScriptService ever imports CronManager types
- `sqlExecutor` imported statically since it's always loaded in the same process and has no circular dependency risk
- Dynamic import for ScriptService is wrapped in the `executeScriptJob` method, so it only executes when a script-type job runs (not at module load time)
- Test endpoint uses `instance_id` as a required number, matching the Research recommendation for explicit instance targeting

## Deviations from Plan

None -- plan executed exactly as written. No auto-fixes were needed.

Key design note: The plan's step 3 code snippet showed `executeScriptJob(config)` without a `logId` parameter and had a comment `const logId = config.id;` which would have been incorrect (config.id is the job ID, not the log ID). This was corrected during implementation to accept `logId: number` as a parameter, matching the refactored `executeJob()` that moves `startLog()` before the branch.

## Issues Encountered

None -- both tasks executed without complications.

- Pre-existing `tsconfig.json` `ignoreDeprecations: "6.0"` option is incompatible with TypeScript 5.9.3 (not related to this plan's changes)
- All TypeScript type errors are pre-existing and unrelated to this plan

## Next Phase Readiness

- Phase 122-03 (Frontend + API Integration) can use the new `/api/cron/scripts` endpoints directly
- The `executeScriptJob()` path is fully wired for script-type cron jobs created by the auto-migration from Plan 1
- Dry-run endpoint lets the frontend preview script results before saving or scheduling

---

*Phase: 122-cron-script-agent-mode*
*Completed: 2026-06-26*
