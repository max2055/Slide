---
phase: 113-ai-cron-agent
review_date: 2026-05-27T12:00:00Z
reviewer: Claude (gsd-code-reviewer)
depth: standard
files_reviewed: 12
files_reviewed_list:
  - apps/db-ops-api/sql/migrations/010_add_task_description_log_columns.sql
  - apps/db-ops-api/src/cron/types.ts
  - apps/db-ops-api/src/cron/cron-job-service.ts
  - apps/db-ops-api/src/cron/cron-executor.ts
  - apps/db-ops-api/src/cron/cron-completion-tool.ts
  - apps/db-ops-api/src/__tests__/cron-executor.test.ts
  - apps/db-ops-api/src/cron/cron-manager.ts
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/src/adapter/get-agent-engine.ts
  - apps/db-ops-api/src/__tests__/cron-eval.test.ts
  - frontend/src/app/ui/views/cron-jobs-settings.ts
  - apps/db-ops-api/src/cron/cron-job-handlers.ts (verified deleted)
findings:
  critical: 0
  warning: 6
  info: 4
  total: 10
status: issues_found
---

# Phase 113: AI Agent Cron — Code Review Report

**Reviewed:** 2026-05-27T12:00:00Z
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

12 source files reviewed for the AI Agent Cron phase. The implementation replaces hardcoded handler-based cron execution with dynamic AI agent execution via AgentRunner. Overall structure is sound: migration correctly handles schema changes, type definitions are updated, the service layer parameterizes SQL queries, and all API routes have permission guards.

6 warnings and 4 info items were found. No critical issues (no security vulnerabilities). Key concerns: SQL injection surface in LIMIT/OFFSET interpolation, a missed `partial` status check in the manual trigger route, the `error_trace` column being defined but never written, and two dead code paths. Several inconsistencies between the `AgentRunResult` type in `types.ts` and the one imported from `@slide/agent-core` suggest the `types.ts` version is a dead export that could diverge.

## Warnings

### WR-01: SQL injection vector via string interpolation in LIMIT/OFFSET

**File:** `apps/db-ops-api/src/cron/cron-job-service.ts:368`
**Issue:** `LIMIT ${limit} OFFSET ${offset}` uses string interpolation rather than parameterized binding. Although the sole caller in server.ts validates these as bounded numbers (`Math.min(Math.max(Number(query.limit) || 20, 1), 100)`), the service method itself has no defense-in-depth. Any future caller passing untrusted input — or a codepath that skips server.ts validation — would be vulnerable to SQL injection.

```typescript
// Line 368 — unsafe:
LIMIT ${limit} OFFSET ${offset}
```

**Fix:** Use parameterized placeholders:
```typescript
const [rows] = await pool.execute(
  `SELECT id, job_id, started_at, finished_at, status, result_summary, error_message,
          result, tools_used, tool_events, usage, stop_reason, duration_ms, error_trace, partial_trace
   FROM cron_job_logs
   WHERE job_id = ?
   ORDER BY started_at DESC
   LIMIT ? OFFSET ?`,
  [jobId, limit, offset]
) as any;
```

---

### WR-02: Manual trigger route omits `partial` status detection

**File:** `apps/db-ops-api/server.ts:3838`
**Issue:** The auto-execution path in `cron-manager.ts:130-132` correctly detects partial runs (`result.stopReason === 'max_iterations'`), but the manual trigger route at server.ts uses only a binary check:

```typescript
const status = result.error ? 'error' : 'success';
```

When a manually triggered run hits `max_iterations` (the 20-iteration or 5-minute limit), it will be logged as `'success'` instead of `'partial'`, making the log inaccurate.

**Fix:** Align with the cron-manager pattern:
```typescript
const status = result.error ? 'error'
  : result.stopReason === 'max_iterations' ? 'partial'
  : 'success';
```

---

### WR-03: `error_trace` column defined in schema but never written

**Files:**
- `apps/db-ops-api/sql/migrations/010_add_task_description_log_columns.sql:31` (column added)
- `apps/db-ops-api/src/cron/types.ts:41` (field declared)
- `apps/db-ops-api/src/cron/cron-job-service.ts:303-309` (trace parameter type — no `error_trace`)
- `apps/db-ops-api/src/cron/cron-job-service.ts:364` (column read in SELECT)

