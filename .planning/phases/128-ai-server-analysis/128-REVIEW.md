---
phase: 128-ai-server-analysis
reviewed: 2026-07-08T20:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts
  - apps/db-ops-api/src/tools/generated/slide-self-mgmt/index.ts
findings:
  critical: 2
  warning: 3
  info: 2
  total: 7
status: issues_found
---

# Phase 128: Code Review Report

**Reviewed:** 2026-07-08T20:00:00Z
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Reviewed 2 files implementing 4 AI agent tools for server management (list_server_instances, get_server_metrics, get_server_alerts, analyze_server_health). Found 2 critical issues: a file naming mismatch that causes the module-load failure seen at startup, and a missing server_id filter in getServerAlerts that returns all alerts instead of server-specific ones. Also found 3 warnings around missing auth controls, unvalidated metricName input, and inconsistent error handling.

## Critical Issues

### CR-01: Module import naming mismatch causes runtime load failure

**File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/index.ts:14`
**File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts` (on-disk filename)

**Issue:** The file on disk is named `server-tools.ts` (with hyphen), but the re-export and import statements in `index.ts` reference `'./server_tools.js'` (with underscore). All other files in this directory follow the underscore convention (`check_status.ts`, `add_database.ts`, `test_connection.ts`, etc.). The startup error confirms this: _"Could not load platform tools from catalog: Cannot find module 'server_tools.js'"_.

On case-insensitive filesystems (macOS APFS), Node.js may resolve `server_tools` to the `server-tools.ts` file, which is why dev works. On case-sensitive filesystems (Linux production), the module cannot be found and all 4 new tools silently fail to load. Additionally, even if the file is found at compile time, the emitted JS output will look for `server-tools.js` (from compiled TypeScript) while `index.js` still imports `./server_tools.js`.

**Fix:** Rename the file on disk to match the import, consistent with the project convention of underscores:

```bash
mv server-tools.ts server_tools.ts
```

Then update the import paths and the registration lines in `server-tools.ts` are fine as-is — no code changes needed beyond the rename.

### CR-02: getServerAlerts tool returns all alerts, not filtered by serverId

**File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts:475-478`

**Issue:** The `getServerAlertsTool` handler calls `alertDatabaseService.getAlerts()` without passing the `serverId` parameter. The `alertDatabaseService.getAlerts` method fully supports `server_id` filtering (lines 155 and 185-188 of `alert-database-service.ts`), but the tool handler omits it entirely.

This means every invocation of this tool returns **all alerts** in the system regardless of which serverId was requested. The response summary misleadingly says `服务器 ${server.label || server.host} 相关告警：共 X 条` but the alerts have no relation to that server.

**Fix:** Pass `serverId` to `getAlerts`:

```typescript
const alertResult = await alertDatabaseService.getAlerts({
  server_id: serverId,       // <-- ADD THIS LINE
  status: activeOnly ? 'unread,read,acknowledged' : undefined,
  limit,
});
```

Also update the comment on line 473-474 which says alerts "没有 server_id 关联" — this is incorrect, as the alerts table and service both support `server_id`.

## Warnings

### WR-01: Missing auth/permission checks on all 4 tools

**File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts`
**Lines:** 274-331, 335-420, 424-521, 525-639

**Issue:** All 4 tools expose sensitive server inventory data (host addresses, labels, ports, OS types, status, CPU/memory/disk metrics, uptime) without any authentication or authorization checks in their handlers. The `AnyAgentTool` interface supports `ownerOnly?: boolean` and `group` for access control, but none of the tools set these. If the agent endpoint has no built-in auth layer, any user can query all server data.

The `AnyAgentTool` interface (in `types.ts` line 110) provides an `ownerOnly` flag but it is not used. Even with `group: 'slide_self_mgmt'`, there is no runtime enforcement.

**Fix:** At minimum, document the intended access control. If `ownerOnly` enforcement is handled at a higher layer (e.g., in the tool execution middleware), add a comment explaining this. If not, add auth checks in each handler:

