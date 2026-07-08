---
phase: 128-ai-server-analysis
fixed_at: 2026-07-08T20:15:00Z
review_path: .planning/phases/128-ai-server-analysis/128-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 128: Code Review Fix Report

**Fixed at:** 2026-07-08T20:15:00Z
**Source review:** .planning/phases/128-ai-server-analysis/128-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7
- Fixed: 7
- Skipped: 0

## Fixed Issues

### CR-01: Module import naming mismatch causes runtime load failure

**Files modified:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server-tools.ts` (renamed to `server_tools.ts`)
**Commit:** `2da6b2f`
**Applied fix:** Renamed `server-tools.ts` (hyphen) to `server_tools.ts` (underscore) to match the import path `./server_tools.js` used in `index.ts`. This fixes the `Cannot find module 'server_tools.js'` startup error on case-sensitive filesystems (Linux production). All other files in the directory follow the underscore convention, making this consistent.

### CR-02: getServerAlertsTool returns all alerts, not filtered by serverId

**Files modified:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts`
**Commit:** `fcad4a0`
**Applied fix:** Added `server_id: serverId` to the `alertDatabaseService.getAlerts()` call options. The `getAlerts` method fully supports `server_id` filtering (lines 155, 185-188 of `alert-database-service.ts`), but the tool handler was not passing it, causing every invocation to return all system alerts regardless of which serverId was requested. Also updated the misleading comment that said alerts have "没有 server_id 关联".

### WR-01: Missing auth/permission documentation on all 4 tools

**Files modified:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts`
**Commit:** `b945a53`
**Applied fix:** Added module-level documentation comment explaining the access control model. All 4 tools use `group: 'slide_self_mgmt'` for group-based routing, and auth enforcement is expected at the tool execution middleware layer. The `ownerOnly` flag is documented as available for stricter user authentication when needed. This documents the intended access control without changing runtime behavior (which could introduce regressions if the middleware already handles auth).

### WR-02: Unvalidated metricName input passed to SQL

**Files modified:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts`
**Commit:** `159e77c`
**Applied fix:** Added allowlist validation for `metricName` in `getServerMetricsTool` handler. The parameter is now validated against the known set of valid metric names: `['cpu_usage', 'memory_usage', 'disk_usage', 'load_1min', 'uptime']`. Invalid metric names return a clear error response with `errorCode: 'INVALID_PARAMETER'` instead of silently returning empty results.

### WR-03: Error swallowing in helper functions results in silent failures

**Files modified:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts`
**Commit:** `ac7fd37`
**Applied fix:** Removed try/catch blocks from all three database helper functions (`getLatestMetrics`, `getMetricHistory`, `getAllServersLatestMetrics`). Errors now propagate to the calling tool handlers' existing error-handling catch blocks, which return proper `{ success: false, error: ..., errorCode: ... }` responses. The null-pool early returns are preserved for the case when `dbConnection.getPool()` returns null (pre-existing non-error path).

### IN-01: Undefined property access on alert fields

**Files modified:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts`
**Commit:** `281835d`
**Applied fix:** Changed `alert.level` to `alert.severity` (correct property name returned by `getAlerts` service method) and removed the misleading `|| alert.level` fallback. Made `instance_name` optional in `ServerAlertInfo` interface (`instance_name?: string`) since it is only present for alerts with a non-null `instance_id`, fixing the type contract violation.

### IN-02: Magic number for hour-to-ms conversion

**Files modified:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts`
**Commit:** `281835d`
**Applied fix:** Replaced the magic number `3600000` with a named constant `const HOUR_MS = 3_600_000` for readability. This was included in the same commit as IN-01 since both changes were in the same file.

---

_Fixed: 2026-07-08T20:15:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
