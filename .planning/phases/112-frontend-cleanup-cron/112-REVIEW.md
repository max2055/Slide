---
phase: 112-frontend-cleanup-cron
reviewed: 2026-05-27T20:30:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - apps/db-ops-api/src/cron/types.ts
  - apps/db-ops-api/src/cron/cron-job-service.ts
  - apps/db-ops-api/src/cron/cron-job-handlers.ts
  - apps/db-ops-api/src/cron/cron-manager.ts
  - apps/db-ops-api/sql/migrations/009_add_cron_jobs_tables.sql
  - apps/db-ops-api/run-migration-009.ts
  - apps/db-ops-api/server.ts
  - frontend/src/app/ui/views/cron-jobs-settings.ts
  - frontend/src/main.ts
  - frontend/vite.config.js
findings:
  critical: 5
  warning: 4
  info: 3
  total: 12
status: issues_found
---

# Phase 112: Code Review Report

**Reviewed:** 2026-05-27T20:30:00Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Review of Phase 112 (Frontend Cleanup / Cron) covering 4 new cron backend modules, 1 migration file, 1 migration runner, 1 modified server.ts (cron API routes), and 1 new frontend LitElement view.

Key findings: a critical data contract mismatch between the logs API and its frontend consumer will cause runtime crashes; the `rcaProcessedAlerts` Set leaks memory with no cleanup; the migration runner contains both a hardcoded production password and a SQL injection vulnerability; manual trigger bypasses the concurrency guard in CronManager. Several warning-level issues around dead code, missing timeout enforcement, and race conditions are also identified.

## Critical Issues

### CR-01: Frontend crashes on log API response due to shape mismatch

**File:** `frontend/src/app/ui/views/cron-jobs-settings.ts:434` and `:438`, `:409`
**Issue:** The backend `GET /api/cron/jobs/:id/logs` (server.ts:3823-3837) calls `cronJobService.getLogs()` which returns `{ logs: CronJobLog[], total: number }`. The server sends this entire object as the JSON response body. However, the frontend treats the response as a plain array `CronJobLog[]` at two call sites:

1. `pollJobStatus` (line 409): `const logs: CronJobLog[] = await res.json()` followed by `logs.length > 0` -- `logs` is now an object `{ logs: [...], total: N }`, so `logs.length` is `undefined`, causing the polling to never detect completion.

2. `loadLogs` (line 434): `const logs: CronJobLog[] = await res.json()` followed by line 438 `const merged = [...existing, ...logs]` -- spreading a non-iterable object into an array throws `TypeError: {(...)} is not iterable`, which will crash the component immediately.

**Fix:** Either change the backend to return the raw array:
```ts
// server.ts line 3832-3833
const result = await cronJobService.getLogs(Number(id), limit, offset);
reply.send(result.logs);
```
Or change the frontend to destructure the response:
```ts
// cron-jobs-settings.ts line 434
const body = await res.json();
const logs: CronJobLog[] = body.logs;
```

### CR-02: Unbounded memory growth in rcaProcessedAlerts Set

**File:** `apps/db-ops-api/src/cron/cron-job-handlers.ts:37` and `:125`
**Issue:** The module-level `rcaProcessedAlerts` Set accumulates alert IDs indefinitely. Every alert that passes the RCA analysis trigger check is permanently added to this set (line 125). Unlike `topsqlProcessedKeys` (which has a 30-minute cleanup window at lines 54-57), and unlike `lastRunMinute` (which deletes stale entries at lines 299-301), `rcaProcessedAlerts` has **zero cleanup logic**. In production with hundreds or thousands of alerts per day, this set grows without bound, eventually exhausting memory.

**Fix:** Add a time-aware eviction mechanism. For example, change from `Set<number>` to a `Map<number, number>` storing `alertId -> timestamp` and add periodic cleanup:
```ts
// At the end of rcaAnalysis, or on a fixed interval:
const now = Date.now();
for (const [id, ts] of rcaProcessedAlertsWithTimestamps) {
  if (now - ts > 3600_000) rcaProcessedAlertsWithTimestamps.delete(id);
}
```

