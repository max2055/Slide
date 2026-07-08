---
phase: 122-cron-script-agent-mode
reviewed: 2026-06-26T16:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - apps/db-ops-api/sql/migrations/017_add_cron_scripts.sql
  - apps/db-ops-api/src/cron/types.ts
  - apps/db-ops-api/src/cron/script-service.ts
  - apps/db-ops-api/src/cron/cron-job-service.ts
  - apps/db-ops-api/src/cron/cron-manager.ts
  - apps/db-ops-api/server.ts
  - frontend/src/app/ui/components/script-editor.ts
  - frontend/src/app/ui/views/cron-jobs-settings.ts
findings:
  critical: 3
  warning: 2
  info: 5
  total: 10
status: issues_found
---

# Phase 122: Code Review Report (Cron Script/Agent Dual Mode)

**Reviewed:** 2026-06-26T16:00:00Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Reviewed 8 source files implementing Phase 122's cron job script/agent dual-mode feature. Found 3 critical bugs that make the new "script mode" completely non-functional through the API, 2 warnings related to edge cases in execution, and 5 info-level issues.

The core problem is that the server's REST API handlers for creating, updating, and manually running cron jobs all ignore the `task_type` / `script_id` / `target_instance_id` fields. The backend `cron-job-service.ts` and `cron-manager.ts` fully support script mode, but the API surface never passes these fields through.

---

## Critical Issues

### CR-01: POST /api/cron/jobs drops task_type, script_id, target_instance_id

**File:** `apps/db-ops-api/server.ts:4128`
**Issue:** The `POST /api/cron/jobs` handler creates a job but only passes 6 fields to `cronJobService.createJob()`: `name`, `task_description`, `cron_expr`, `timezone`, `description`, `timeout_seconds`. The `task_type`, `script_id`, and `target_instance_id` fields from the request body are completely ignored. Meanwhile, `cronJobService.createJob()` (in `cron-job-service.ts:215-250`) accepts and inserts all these fields. The frontend correctly sends them (cron-jobs-settings.ts:430-436), but the server drops them. This means **the "script" task_type can never be saved through the API** -- every newly created job defaults to `task_type='agent'` regardless of frontend intent.

**Fix:** Pass all three fields from the request body to `cronJobService.createJob()`:

```typescript
const id = await cronJobService.createJob({
  name: body.name,
  task_description: body.task_description,
  cron_expr: body.cron_expr,
  task_type: body.task_type,
  script_id: body.script_id,
  target_instance_id: body.target_instance_id,
  timezone: body.timezone,
  description: body.description,
  timeout_seconds: body.timeout_seconds,
});
```

Also add `retry_count` to the passthrough for completeness.

### CR-02: PUT /api/cron/jobs/:id drops task_type, script_id, target_instance_id

**File:** `apps/db-ops-api/server.ts:4165`
**Issue:** The `PUT /api/cron/jobs/:id` handler calls `cronJobService.updateJob()` with only `task_description`, `cron_expr`, `enabled`, `timezone`, `description`, `timeout_seconds`, `retry_count`. The `task_type`, `script_id`, and `target_instance_id` fields are not included. Editing any job to change its type (agent to script or vice versa) or to rebind its script/instance silently has no effect. `cronJobService.updateJob()` at `cron-job-service.ts:102` accepts these fields and builds the SQL update dynamically, but the API layer never passes them.

**Fix:** Add the missing fields to the `updateJob` call:

```typescript
const updated = await cronJobService.updateJob(Number(id), {
  task_description: body.task_description,
  cron_expr: body.cron_expr,
  enabled: body.enabled,
  task_type: body.task_type,
  script_id: body.script_id,
  target_instance_id: body.target_instance_id,
  timezone: body.timezone,
  description: body.description,
  timeout_seconds: body.timeout_seconds,
  retry_count: body.retry_count,
});
```

### CR-03: POST /api/cron/jobs/:id/run ignores task_type -- always uses agent execution

**File:** `apps/db-ops-api/server.ts:4229`
**Issue:** The manual trigger handler (`POST /api/cron/jobs/:id/run`) always calls `cronExecutor.execute()` (the AI agent path), never checking `config.task_type`. For script-type jobs, `task_description` contains raw SQL (set by the frontend at cron-jobs-settings.ts:433 as a workaround for the first bug). This means manually triggering a script-type job sends SQL to the AI agent as a natural language prompt instead of executing it against the database. The handler should branch based on `task_type` the same way `CronManager.executeJob()` does at cron-manager.ts:146-148.

Additionally, this handler completely bypasses `CronManager.executeJob()` and duplicates its logic -- missing the concurrency guard (`runningFlags`), next-run-at updates, and the script execution path.

