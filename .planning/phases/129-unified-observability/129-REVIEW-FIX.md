---
phase: 129-unified-observability
fixed_at: 2026-07-09T06:00:00Z
review_path: .planning/phases/129-unified-observability/129-REVIEW.md
iteration: 2
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 129: Code Review Fix Report

**Fixed at:** 2026-07-09T06:00:00Z
**Source review:** .planning/phases/129-unified-observability/129-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 8
- Fixed: 8
- Skipped: 0

## Fixed Issues

### WR-02: Duplicate metric IDs overwrite instance metrics with server metrics

**Files modified:** `apps/db-ops-api/src/metric-registry.ts`
**Commit:** `268e99c`
**Applied fix:** Renamed server-level metric IDs from `cpu_usage`, `memory_usage`, `disk_usage` to `server_cpu_usage`, `server_memory_usage`, `server_disk_usage` to avoid `Map.set()` overwriting instance-level definitions.

**Status:** fixed: requires human verification — this is a logic change that renames registry IDs. Callers using `getById('cpu_usage')` expecting the server variant will now need to use `'server_cpu_usage'`. Verify no downstream code paths rely on the old ID values for server metric lookups.

### CR-04: Dead code after return in `_getPredefinedMetrics()`

**Files modified:** `apps/db-ops-api/src/metric-registry.ts`
**Commit:** `d43321f`
**Applied fix:** Removed unreachable registration loop (lines 592-594) that appeared after the `return` statement. The same loop exists in `loadPredefinedMetrics()` (line 597-601) which is the correct location.

### CR-01: Server health report generation from Reports page always fails

**Files modified:** `frontend/src/app/ui/views/reports.ts`, `apps/db-ops-api/server.ts`
**Commit:** `697fe51`
**Applied fix:** Changed frontend API path from `/api/reports/generate` to `/api/servers/reports/generate` when `type === 'server_health'`. Updated backend `/api/servers/reports/generate` handler to extract `server_id` from request body and pass it to `serverReportService.generateAndPersist()`.

### CR-02: Report config create/update routes do not pass `server_id`

**Files modified:** `apps/db-ops-api/server.ts`
**Commit:** `dbd9db7`
**Applied fix:** Added `server_id` to destructuring in POST `/api/reports/configs` handler. Added `server_id: server_id ? Number(server_id) : undefined` to `createConfig()` call. Added `server_id: body.server_id !== undefined ? Number(body.server_id) : undefined` to `updateConfig()` put handler.

### CR-03: `server_health` type excluded from validTypes in reports config route

**Files modified:** `apps/db-ops-api/server.ts`
**Commit:** `dbd9db7` (co-committed with CR-02)
**Applied fix:** Added `'server_health'` to the validTypes array in POST `/api/reports/configs` route so scheduled server health report configs can be created. The POST `/api/reports/generate` route intentionally excludes `server_health` since instance-based report generation should use the server-specific endpoint.

### WR-01: Permission key inconsistency — `alerts:manage` vs `alert:manage`

**Files modified:** `apps/db-ops-api/server.ts`
**Commit:** `83fe0cb`
**Applied fix:** Changed `requirePermission('alerts:manage')` to `requirePermission('alert:manage')` on all three alert rule template routes (POST/PUT/DELETE `/api/alert-rule-templates`), matching the existing convention used by alert rule routes and all other alert-related endpoints in the codebase.

### WR-03: Report config route requires `instance_id` but frontend may not send it for server type

**Files modified:** `apps/db-ops-api/server.ts`
**Commit:** `c26bfff`
**Applied fix:** Made the validation conditional: split the required field check into two parts. `name`, `cron`, `type` remain required always. `instance_id` is only required when `server_id` is not provided. Error message updated to reflect the OR condition.

### IN-01: Duplicate server_name mapping block in alerts page

**Files modified:** `frontend/src/app/ui/views/alerts.ts`
**Commit:** `8aac04a`
**Applied fix:** Removed the duplicate `server_name` mapping block (second occurrence of the same `if (this.servers.length > 0)` block performing `map()` to set `server_name` from the server map). The first instance at the same location already handles this mapping correctly.

---

_Fixed: 2026-07-09T06:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