### CR-03: Hardcoded production password in migration runner

**File:** `apps/db-ops-api/run-migration-009.ts:20`
**Issue:** The database password fallback default is `'Tpam1234'`, which is the same known admin password documented in `CLAUDE.md`. Hardcoded secrets in source code are a security risk. Combined with `multipleStatements: true` (line 22-23), any accidental exposure of this file or injection at the DB_HOST/DB_NAME env var level could lead to arbitrary SQL execution.

**Fix:** Either remove the fallback entirely so migration fails loudly if no password is set, or use a less critical fallback and document the requirement:
```ts
password: process.env.DB_PASSWORD, // no fallback -- must be set explicitly
```
If a fallback is truly needed for local development, validate it comes from a `.env.local` file that is gitignored.

### CR-04: SQL injection via string interpolation in migration runner verification query

**File:** `apps/db-ops-api/run-migration-009.ts:42`
**Issue:** The verification query uses template literal interpolation for the database name:
```ts
`WHERE TABLE_SCHEMA = '${process.env.DB_NAME || 'db_ops_ai'}'`
```
If an attacker controls `DB_NAME`, they can inject arbitrary SQL. This is aggravated by `multipleStatements: true` on line 22.

**Fix:** Use parameterized query:
```ts
const [tables] = await connection.query(
  `SELECT TABLE_NAME FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?, ?)`,
  [process.env.DB_NAME || 'db_ops_ai', 'cron_jobs', 'cron_job_logs', 'cron_job_params']
);
```

### CR-05: Manual trigger bypasses concurrency guard

**File:** `apps/db-ops-api/server.ts:3778-3801`
**Issue:** The `POST /api/cron/jobs/:id/run` route directly calls `getHandler(config.handler)` followed by `handler()`, completely bypassing `CronManager.executeJob()` which is the only place where the `runningFlags` concurrency guard is checked. This means a manual trigger can run simultaneously with a scheduled execution of the same job (or overlap with another manual trigger), causing duplicate TopSQL analyses, duplicate RCA triggers, duplicate capacity recordings, etc.

**Fix:** Route manual triggers through CronManager, or at minimum check `runningFlags` before executing:
```ts
// In server.ts, before executing handler:
if (cronManager['runningFlags']?.has(config.id)) {
  // Skip or log warning
}
```
Better yet, expose a `runJob(id)` method on CronManager that respects the guard and logs correctly:
```ts
// On CronManager:
async runJobById(jobId: number): Promise<void> {
  const config = await this.jobService.getJobById(jobId);
  if (!config) throw new Error('Job not found');
  await this.executeJob(config);
}
```

## Warnings

### WR-01: Dead code in CronManager.reload()

**File:** `apps/db-ops-api/src/cron/cron-manager.ts:56`
**Issue:** `let validJobs = enabledJobs;` on line 56 is immediately overwritten on line 63 (`validJobs = enabledJobs.filter(...)`). The first assignment is never read. This is misleading dead code that suggests mutable reassignment that never happens.

**Fix:** Remove line 56:
```ts
// Line 56 should be removed entirely
// Line 63 becomes:
const validJobs = enabledJobs.filter(job => handlerNames.includes(job.handler));
```

### WR-02: Missing timeout enforcement in cron handlers

**File:** `apps/db-ops-api/src/cron/cron-job-handlers.ts` (all handlers) and `cron-manager.ts:99-107`
**Issue:** Each `CronJobConfig` carries a `timeout_seconds` field (default 300), but neither the individual handler functions nor `CronManager.executeJob()` enforce this timeout. If a handler hangs (e.g., waiting on a slow LLM response, database query, or external API), the `runningFlags` guard permanently blocks that job -- no future executions will ever run. This is a silent outage.

