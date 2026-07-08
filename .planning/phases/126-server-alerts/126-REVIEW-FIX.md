---
phase: 126-server-alerts
fixed_at: 2026-07-08T20:00:00Z
review_path: .planning/phases/126-server-alerts/126-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 126: Code Review Fix Report — Server Alerts

**Fixed at:** 2026-07-08T20:00:00Z
**Source review:** .planning/phases/126-server-alerts/126-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7
- Fixed: 7
- Skipped: 0

## Fixed Issues

### CR-01: Alert interface and _rowToAlert omit server_id — data loss on read-back

**File:** `apps/db-ops-api/src/alert-database-service.ts`
**Commit:** 2a28a80
**Applied fix:** Added `server_id: number | null` to the `Alert` interface (after `instance_id`). Added `server_id: row.server_id` to the `_rowToAlert` mapper. This ensures server alerts read back from the database preserve the server association instead of silently dropping it.

### CR-02: getAlertRules() query does not SELECT target_type or server_id

**File:** `apps/db-ops-api/src/alert-database-service.ts`
**Commit:** 497910f
**Applied fix:** Added `target_type, server_id` to the SELECT clause in both `getAlertRules()` and `getRuleById()` methods. After migration 021 adds these columns, the canonical query paths now include them.

### CR-03: AlertRule interface missing target_type and server_id fields

**File:** `apps/db-ops-api/src/alert-database-service.ts`
**Commit:** 41561d9
**Applied fix:** Added `target_type?: 'instance' | 'server'` and `server_id?: number | null` to the `AlertRule` interface. All downstream consumers can now differentiate server-scoped rules from instance-scoped ones without type assertions.

### WR-01: createAlertRule and updateAlertRule do not support target_type or server_id

**File:** `apps/db-ops-api/src/alert-database-service.ts`
**Commit:** 4f8487d
**Applied fix:** Added `target_type` and `server_id` parameters to both `createAlertRule` and `updateAlertRule`. For `createAlertRule`, added the columns to the INSERT statement with defaults (`'instance'` and `null`). For `updateAlertRule`, added dynamic update clauses for both fields. Server-scoped rules can now be created and modified through the service API.

### WR-02: getAlerts() has no server_id filter — server alerts mixed indistinguishably with instance alerts

**File:** `apps/db-ops-api/src/alert-database-service.ts`
**Commit:** ed387c2
**Applied fix:** Added `server_id?: number` to the `getAlerts()` options parameter. Added `a.server_id` and `COALESCE(s.label, s.host, '') as server_name` to the SELECT, with a `LEFT JOIN servers s ON a.server_id = s.id`. Added `server_id` filter condition to WHERE clause. Added `server_id` and `server_name` to the response items shape. Updated count queries (total, unread, critical, warning, resolved) to include `server_id` filtering.

### WR-03: server-alert-evaluator uses raw SQL instead of reusing alertDatabaseService.getAlertRules()

**File:** `apps/db-ops-api/src/server-alert-evaluator.ts`
**Commit:** a726ed0
**Applied fix:** Replaced the inline raw SQL query in `evaluateServerRules()` with a call to `alertDatabaseService.getAlertRules(true)` followed by filtering `r.target_type === 'server'`. This removes the maintenance hazard of parallel query definitions and uses the canonical API. Also replaced the `dbConnection.getPool()` guard with `dbConnection.isConnected()` since the raw pool query was the only use of the pool variable.

### WR-04: findActiveServerAlert unreachable dedup uses rule_id=0 with JSON_EXTRACT — edge case at row boundary

**File:** `apps/db-ops-api/src/alert-database-service.ts`
**Commit:** dc0d6a4
**Applied fix:** Changed `JSON_EXTRACT(tags, '$.rule_id') = ?` to `JSON_EXTRACT(tags, '$.rule_id') = CAST(? AS JSON)` in `findActiveServerAlert`. This ensures explicit type safety when `ruleId` is `0`, preventing silent comparison failures if the JSON stores the value as a number or the schema changes.

## Skipped Issues

None — all 7 findings were successfully fixed.

---

_Fixed: 2026-07-08T20:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