**Issue:** The `error_trace TEXT` column is added by migration, declared in the `CronJobLog` interface, and selected in every log query — but `completeLog()` neither accepts `error_trace` in its trace parameter nor writes it in the UPDATE statement. The column is always `NULL`. When Agent execution errors occur (e.g., timeouts, tool failures), the raw error stack/trace is lost because it is never persisted.

The migration and type perceive `error_trace` as a first-class column, but the service implementation never populates it.

**Fix:** Add `error_trace` to the `completeLog` trace parameter type and the UPDATE statement:

```typescript
// cron-job-service.ts:303-310 — Add error_trace to trace type
trace?: {
  tools_used?: string[];
  tool_events?: any[];
  usage?: Record<string, number>;
  stop_reason?: string;
  duration_ms?: number;
  partial_trace?: string;
  error_trace?: string;  // ADD
},

// cron-job-service.ts:317-338 — Add column to UPDATE
`SET finished_at = NOW(), status = ?, result_summary = ?,
    error_message = ?,
    tools_used = ?,
    tool_events = ?,
    usage = ?,
    stop_reason = ?,
    duration_ms = ?,
    partial_trace = ?,
    error_trace = ?    // ADD
 WHERE id = ?`,
// ...values array: add trace?.error_trace || null
```

Then in `cron-manager.ts:150-151` pass the error stack:
```typescript
await this.jobService.completeLog(logId, 'error', `执行失败`,
  error.message,
  { error_trace: error.stack }  // pass stack trace
);
```

---

### WR-04: DELETE route sends success even when `deleteJob` fails silently

**File:** `apps/db-ops-api/server.ts:3867`
**Issue:** `cronJobService.deleteJob()` returns `false` when the database pool is null (line 219) or when a query error occurs (line 228-229). But the DELETE handler does not check the return value:

```typescript
await cronJobService.deleteJob(Number(id));
await cronManager.reload();
reply.send({ message: '删除成功' });
```

If the deletion silently fails (e.g., transient DB disconnect), the route responds with `{ message: '删除成功' }` despite the row not being deleted. The `getJobById` check on line 3864 does confirm the job exists, but it does not guarantee the subsequent `DELETE` succeeds.

**Fix:** Check the return value:
```typescript
const deleted = await cronJobService.deleteJob(Number(id));
if (!deleted) {
  return reply.code(500).send({ error: '删除失败，数据库操作未生效' });
}
```

---

### WR-05: `AgentRunResult` in `types.ts` is dead export

**File:** `apps/db-ops-api/src/cron/types.ts:54-62`
**Issue:** `AgentRunResult` is defined and exported but never imported by any file. `cron-executor.ts` imports `AgentRunResult` from `@slide/agent-core` (line 17), and both `cron-manager.ts` and `server.ts` consume the executor's return value via type inference. The `types.ts` version has `durationMs` but lacks `messages` and `hadInjections` — the opposite of the upstream type from `@slide/agent-core`. Two divergent definitions of the same interface increase maintenance risk.

**Relevant line:** No file contains `import { AgentRunResult } from './types'` — confirmed by grep across the entire `src/` and `server.ts`.

**Fix:** Either:
a) Remove the dead export from `types.ts` and import the canonical type from `@slide/agent-core` where needed, or
b) Align the two definitions (add `messages` and `hadInjections`, decide on `durationMs`) and ensure at least one consumer imports from `types.ts`.

---

### WR-06: Dead code — `deleteJob()` method in frontend uses `window.confirm` but is never called

**File:** `frontend/src/app/ui/views/cron-jobs-settings.ts:351-364`
**Issue:** The class contains two delete methods:
- `deleteJob()` (line 351) — uses `window.confirm()` dialog, never called from template
- `executeDelete()` (line 394) — uses the styled Lit dialog, called via `confirmDelete → executeDelete` chain

The `deleteJob()` method at line 351 is dead code. If accidentally invoked by future development, it would bypass the styled delete confirmation dialog and show a native browser `confirm()` instead, creating an inconsistent UX.

**Fix:** Remove the unused `deleteJob()` method (lines 351-364).

---

### WR-07: CronManager catch block does not persist partial trace on error

**File:** `apps/db-ops-api/src/cron/cron-manager.ts:150-152`
**Issue:** When `cronExecutor.execute()` throws (e.g., connection error before the runner starts), the catch block calls `completeLog` without any trace data:

```typescript
await this.jobService.completeLog(logId, 'error', `执行失败`, error.message);
```

