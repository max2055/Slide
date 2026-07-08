---
phase: 126-server-alerts
reviewed: 2026-07-08T20:00:00Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - apps/db-ops-api/sql/migrations/021_add_server_alert_fields.sql
  - apps/db-ops-api/src/server-alert-evaluator.ts
  - apps/db-ops-api/src/alert-database-service.ts
  - apps/db-ops-api/src/alert-engine.ts
findings:
  critical: 3
  warning: 4
  info: 0
  total: 7
status: issues_found
---

# Phase 126: Code Review Report — Server Alerts

**Reviewed:** 2026-07-08T20:00:00Z
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewing phase 126 server-alerts integration. The migration correctly adds server-scoping columns (`target_type`, `server_id`) to `alert_rules`, `alerts`, and `alert_events` tables. The `ServerAlertEvaluator` class properly evaluates server metric thresholds and unreachable detection, integrated into the existing `AlertEngine` evaluation loop.

However, three critical issues exist: the `Alert` interface and `_rowToAlert` mapper omit `server_id` (data loss on read-back), the `getAlertRules()` query does not SELECT the new columns, and the `AlertRule` interface lacks the new fields. These mean that after the migration runs, the service-layer code is incompatible with the database schema it created. Additionally, the `getAlerts()` method has no `server_id` filter, server alerts are indistinguishable from instance alerts in the API, and CRUD methods for alert rules cannot create or update server-scoped rules through the service layer.

## Critical Issues

### CR-01: Alert interface and _rowToAlert omit server_id — data loss on read-back

**File:** `apps/db-ops-api/src/alert-database-service.ts:7-28, 57-80`

**Issue:** The `Alert` interface (line 7) does not include a `server_id` property. The `_rowToAlert` mapper (line 57) does not map `server_id` from the database row. Migration 021 adds `server_id` to the `alerts` table, and `findActiveServerAlert` queries it, but the returned `Alert` objects silently drop `server_id`. Any caller that reads the alert back (e.g., for display, routing, or re-evaluation) will not know which server it belongs to.

The `Alert` interface has `instance_id: number | null` but no corresponding `server_id`. This is a data integrity loss — the server association is stored in the DB but discarded by the type system and mapper.

**Fix:**

1. Add `server_id` to the `Alert` interface:
```typescript
export interface Alert {
  id: number;
  instance_id: number | null;
  server_id: number | null;  // NEW
  alert_type: 'performance' | 'availability' | 'security' | 'backup' | 'replication' | 'capacity';
  // ... rest unchanged
}
```

2. Map it in `_rowToAlert`:
```typescript
return {
  id: row.id,
  instance_id: row.instance_id,
  server_id: row.server_id,  // NEW
  // ... rest unchanged
};
```

---

### CR-02: getAlertRules() query does not SELECT target_type or server_id

**File:** `apps/db-ops-api/src/alert-database-service.ts:591-619`

**Issue:** The `getAlertRules()` method's SQL query (line 598) selects all columns from `alert_rules` EXCEPT `target_type` and `server_id` — the two columns added by migration 021. After the migration runs, server-scoped rules stored in the database cannot be read through the canonical service API. This means:

- The existing UI that displays alert rules will show server-scoped rules as if they lack `target_type` and `server_id`.
- Any downstream consumer using `getAlertRules()` to decide which rules to evaluate will not know a rule should target servers rather than instances.
- The `server-alert-evaluator.ts` works around this by querying `alert_rules` directly with its own raw SQL (line 57) rather than reusing `getAlertRules()`, which is a code smell.

**Fix:** Add `target_type` and `server_id` to the SELECT clause in `getAlertRules()`:
```typescript
let sql = `
  SELECT id, name, description, metric_name, operator, threshold,
         threshold_template, threshold_type, dynamic_config, silence_minutes,
         db_types, instance_ids, template_id, duration_seconds, severity,
         enabled, notification_channels,
         target_type, server_id,  -- ADDED
         created_by, created_at, updated_at
  FROM alert_rules
`;
```

---

### CR-03: AlertRule interface missing target_type and server_id fields

**File:** `apps/db-ops-api/src/alert-database-service.ts:30-51`

**Issue:** Even after the `getAlertRules()` query is fixed (CR-02), the `AlertRule` TypeScript interface does not include `target_type` or `server_id` fields. All code that imports `AlertRule` — including `alert-evaluator.ts`, `alert-engine.ts`, route handlers, and the UI — cannot access these fields without type assertions or unchecked property access.

The interface is the single source of truth for rule shape. Every downstream consumer (rule evaluation, creation forms, display) needs these fields to differentiate server-scoped rules from instance-scoped ones.

**Fix:** Add the new fields to `AlertRule`:
```typescript
export interface AlertRule {
  id: number;
  name: string;
  description: string | null;
  target_type?: 'instance' | 'server';  // NEW
  server_id?: number | null;            // NEW
  metric_name: string;
  // ... rest unchanged
}
```

## Warnings

### WR-01: createAlertRule and updateAlertRule do not support target_type or server_id

**File:** `apps/db-ops-api/src/alert-database-service.ts:629-803`

**Issue:** The `createAlertRule()` method (line 629) and `updateAlertRule()` method (line 689) do not accept or persist the `target_type` or `server_id` fields. After running migration 021, server-scoped alert rules cannot be created or modified through the service API — only by direct SQL manipulation of the database.

