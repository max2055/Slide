---
phase: 115-openclaw-todo-ci
plan: 03
subsystem: backend
tags:
  - rbac
  - capacity
  - status-check
  - todo-cleanup
requires:
  - 115-01
provides: []
affects:
  - apps/db-ops-api/src/tools/ops/get_instance_summary.ts
  - apps/db-ops-api/src/tools/ops/list_active_alerts.ts
  - apps/db-ops-api/src/report-service.ts
  - apps/db-ops-api/src/tools/generated/slide-self-mgmt/check_status.ts
tech-stack:
  added: []
  patterns:
    - RBAC scope filtering via RbacService.getUserInstanceAccess()
    - Real capacity data dispatch via databaseService.getCapacityInfo()
    - LLM provider connectivity test via Promise.allSettled + fetch
key-files:
  created: []
  modified:
    - apps/db-ops-api/src/tools/ops/get_instance_summary.ts
    - apps/db-ops-api/src/tools/ops/list_active_alerts.ts
    - apps/db-ops-api/src/report-service.ts
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/check_status.ts
decisions: []
metrics:
  duration: 0m 36s
  completed_date: "2026-06-02"
---

# Phase 115 Plan 03: Fix Backend TODO Stubs Summary

Fix 4 remaining backend TODO stubs after D-04 eliminated configure_llm.ts: implement RBAC scope filtering in two ops tools, implement real capacity data collection in report-service.ts, and add real connectivity checks in check_status.ts.

## Tasks

| # | Name | Status | Commit | Files |
|---|------|--------|--------|-------|
| 1 | Add RBAC scope filtering to get_instance_summary.ts and list_active_alerts.ts | Done | `b3b0fb3` | `get_instance_summary.ts`, `list_active_alerts.ts` |
| 2 | Implement real capacity data collection in report-service.ts | Done | `318f854` | `report-service.ts` |
| 3 | Fix check_status.ts to perform real status checks | Done | `a92de55` | `check_status.ts` |

## Details

### Task 1: RBAC Scope Filtering

Both `get_instance_summary.ts` and `list_active_alerts.ts` now import `RbacService` and filter results by the authenticated user's instance-level permissions.

- **get_instance_summary.ts**: When querying a single instance by ID, the handler checks `context?.userId` and verifies the user has access via `rbacService.getUserInstanceAccess()`. When querying all instances, results are post-filtered to only include instances in the user's permitted set.
- **list_active_alerts.ts**: After the existing severity/time filtering, alerts are further filtered by the user's permitted instance IDs.
- Both tools fall back to returning all results when no `userId` is present (service account / no auth context), preserving backward compatibility.
- The original `TODO(D-08)` comments are removed from both files.
- Security: Uses `requestContext.userId` from authenticated context, never from client-supplied parameters.

### Task 2: Real Capacity Data Collection

`report-service.ts collectCapacityData()` no longer returns a stub with hardcoded zeros. The implementation:

1. Gets instance info via `instanceDatabaseService.getInstanceById()`
2. Gets real OS disk usage from `metricsDatabaseService.getRealtimeMetrics()` 
3. Gets actual database storage data via `databaseService.getCapacityInfo()` (which dispatches to the correct `getMySQLCapacity`/`getPostgresCapacity`/`getOracleCapacity`/`getDamengCapacity` based on `db_type`)
4. Computes `growth_trend` from capacity history (`metricsDatabaseService.getCapacityHistory()` with 30-day window)
5. Falls back to safe defaults on error or missing instance

### Task 3: Real Status Checks

`check_status.ts` now performs real LLM provider connectivity tests:

- **Database connection check**: Was already using real `databaseService.checkConnectionAlive()` -- unchanged.
- **LLM provider check**: Enhanced from a simple API-key-existence check to a real connectivity test. Iterates over all configured providers with valid API keys, uses `Promise.allSettled` with `fetch()` to concurrently ping each provider's `baseUrl` with a 5-second timeout. Reports whether at least one provider endpoint is reachable. Returns "stopped" (not "unknown") when no providers are configured.

## Deviations from Plan

None -- plan executed exactly as written.

## Threat Flags

None -- all changes are within the planned scope and threat model. RBAC filtering uses `requestContext.userId` as specified, no new network endpoints or trust boundaries were introduced.

## Self-Check: PASSED

- [x] Task 1: `get_instance_summary.ts` and `list_active_alerts.ts` contain RBAC references (5 and 3 matches respectively)
- [x] Task 2: `collectCapacityData()` no longer has TODO comment, uses real capacity methods
- [x] Task 3: `check_status.ts` references `getAllProviders`, `checkConnectionAlive`, and per-provider `fetch` connectivity test
- [x] No TODO comments remain in any of the 4 target files
- [x] No post-commit deletions
- [x] 3 commits created and verified
