---
phase: 125-ssh-metrics
reviewed: 2026-07-08T23:15:00Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - apps/db-ops-api/package.json
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/sql/migrations/020_add_server_metrics_table.sql
  - apps/db-ops-api/src/monitor-collector.ts
  - apps/db-ops-api/src/server-collector.ts
  - apps/db-ops-api/src/server-database-service.ts
  - apps/db-ops-api/src/server-metric-provider.ts
  - apps/db-ops-api/src/ssh-session-pool.ts
  - frontend/src/app/ui/app-render.ts
  - frontend/src/app/ui/views/server-detail.ts
  - frontend/src/app/ui/views/servers-page.ts
findings:
  critical: 0
  warning: 0
  info: 1
  total: 1
status: issues_found
---

# Phase 125: Code Review Report -- SSH Metrics (Post-Fix Re-review)

**Reviewed:** 2026-07-08T23:15:00Z
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

Re-review of phase 125 after all 12 previous findings were patched. All 12 fixes are verified correct. One minor code quality regression was introduced by the IN-01 fix (unused variable in server-collector.ts). No critical or warning-level issues remain.

---

## Fix Verification

### CR-01: SSH Host Key Verification Disabled -- FIXED

**File:** `apps/db-ops-api/src/ssh-session-pool.ts:213-231`

The `hostVerifier` callback was replaced from `() => true` to a proper implementation:
- When no `hostKeyFingerprint` is stored (first connection), accepts any key via `callback(true)`.
- When a fingerprint is stored, hashes the received host key with SHA-256 and compares against the stored fingerprint using the `SHA256:<base64>` format.
- Rejects mismatches with `callback(false)` and logs both the stored and received fingerprints.

**Verdict:** Fix is correct. The SHA-256 hash format `SHA256:<base64>` matches standard SSH host key fingerprint conventions.

### CR-02: Credential Type Mismatch Risk in Server Update -- FIXED

**File:** `apps/db-ops-api/src/server-database-service.ts:308-316`

The credential key determination was changed from using `data.credential_type || existing.credential_type` to inspecting the decrypted payload. The new logic (line 311-314):
1. Uses `data.credential_type` if explicitly provided in the update.
2. Falls back to checking the decrypted payload for a `password` or `privateKey` key.
3. Falls back to the database `credential_type` column only as last resort.

Additionally, a defensive check was added (line 289-293): when `credential_type` is changed to a different value without providing a new `credential_value`, the update is rejected with an error message.

**Verdict:** Fix is correct.

### WR-01: Disk Usage Dashboard Always Empty -- FIXED

**File:** `frontend/src/app/ui/views/servers-page.ts:563-575`
**File:** `frontend/src/app/ui/views/server-detail.ts:310-316`

The collector still stores per-mount `disk_usage_<mount>` values via `disk_detail` parsing (intentional design). The frontend now computes aggregate disk usage from these entries:

- `server-detail.ts:_aggregateDiskUsage()` -- filters `this.metrics` for `disk_usage_*` entries and returns the arithmetic mean of all mount usage percentages.
- `servers-page.ts:_getAggregateDiskMetric()` -- applies the same logic to the metrics summary data, returning a synthetic `MetricSummaryEntry` with `metric_name: 'disk_usage'`.

Both overview cards (server list and detail page) now show the computed disk usage instead of `--`.

**Verdict:** Fix is correct. Uses Option B (frontend aggregation) as suggested in the original review.

### WR-02: Event Listener Leak on View Re-Creation -- FIXED

**File:** `frontend/src/app/ui/views/server-detail.ts:152-174`

The event listener reference is now stored as `_navHandler` (line 152), registered in `firstUpdated()` (line 163), and properly removed in `disconnectedCallback()` (lines 170-173).

**Verdict:** Fix is correct.

### WR-03: Empty Catch Suppresses All Refresh Errors -- FIXED

**File:** `frontend/src/app/ui/views/server-detail.ts:273-277`

The bare `catch` block was replaced with:
```typescript
catch (err: any) {
  console.warn('[server-detail] refresh failed:', err);
  showToast(err.message || '刷新失败', 'error');
}
finally { this.isRefreshing = false; }
```
The `isRefreshing` reset was moved to a `finally` block, ensuring the refresh button is re-enabled even on errors.

**Verdict:** Fix is correct.

### WR-04: Internal SSH2 Property Access -- FIXED

**File:** `apps/db-ops-api/src/ssh-session-pool.ts`