```typescript
// In each tool handler, check user context:
handler: async (args, context) => {
  if (!context?.userId) {
    return { success: false, error: '未授权：需要登录', errorCode: 'UNAUTHORIZED' };
  }
  // ... rest of handler
}
```

### WR-02: Unvalidated metricName input passed directly to SQL

**File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts:131-153`

**Issue:** The `metricName` parameter is a free-form string with no validation or allowlist check before being used in a parameterized SQL query (line 152). While parameterized queries prevent SQL injection (the value is a bound parameter), passing an invalid metric name will silently return empty results rather than rejecting the input. The tool handler in `getServerMetricsTool` (line 360) blindly accepts any `metricName` string from the agent without validating against the known set of valid metric names: `['cpu_usage', 'memory_usage', 'disk_usage', 'load_1min', 'uptime']`.

**Fix:** Add input validation in `getServerMetricsTool`:

```typescript
const VALID_METRIC_NAMES = ['cpu_usage', 'memory_usage', 'disk_usage', 'load_1min', 'uptime'];
if (metricName && !VALID_METRIC_NAMES.includes(metricName)) {
  return {
    success: false,
    error: `参数错误：无效的指标名称 "${metricName}"。有效值：${VALID_METRIC_NAMES.join(', ')}`,
    errorCode: 'INVALID_PARAMETER',
  };
}
```

### WR-03: Error swallowing in helper functions results in silent failures

**File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts:117-123, 167-170, 218-221`

**Issue:** Both `getLatestMetrics()` and `getMetricHistory()` catch all errors and return default values (null metrics / empty arrays) instead of rethrowing or returning error objects. When the database connection fails or a query errors, the tools that call these helpers return `success: true` with null data, giving the agent no indication that a failure occurred. The error is only visible in server-side `console.error` logs.

This is inconsistent with the tool handlers' own error handling pattern, which properly returns `{ success: false, error: ..., errorCode: ... }` objects.

**Fix:** Two options:

**Option A** (preferred): Remove the try/catch from helpers and let errors propagate to the calling tool handler's existing catch block:

```typescript
async function getLatestMetrics(serverId: number): Promise<MetricsSummary> {
  const pool = dbConnection.getPool();
  if (!pool) {
    throw new Error('数据库连接不可用');
  }
  // ... no outer try/catch, let caller handle errors
}
```

**Option B:** Return error information instead of silently defaulting:

```typescript
async function getLatestMetrics(serverId: number): Promise<MetricsSummary & { _error?: string }> {
  // ... keep try/catch but add _error field
}
```

## Info

### IN-01: Undefined property access on alert fields

**File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts:480-489`

**Issue:** The handler maps `alert.level` (line 484) and `alert.instance_name` (line 488), but the `getAlerts` service method returns `severity` (not `level`) and `instance_name` is only present for alerts with a non-null `instance_id`. The `ServerAlertInfo` interface declares `instance_name: string` (non-optional), so accessing an alert without a linked instance will yield `undefined` and violate the type contract.

The `||` fallback on line 484 (`alert.severity || alert.level`) masks the issue for severity, but `instance_name` has no such fallback.

**Fix:** Use the correct property name (`severity` instead of `level`) and make `instance_name` optional in the interface:

```typescript
// Line 484 - use severity consistently:
level: alert.severity,

// ServerAlertInfo interface line 51 - make optional:
instance_name?: string;
```

### IN-02: Magic number for hour-to-ms conversion

**File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts:142`

**Issue:** Line 142 uses the magic number `3600000` for converting hours to milliseconds. This should be a named constant for readability.

```typescript
const HOUR_MS = 3_600_000;
const since = new Date(Date.now() - hours * HOUR_MS).toISOString().slice(0, 19).replace('T', ' ');
```

---

_Reviewed: 2026-07-08T20:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