If the error occurs after partial execution (e.g., the runner started and collected some `ToolEvent`s before throwing), those partial results are lost. The `CronHook` instance lives within the `try` block of `cron-executor.ts:53` and is not accessible from the outer catch.

The same issue exists in the server.ts manual trigger route (lines 3851-3853), which also calls `completeLog` without a trace parameter in its catch block.

**Fix:** In `cron-executor.ts`, the catch block already extracts `hook.events` — so the error return path includes them. The issue is that `cron-manager.ts`'s outer catch doesn't receive the partial result. Consider wrapping `completeLog` outside the `try/catch` or ensuring the executor's error return includes `toolEvents` in a way that the catch block can still persist them. At minimum, the catch block in `cron-manager.ts` should attempt to read any partial trace from the result that `cronExecutor.execute()` returned before throwing.

## Info

### IN-01: Missing `.js` extensions on cron imports in server.ts

**File:** `apps/db-ops-api/server.ts:70-72`
**Issue:** The three new cron imports lack `.js` extensions, while all ~50 existing local imports use them:

```typescript
// Line 70-72 (no .js extension — inconsistent):
import { CronJobDatabaseService, cronJobService } from './src/cron/cron-job-service';
import { CronManager } from './src/cron/cron-manager';
import { CronExecutor } from './src/cron/cron-executor';

// All other local imports (with .js):
import { getAgentEngine, getAdapterType, loadPlatformTools } from './src/adapter/get-agent-engine.js';
import { AnthropicProvider } from './src/adapter/llm-provider.js';
```

While `tsx` resolves extensionless imports, this will break under native Node.js ESM if and when the project switches away from `tsx`. Add `.js` extensions for consistency and future-proofing.

---

### IN-02: `closeFormDialog()` omits several form state resets

**File:** `frontend/src/app/ui/views/cron-jobs-settings.ts:303-309`
**Issue:** `closeFormDialog()` resets `formName`, `formTaskDescription`, and `formError`, but does not reset `formDescription`, `formCronExpr`, or `formEnabled`. It relies entirely on `openCreateDialog()` (line 279) to fully reset state before showing the dialog. If `closeFormDialog()` is called and then `openEditDialog()` is called without going through `openCreateDialog()` first (which is the normal flow — `openEditDialog` is called directly), stale values may briefly flicker before being overwritten by the edit-dialog's assignment.

The issue is cosmetic (no bug because `openEditDialog` overwrites all fields), but resetting all form fields in `closeFormDialog()` would make the component more robust against future refactoring.

---

### IN-03: Dead CSS class `cron-input` referenced in dialog template

**File:** `frontend/src/app/ui/views/cron-jobs-settings.ts:647,651,655,661`
**Issue:** Dialog `<input>` and `<textarea>` elements use `class="cron-input"`, but the `.cron-input` CSS rule was intentionally deleted as part of removing the inline cron editor. The class has no effect. Inputs are visually fine because inline styles are present (`style="width:100%;margin-top:4px;..."`), but the dead class is misleading.

**Fix:** Remove `class="cron-input"` from the four dialog fields, or define a `.cron-input` CSS rule to match the inline style.

---

### IN-04: CONTEXT.md D-07 description contradicts implementation

**File:** `.planning/phases/113-ai-cron-agent/113-CONTEXT.md:41-46`
**Issue:** D-07 in the context document describes Gateway integration (`sendGatewayChat`, `chat.history`), but Plan 02 explicitly overrides this to use `AgentRunner.run()` from `@slide/agent-core` (the post-108 pattern). The context document was not updated to reflect this decision. This creates confusion for anyone reading the context file to understand the architecture.

---

## Self-Check

| Criterion | Status |
|-----------|--------|
| All 12 source files reviewed at standard depth | Done |
| Each finding has file path, line number, description, severity | Done |
| Findings grouped by severity (Critical/Warning/Info) | Done |
| No source files modified (review is read-only) | Confirmed |
| cron-job-handlers.ts confirmed deleted | Confirmed |
| No getHandler/handlerNames references remain | Confirmed |
| All SQL queries use parameterized bindings (except LIMIT/OFFSET noted) | Verified |
| All API routes have permission guards | Verified (cron:view / cron:manage) |
| Frontend task_description replaces handler | Verified |
| Tests cover both structure (readFileSync) and behavior (handler invocation) | Verified |

---

_Reviewed: 2026-05-27T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