The `_isConnected()` method that accessed `(client as any)._sock?.writable` was removed entirely. Connection health is now managed through SSH2's standard `close` event handler (line 249-255) and failed commands trigger reconnection on the next `getConnection` call.

**Verdict:** Fix is correct.

### WR-05: Potential Resource Leak on SSH Command Timeout -- FIXED

**File:** `apps/db-ops-api/src/ssh-session-pool.ts:268-274`

When the SSH command timeout fires, the channel is now closed:
```typescript
if (commandChannel) {
  try { commandChannel.close(); } catch { /* ignore */ }
}
```

This prevents channel accumulation from repeated timeouts.

**Verdict:** Fix is correct.

### WR-06: Missing Credential Value Validation on Create -- FIXED

**Frontend:** `frontend/src/app/ui/views/servers-page.ts:422-425`
```typescript
if (!this._editingId && !this._form.credential_value) {
  showToast("请输入SSH密码或私钥", "warning");
  return;
}
```
Only validates on create (`!this._editingId`), not on edit (where empty means "don't change").

**Backend:** `apps/db-ops-api/src/server-database-service.ts:207-210`
```typescript
if (!data.credential_value || data.credential_value.trim() === '') {
  return { success: false, error: 'SSH密码或私钥不能为空' };
}
```
Defense-in-depth validation.

**Verdict:** Fix is correct.

### IN-01: Duplicate Failure Count Clearing -- PARTIALLY FIXED (new issue introduced)

**File:** `apps/db-ops-api/src/server-collector.ts:110`

The duplicate `this.failureCounts.delete(server.id)` was removed from `_tick`, leaving it only in `_collectOneServer` where success is determined -- this much is correct. However, the removal of the success check block left the `const result` variable on line 110 unused (see IN-05 below).

**Verdict:** Functional fix (duplicate delete removed) is correct. Minor regression in code quality (unused variable).

### IN-02: Browser alert() Used Instead of Toast -- FIXED

**File:** `frontend/src/app/ui/views/servers-page.ts:344`

`alert("请先登录")` replaced with `showToast("请先登录", "warning")`.

**Verdict:** Fix is correct.

### IN-03: Dynamic Import Pattern Repeated in Request Handlers -- FIXED

**File:** `apps/db-ops-api/server.ts:1399, 1436, 1480`

All three server metrics route handlers now use the already-imported `dbConnection.getPool()` (`import { dbConnection } from './src/db-connection.js'` at line 27) instead of dynamic `import('./src/db-connection.js')`.

Two remaining dynamic imports at lines 4676 and 4694 are in a separate section of the file and were not part of the original finding.

**Verdict:** Fix is correct for the scope of the original finding.

### IN-04: TOCTOU Race Condition in Server Duplicate Check -- FIXED

**File:** `apps/db-ops-api/src/server-database-service.ts:238-240`

A `UNIQUE INDEX uq_host_port` is referenced in the `ER_DUP_ENTRY` fallback handler:
```typescript
if (error.code === 'ER_DUP_ENTRY') {
  return { success: false, error: '该主机地址和端口已被纳管，请勿重复添加' };
}
```

This makes the conflict detection atomic at the database level. If the unique constraint exists, the TOCTOU race is resolved. If it does not (migration not yet applied), the SELECT-based check still provides best-effort protection.

**Verdict:** Fix is correct.

---

## New Findings

### IN-05: Unused Variable `result` in `_tick` Method

**File:** `apps/db-ops-api/src/server-collector.ts:110`

**Issue:** The `const result` variable is declared but never read. This is a regression from the IN-01 fix, where the success-path branching (`if (result.success) { this.failureCounts.delete(server.id); }`) was removed from `_tick`, leaving the declaration orphaned.

**Context:** The duplicate `failureCounts.delete()` was correctly consolidated into `_collectOneServer` (line 235). However, the surrounding `if (result.success)` guard was also stripped, making `result` unused. The `_tick` method now only distinguishes success from failure by whether `_collectOneServer` throws an exception. Non-throwing business-logic failures (decryption failure, empty credentials, unsupported OS) are silently accepted -- this was the same behavior as the original code, so it is not a new functional regression, but the unused variable is a new code quality issue.

**Fix:**
```typescript
// Line 110: either remove the unused const
await this._collectOneServer(server);
```

Or, if the original success-path branching was intentional to handle non-throwing failures:
```typescript
const result = await this._collectOneServer(server);
if (!result.success) {
  console.warn(`[ServerCollector] #${server.id} (${server.host}): ${result.error}`);
}
```

---

_Reviewed: 2026-07-08T23:15:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