**Fix:** Either make `CronManager.executeJob()` public and call it, or add a task_type branch in the handler:

```typescript
if (config.task_type === 'script') {
  // Invoke script execution path (reuse CronManager logic or inline it)
  const result = await handleScriptExecution(config, logId);
  // ... completeLog/updateRunResult
} else {
  // Agent path (existing code)
  const result = await cronExecutor.execute(...);
}
```

---

## Warnings

### WR-01: Dynamic import of script-service adds runtime failure risk

**File:** `apps/db-ops-api/src/cron/cron-manager.ts:196`
**Issue:** `import('./script-service')` is a dynamic import that loads the module at cron job execution time. If module resolution fails (e.g., renamed file, missing export), the error surfaces during a timed cron execution rather than at server startup when it would be immediately visible. No circular dependency exists between `cron-manager.ts` and `script-service.ts` that would justify a dynamic import.

**Fix:** Convert to static import at the top of the file:

```typescript
import { scriptService } from './script-service';
```

Then use the already-imported `scriptService` directly at line 197 instead of destructuring from a dynamic import.

### WR-02: Test script execution has no timeout guard

**File:** `apps/db-ops-api/server.ts:4431`
**Issue:** The `POST /api/cron/scripts/:id/test` handler calls `sqlExecutor.executeSql(body.instance_id, script.content)` directly without setting a `max_execution_time` guard. The `CronManager.executeScriptJob()` (cron-manager.ts:204-210) explicitly prepends `SET SESSION max_execution_time = ${timeoutMs}` for MySQL targets, but the test execution path does not. A slow or runaway script during testing blocks the connection indefinitely.

**Fix:** Apply the same timeout guard pattern used in `CronManager.executeScriptJob()`:

```typescript
const timeoutMs = 30000; // 30 second default for tests
let execSql = script.content;
if (script.target_db_type === 'mysql') {
  execSql = `SET SESSION max_execution_time = ${timeoutMs};\n` + execSql;
}
const result = await sqlExecutor.executeSql(body.instance_id, execSql);
```

---

## Info

### IN-01: Missing script/instance validation on POST /api/cron/jobs

**File:** `apps/db-ops-api/server.ts:4117`
**Issue:** The POST handler requires `task_description` for all job types, but script-type jobs conceptually don't need one (the AI agent never sees it). The frontend works around this by setting `task_description` to the raw SQL content. Additionally, there is no server-side validation that `script_id` references an existing script when `task_type='script'`, or that `target_instance_id` references a valid database instance.

### IN-02: Missing output_schema passthrough in PUT and manual trigger

**File:** `apps/db-ops-api/server.ts:4165,4229`
**Issue:** The `output_schema` field is stored in the database and used by the agent path (`CronExecutor.execute()` accepts it as a parameter), but neither the POST nor PUT handler passes it through. The manual trigger handler reads `config.output_schema` from the fetched config (line 4233), so it works accidentally for existing jobs, but new jobs can never have `output_schema` set via the API.

### IN-03: Frontend script modifications lost on template-based save

**File:** `frontend/src/app/ui/views/cron-jobs-settings.ts:406-421`
**Issue:** When a user selects a predefined script template and then modifies the SQL in the editor, clicking save does not persist the modifications. If `scriptId` is already set (from the template), no new script is created and the existing script is not updated. The job continues referencing the original template content. The user's changes are silently discarded.

### IN-04: Integer coercion in SQL LIMIT/OFFSET

**File:** `apps/db-ops-api/src/cron/cron-job-service.ts:432`
**Issue:** LIMIT and OFFSET values are injected via template literal even though `Number()` coercion is applied. While this is standard practice because MySQL does not support parameterized LIMIT/OFFSET, the server.ts callers (lines 4308-4310) validate these values first. If another caller skips validation, a malformed value could produce an SQL syntax error. Consider adding a local guard that clamps to non-negative integers.

### IN-05: Migration seeds mysql.slow_log query which may not exist

**File:** `apps/db-ops-api/sql/migrations/017_add_cron_scripts.sql:116-122`
**Issue:** The `log_collection` seed script queries `mysql.slow_log` which requires both the MySQL `slow_query_log` to be enabled AND the log output table to exist (`log_output=TABLE`). If `slow_query_log=OFF` or `log_output=FILE`, the `mysql.slow_log` table is empty or its structure may differ. Additionally, querying `mysql.slow_log` requires the `SELECT` privilege on the `mysql` system database, which many managed MySQL instances do not grant. Consider adding a comment noting these prerequisites or providing a fallback query.

---

_Reviewed: 2026-06-26T16:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