The INSERT statement on line 653 and the dynamic UPDATE builder on line 716 both omit these new columns. Server-scoped rules inserted manually (or via the evaluator's test setup) cannot be managed through the existing CRUD surface.

**Fix:**

1. Add `target_type` and `server_id` to `createAlertRule`'s parameter type and INSERT:
```typescript
async createAlertRule(data: {
  name: string;
  target_type?: 'instance' | 'server';  // NEW
  server_id?: number;                    // NEW
  // ... existing fields
}): Promise<...> {
  // Add to INSERT:
  `...(name, description, metric_name, operator, threshold, ...,
    target_type, server_id, created_by)
   VALUES (?, ?, ..., ?, ?, ?)`,
  [
    // ... existing values
    data.target_type || 'instance',
    data.server_id || null,
    // ...
  ]
```

2. Add `target_type` and `server_id` to `updateAlertRule`'s parameter type and the update builder.

---

### WR-02: getAlerts() has no server_id filter — server alerts mixed indistinguishably with instance alerts

**File:** `apps/db-ops-api/src/alert-database-service.ts:149-273`

**Issue:** The `getAlerts()` method accepts filtering by `instance_id` but has no `server_id` filter. Server alerts (which have `instance_id = NULL` and `server_id` set) are mixed into the same result set as instance alerts. The method's count queries (total, unread, critical, warning, resolved) also do not differentiate between server and instance alerts.

The response format (line 243-268) maps `instance_id` and generates `instance_name`, but has no corresponding `server_id` or `server_name` fields. The `items` mapping omits `server_id` and `instance_id` from the record entirely (lines 244-263). This means the API consumer cannot distinguish a server alert from a dashboard instance alert.

**Fix:**
1. Add a `server_id` filter option to the `getAlerts()` parameter type.
2. Include `server_id` in the SELECT and in the response items shape.
3. Add a LEFT JOIN on the `servers` table to surface `server_name` (or `COALESCE(servers.label, servers.host)`), similar to the existing `database_instances` join.

---

### WR-03: server-alert-evaluator uses raw SQL instead of reusing alertDatabaseService.getAlertRules()

**File:** `apps/db-ops-api/src/server-alert-evaluator.ts:56-64`

**Issue:** The `evaluateServerRules()` method fetches server rules using its own hand-written SQL query rather than calling `alertDatabaseService.getAlertRules()`. This creates a maintenance hazard:

- If the query shape drifts, server rules and instance rules could have different column coverage.
- The raw query result is cast to `ServerAlertRuleRaw` (a local interface, lines 20-38), which duplicates parts of `AlertRule` and may diverge over time.
- The `as any` cast (line 64) bypasses type safety entirely.

This duplication suggests that `getAlertRules()` is not fit for purpose — it doesn't SELECT the new columns (CR-02). Fixing CR-02 should enable this code to switch to the shared API.

**Fix:** After fixing CR-02, replace the inline query with a call to `alertDatabaseService.getAlertRules(true)`, then filter for `target_type === 'server'`:
```typescript
const allRules = await alertDatabaseService.getAlertRules(true);
const serverRules = allRules.filter(r => r.target_type === 'server') as ServerAlertRuleRaw[];
```

---

### WR-04: findActiveServerAlert unreachable dedup uses rule_id=0 with JSON_EXTRACT — edge case at row boundary

**File:** `apps/db-ops-api/src/alert-database-service.ts:481-509`

**Issue:** When `findActiveServerAlert` is called with `ruleId = 0` (from `checkUnreachable` in server-alert-evaluator.ts line 211), the method queries `JSON_EXTRACT(tags, '$.rule_id') = ?` with the value `0`. This relies on implicit MySQL type coercion between a JSON scalar number and a bound integer parameter. In MySQL 8.0+, this generally works, but edge cases exist:

- If `tags` is NULL (some alert records may lack tags), `JSON_EXTRACT(NULL, '$.rule_id')` returns NULL, which will not match the comparison — this is actually correct behavior for dedup fallback.
- If a future schema migration changes the `tags` column type or another code path stores `rule_id` as a JSON string (`"0"` vs `0`), the `JSON_EXTRACT` comparison would silently fail.

Additionally, the fallback query (line 496-502) does not check `rule_id` at all, so any existing active alert for the same `server_id` + `metric_name` would be caught as a dedup match — regardless of `rule_id`. This is by design but should be documented as a known limitation.

**Fix:** Consider using `CAST(? AS JSON)` for explicit type safety in the JSON_EXTRACT comparison:
```typescript
`AND JSON_EXTRACT(tags, '$.rule_id') = CAST(? AS JSON)`,
```

## File-by-File Notes

### `021_add_server_alert_fields.sql`
Well-structured migration: idempotent, uses column-existence checks, adds indexes. No defects.

### `server-alert-evaluator.ts`
Logic is sound. The two evaluation paths (threshold rules and unreachable detection) are properly isolated, with per-rule try-catch to prevent one bad rule from blocking others. Dedup via `findActiveServerAlert` works correctly. The use of raw SQL for rule fetching (instead of the service API) is the main concern — tracked in WR-03.

### `alert-database-service.ts`
Contains all three critical issues (CR-01, CR-02, CR-03) and WR-01, WR-02, WR-04. The root cause is that the migration runs independently from the TypeScript types and CRUD methods. Every data access path needs to be updated to match the new schema.

### `alert-engine.ts`
Integration points for `serverAlertEvaluator.evaluateServerRules()` and `serverAlertEvaluator.checkUnreachable()` (lines 156-167) are correctly placed after the instance-based evaluation and auto-recovery loops. Error isolation via try-catch is present. No defects.

---

_Reviewed: 2026-07-08T20:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