**Fix:** In `CronManager.executeJob()`, wrap the handler call with a timeout:
```ts
private async executeJob(config: CronJobConfig): Promise<void> {
  if (this.runningFlags.has(config.id)) { ... }
  this.runningFlags.add(config.id);
  let logId: number | null = null;
  try {
    logId = await this.jobService.startLog(config.id);
    const handler = getHandler(config.handler);
    await Promise.race([
      handler(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${config.timeout_seconds}s`)),
          config.timeout_seconds * 1000)
      ),
    ]);
    // ... success handling ...
  } catch (error: any) { ... }
  finally { this.runningFlags.delete(config.id); }
}
```

### WR-03: reload() does not wait for in-flight executions, risking skipped tick

**File:** `apps/db-ops-api/src/cron/cron-manager.ts:46-73`
**Issue:** `stopAllJobs()` (called at line 48) stops the cron timers but does not await in-flight `executeJob` promises. If a job is currently executing when `reload()` is called, its `runningFlags` entry remains set. The new cron timer for that job will fire and check `runningFlags.has(config.id)` (line 115), see the stale flag from the earlier execution, and skip its first tick. The job recovers on the next scheduled tick after the old execution finishes and clears the flag, but one execution cycle is silently lost.

**Fix:** Before calling `stopAllJobs()`, wait for any in-flight executions to complete by tracking execution promises:
```ts
private executionPromises = new Map<number, Promise<void>>();

private async executeJob(config: CronJobConfig): Promise<void> {
  const promise = this._executeJob(config);
  this.executionPromises.set(config.id, promise);
  await promise;
  this.executionPromises.delete(config.id);
}

async reload(): Promise<void> {
  // Wait for in-flight executions
  await Promise.all(Array.from(this.executionPromises.values()));
  this.stopAllJobs();
  // ... rest of reload
}
```

### WR-04: updateRunResult accepts unused `summary` parameter

**File:** `apps/db-ops-api/src/cron/cron-job-service.ts:178`
**Issue:** The `updateRunResult()` function signature accepts `summary?: string` but the parameter is never used in the SQL query or logged anywhere. Both callers (`cron-manager.ts:135` and `cron-manager.ts:144`) pass a status string to this parameter position. The function only updates `last_result = ?` with the status value. This is misleading and suggests incomplete implementation.

**Fix:** Either remove the `summary` parameter or store it meaningfully (e.g., in a separate summary column, or append it to `last_result`).

## Info

### IN-01: Module-wide singleton state persists across handler invocations

**File:** `apps/db-ops-api/src/cron/cron-job-handlers.ts:33-40`
**Issue:** Three module-level data structures (`topsqlProcessedKeys`, `rcaProcessedAlerts`, `lastRunMinute`) maintain mutable state across handler invocations. While intentional for deduplication, this means:
- State is shared across all job instances (correct by design)
- State is NOT reset on server restart (module-level, survives hot reloads differently)
- Testing is fragile (state leaks between test cases)
Consider making these instance-level or providing a reset mechanism for testability.

### IN-02: `as any` type assertions throughout cron-job-service.ts

**File:** `apps/db-ops-api/src/cron/cron-job-service.ts:40` (and 18 other occurrences)
**Issue:** Every MySQL query result is cast with `as any` before being re-cast to the domain type. This bypasses TypeScript's type checking entirely. If the column names or shapes in the SQL queries drift from the TypeScript interfaces, no compile-time error will catch the mismatch.

### IN-03: Emoji-prefixed console.log for operational logging

**File:** `apps/db-ops-api/src/cron/cron-job-handlers.ts:79` (and throughout)
**Issue:** Console logging uses emoji prefixes (`🔍`, `📊`, `🧹`, `⚠️`, `🔔`) for visual categorization. While acceptable for development, this is non-standard for production logging and may not render correctly in all log aggregation systems.

---

_Reviewed: 2026-05-27T20:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
