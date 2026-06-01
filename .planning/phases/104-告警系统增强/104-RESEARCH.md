# Phase 104: 告警系统增强 - Research

**Researched:** 2026-05-21
**Domain:** Alert System (backend CRUD, event aggregation, frontend UI)
**Confidence:** HIGH

## Summary

Phase 104 addresses four interlocking gaps in the alert system: (1) threshold editing is limited to a single number instead of three independent levels, (2) the rule list has no inline enable/disable toggle, (3) `threshold_type`, `dynamic_config`, and `silence_minutes` columns exist in the database but are never read or written by the backend service layer, and (4) event aggregation uses a fixed 5-minute FLOOR bucket boundary that causes split-incidents when alerts cross bucket boundaries.

The root cause of all three persistence gaps (ALERT-01, ALERT-03) is the same: `alert-database-service.ts` was never updated after the Phase 06 schema migration added `threshold_type`, `dynamic_config`, and `silence_minutes` columns. The SELECT query omits these columns, the INSERT omits them, and the UPDATE handler omits them. The frontend rule form and the PUT route handler also don't forward them. Fixing the service layer is the single most critical task -- everything else depends on it.

**Primary recommendation:** Fix `alert-database-service.ts` first (SELECT/INSERT/UPDATE all three columns), then the PUT route and frontend form, then the toggle switch, then the event aggregation change.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Threshold persistence | API/Backend | Database | alert_rules columns exist but are never read/written by service layer |
| Threshold editing UI | Browser/Client | API/Backend | Form fields in alerts.ts, validation rules sent to backend |
| Enable/disable toggle | Browser/Client | API/Backend | Optimistic UI in frontend, PUT route persists `enabled` field |
| threshold_type toggle | Browser/Client | API/Backend | Frontend toggle controls visibility of manual threshold inputs; backend reads the column in alert-evaluator.ts |
| silence_minutes config | Browser/Client | API/Backend | Frontend number input; backend uses value in alert-engine.ts createAlertFromRule() |
| Event aggregation | Database | API/Backend | SQL query change in event-aggregator.ts -- replace FLOOR bucket with time-difference JOIN |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| mysql2 | ^3.x | Database access | Existing project standard, used in all alert services |
| Lit 3.3 | 3.3.x | Frontend Web Components | Existing project standard for all views |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Fastify | ^4.x | HTTP routes | Existing backend standard |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct MySQL queries in service | ORM (TypeORM/Prisma) | Not worth the migration; existing pattern is raw SQL with mysql2 |

**Verified versions:** [VERIFIED: package.json in frontend/ and apps/db-ops-api/]

## Package Legitimacy Audit

> This phase does not introduce any new external packages. All changes are within existing dependencies (mysql2, mysql2/promise, Lit, Fastify). No npm install required.

| Package | Registry | Disposition |
|---------|----------|-------------|
| _(none new)_ | - | No external packages added |

## Architecture Patterns

### System Architecture Diagram

```
Browser (alerts.ts)
  |
  |-- GET /api/alert-rules  ------> alertDatabaseService.getAlertRules()
  |-- PUT /api/alert-rules/:id ----> alertDatabaseService.updateAlertRule()
  |-- POST /api/alert-rules -------> alertDatabaseService.createAlertRule()
  |-- (toggle) PUT /api/alert-rules/:id { enabled } --> updateAlertRule()
  |
  v
Backend (server.ts)
  |
  v
alert-database-service.ts  -->  MySQL alert_rules table
  |                              (threshold_type, silence_minutes, dynamic_config
  |                               exist in schema but NOT read/written)
  v
alert-evaluator.ts  -->  resolveDynamicThreshold() checks rule.threshold_type
                         but always undefined -> always falls back to static
  v
alert-engine.ts  -->  createAlertFromRule() uses rule.silence_minutes ?? 5
                      but always undefined -> always uses default 5
  v
event-aggregator.ts  -->  SQL: FLOOR(UNIX_TIMESTAMP/300)*300 fixed 5-min bucket
  v
alert_events / alert_event_members tables
```

### Current Gaps (data flow that doesn't happen)

```
Database columns: threshold_type, silence_minutes, dynamic_config
    |
    v  NOT SELECTED by getAlertRules()
alert-database-service.ts: AlertRule interface has NO fields for these
    |
    v  NOT SENT in PUT/POST response
server.ts routes: body fields not forwarded
    |
    v  NOT SENT in _saveRule()
Frontend alerts.ts: ruleForm fields not included
```

### Pattern 1: Three Independent Threshold Inputs
**What:** Replace single `threshold` number input with three separate inputs for `warning`, `error`, `critical`. Store as `threshold_template` JSON in the database (current shape: `{"warning": 80, "error": 90, "critical": 95}`).
**When to use:** D-01 mandates this. The three values replace the single `threshold` column for rules that have `threshold_template`.
**Validation:** `warning < error < critical` per D-02. Empty allowed (null = that level doesn't trigger). Use existing `evaluateRuleWithLevels()` which handles missing levels gracefully.

### Pattern 2: Inline Toggle Switch with Optimistic UI
**What:** Per-row toggle in the rule list table. Click immediately updates UI, then fires PUT to backend. On failure, rollback to original state.
**When to use:** D-03 mandates this. Existing pattern in `reports.ts` `_toggleConfig()` lines 815-832.
**Example pattern (from reports.ts):**
```typescript
private async _toggleConfig(cfg: ReportConfig) {
  const originalEnabled = cfg.enabled;
  cfg.enabled = !cfg.enabled;      // optimistic update
  this.requestUpdate();
  try {
    const res = await authFetch(`/api/reports/configs/${cfg.id}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ enabled: cfg.enabled }),
    });
    if (!res.ok) throw new Error('update failed');
    this.loadConfigs();
  } catch (err) {
    cfg.enabled = originalEnabled; // rollback
    this.requestUpdate();
  }
}
```

### Pattern 3: threshold_type Toggle Shows/Hides Threshold Inputs
**What:** When threshold_type is "static", show the three threshold inputs; when "dynamic", hide manual thresholds and show `dynamic_config` fields (sigma, lookback_days) or a message like "阈值由基线算法自动计算".
**When to use:** D-04 mandates this for both frontend and backend.

### Pattern 4: Sliding Window Event Aggregation
**What:** Replace the fixed 5-minute FLOOR bucket with a time-difference-based approach: for each new alert, check if there's an existing open event for the same `instance_id` + `alert_type` + `metric_name` where the latest member alert's `created_at` is within 10 minutes. If so, group into that event. Otherwise, start a new event.
**When to use:** D-06 mandates this.

### Anti-Patterns to Avoid
- **Silent rollback without user feedback:** When toggle fails, the optimistic UI must show visible error feedback (not just silently revert). The reports.ts pattern uses `alert()`, but alerts.ts should use a more native-feeling inline error.
- **Incomplete column handling:** The root cause of ALERT-01 and ALERT-03 is that three source files (service, route, frontend) each need the same three columns added. Missing any one file means the feature doesn't work.
- **Breaking existing data during migration:** The schema already has the columns. No ALTER TABLE is needed. Existing rows with `threshold_type = 'static'` (default) should continue working.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Dynamic threshold resolution | Custom z-score calculation | Existing `baselineCalculator.getCachedBaseline()` | Already implemented in baseline-calculator.ts; just need to wire up via `resolveDynamicThreshold()` |
| Toggle switch component | Custom toggle from scratch | Existing `.cfg-toggle` CSS pattern (alerts.ts lines 662-705) | Already defined in alerts.ts for the config panel; reuse for rule list |

**Key insight:** The infrastructure for dynamic thresholds and toggle switches already exists. This phase is about wiring existing pieces together, not building new capabilities.

## Common Pitfalls

### Pitfall 1: Backend-Only Fix Misses Frontend
**What goes wrong:** Developer adds `threshold_type` to SELECT/INSERT/UPDATE in the service layer but doesn't update the frontend `_saveRule()` or the PUT route handler. Result: columns are persisted when manually updated via API but never get written by users.
**How to avoid:** Verify all three layers (service, route, frontend) in the same task.

### Pitfall 2: Optimistic Toggle Without Error Feedback
**What goes wrong:** Toggle fires PUT, UI flips optimistically, PUT fails, UI silently reverts. User thinks the toggle worked.
**How to avoid:** Add inline error feedback (e.g., a toast or message next to the toggle) when rollback happens. The cfg-toggle pattern from reports.ts should be extended.

### Pitfall 3: Sliding Window Aggregation Duplicate Events
**What goes wrong:** The new sliding-window logic creates two events for the same time range because the WHERE clause doesn't exclude alerts already in an event.
**How to avoid:** Keep the existing `NOT EXISTS (SELECT 1 FROM alert_event_members m WHERE m.alert_id = a.id)` guard. Only query alerts not yet in any event member.

### Pitfall 4: Existing Rules Without threshold_template
**What goes wrong:** Seed data rules created via the original INSERT statement have no `threshold_template`. When the form saves, it might send `null`, causing `evaluateRuleWithLevels()` to fall back to single-threshold logic.
**How to avoid:** The form should always send a `threshold_template` object (even if empty `{}` or null). The backend should handle `null` gracefully (which it already does via the `if (!tt)` fallback in `evaluateRuleWithLevels()`).

### Pitfall 5: Sliding Window Without Performance Concern
**What goes wrong:** The current FLOOR bucket approach runs ONE GROUP BY query for all unaggregated alerts. A sliding-window approach might need per-alert processing, which could be O(n) queries.
**How to avoid:** Use a two-step approach: (1) one query to find unaggregated alerts, (2) group them in application code by comparing `created_at` timestamps against the last alert in each candidate event. This avoids N+1 queries.

## Code Examples

### Current getAlertRules() SELECT (lines 379-384) -- needs 3 more columns
```typescript
// CURRENT -- does NOT select threshold_type, dynamic_config, silence_minutes
let sql = `
  SELECT id, name, description, metric_name, operator, threshold,
         threshold_template, duration_seconds, severity,
         enabled, notification_channels,
         created_by, created_at, updated_at
  FROM alert_rules
`;
```

### Current AlertRule interface (lines 30-45) -- needs 3 more fields
```typescript
// CURRENT -- missing threshold_type, dynamic_config, silence_minutes
export interface AlertRule {
  id: number;
  name: string;
  // ...
  // ADD:  threshold_type: 'static' | 'dynamic';
  // ADD:  dynamic_config?: { sigma?: number; lookback_days?: number; } | null;
  // ADD:  silence_minutes: number;
}
```

### Current updateAlertRule() (lines 453-529) -- needs 3 more UPDATE cases
The pattern for adding a new column to updateAlertRule() is mechanical: add a `if (data.<field> !== undefined)` block with:
```typescript
// PATTERN for each new field:
if (data.threshold_type !== undefined) {
  updates.push('threshold_type = ?');
  values.push(data.threshold_type);
}
```

### Current createAlertRule() INSERT (line 424-441) -- needs 3 more columns
The INSERT needs additional columns and parameter placeholders. Current pattern:
```typescript
`INSERT INTO alert_rules
 (name, description, metric_name, operator, threshold, threshold_template, duration_seconds,
  severity, notification_channels, created_by)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
// ADD: threshold_type, dynamic_config, silence_minutes to both column and VALUES lists
```

### Current Frontend _saveRule() (lines 1838-1879) -- missing fields
```typescript
// CURRENT body in _saveRule -- missing threshold_template, threshold_type, silence_minutes
const body: any = {
  name: form.name,
  description: form.description || '',
  metric_name: form.metric_name,
  operator: form.operator || '>',
  threshold: Number(form.threshold) || 0,
  duration_seconds: Number(form.duration_seconds) || 60,
  severity: form.severity || 'warning',
};
// ADD: threshold_template: form.threshold_template,
// ADD: threshold_type: form.threshold_type,
// ADD: silence_minutes: form.silence_minutes,
```

### Current event aggregation SQL (lines 36-47) -- replace FLOOR bucket
```sql
-- CURRENT: fixed 5-min bucket, groups alerts by time_bucket
SELECT instance_id, alert_type, metric_name,
       FLOOR(UNIX_TIMESTAMP(created_at) / 300) * 300 AS time_bucket,
       GROUP_CONCAT(id ORDER BY id) AS alert_ids,
       COUNT(*) AS cnt,
       MAX(FIELD(level, 'info', 'warning', 'error', 'critical', 'p0')) AS max_level
FROM alerts
WHERE status IN ('unread', 'read')
  AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
  AND NOT EXISTS (SELECT 1 FROM alert_event_members m WHERE m.alert_id = alerts.id)
GROUP BY instance_id, alert_type, metric_name, time_bucket
HAVING cnt >= 2
```

### Recommended sliding window replacement
```sql
-- REPLACEMENT: time-difference approach
-- Step 1: For each unaggregated alert, find if it can join an existing event
SELECT a.id, a.instance_id, a.alert_type, a.metric_name, a.level, a.created_at,
       e.id AS existing_event_id,
       TIMESTAMPDIFF(SECOND, last_member.created_at, a.created_at) AS seconds_since_last_member
FROM alerts a
LEFT JOIN alert_event_members mem ON mem.alert_id = (
  -- Find the event this alert might join: same instance+type+metric, within 10 min window
  SELECT m2.event_id
  FROM alert_event_members m2
  JOIN alerts a2 ON a2.id = m2.alert_id
  JOIN alert_events e2 ON e2.id = m2.event_id AND e2.status IN ('open', 'investigating')
  WHERE a2.instance_id = a.instance_id
    AND a2.alert_type = a.alert_type
    AND a2.metric_name = a.metric_name
    AND a.created_at <= DATE_ADD(a2.created_at, INTERVAL 10 MINUTE)
    AND a.created_at >= a2.created_at  -- alert must be newer
  ORDER BY m2.created_at DESC
  LIMIT 1
)
LEFT JOIN alert_events e ON e.id = mem.event_id
LEFT JOIN alert_event_members last_member ON last_member.id = (
  SELECT m3.id FROM alert_event_members m3
  WHERE m3.event_id = mem.event_id
  ORDER BY m3.created_at DESC
  LIMIT 1
)
WHERE a.status IN ('unread', 'read')
  AND a.created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
  AND NOT EXISTS (SELECT 1 FROM alert_event_members m WHERE m.alert_id = a.id);
```

Note: The exact SQL implementation should be tested against the actual database. An alternative approach is to process in application code: fetch unaggregated alerts, find candidate events per instance+type+metric, and check time differences in TypeScript rather than pure SQL.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single threshold number input | Three-level thresholds (warning/error/critical) | Phase 104 | D-01: user-facing change, validation required |
| Status badge text (enabled/disabled) | Inline toggle switch | Phase 104 | D-03: optimistic UI with rollback |
| threshold_type/silence_minutes not persisted | Full CRUD for both columns | Phase 104 | D-04/D-05: fixes ALERT-01 and ALERT-03 |
| FLOOR(UNIX_TIMESTAMP/300)*300 | Sliding 10-min time window | Phase 104 | D-06: fixes ALERT-04 |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | No ALTER TABLE needed; columns already exist from Phase 06 schema migration | Summary | Verified by reading schema.sql lines 1043-1046 |
| A2 | The `cfg-toggle` CSS in alerts.ts lines 662-705 can be reused for rule list toggle | Code Examples | Low risk -- CSS is defined in same component, just not applied to rule list |
| A3 | The sliding window should compare new alert's created_at with the latest member created_at | Code Examples | Different valid approaches exist; application-code grouping may be preferred over SQL |

## Open Questions (RESOLVED)

1. **How exactly should the sliding window query work?** (RESOLVED)
   - Decision: Use application-code grouping. Fetch unaggregated alerts from the last 10 minutes, sort by created_at, group by instance_id+alert_type+metric_name where time difference <= 10 minutes.
   - Why: Avoids complex SQL; clarity and testability.

2. **What happens to existing threshold_template values?** (RESOLVED)
   - Decision: Frontend form always sends threshold_template in save payload. Default for missing templates: `{warning: null, error: null, critical: null}`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| MySQL | All backend changes | ✓ | (in docker or configured) | -- |
| Node.js | Backend | ✓ | (as configured) | -- |
| npm | Frontend | ✓ | (as configured) | -- |

**Missing dependencies with no fallback:** None -- all dependencies are from the existing project stack.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | (existing - see Wave 0 gaps) |
| Config file | (existing) |
| Quick run command | `cd apps/db-ops-api && npx tsx server.ts` (manual test) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ALERT-01 | Update rule with 3 thresholds -> GET rule returns saved values | integration (manual) | (manual test via UI) | ❌ Wave 0 |
| ALERT-02 | Toggle enabled -> GET rule reflects new value | integration | (manual test) | ❌ Wave 0 |
| ALERT-03 | threshold_type, silence_minutes persist through save/reload | integration | (manual test) | ❌ Wave 0 |
| ALERT-04 | Alerts within 10-min window grouped under same event_id | integration | (manual test) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** Verify by running backend and testing via curl
- **Phase gate:** Full manual testing of all four requirements

### Wave 0 Gaps
- No existing alert-*.test.ts files for database-service or event-aggregator
- No existing frontend test infrastructure for alerts.ts component
- All validation is manual via UI interaction

## Security Domain

> Security enforcement is not explicitly configured in config.json. However, standard auth middleware applies.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | All existing alert routes already use verifyToken + requirePermission preHandler |
| V4 Access Control | yes | PUT/POST/DELETE alert-routes require `alert:manage` permission; GET requires `alert:view` |
| V5 Input Validation | yes | Input sanitization via Fastify body parsing; numeric type checking |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Permission elevation via rule edit | Elevation of Privilege | Existing `requirePermission('alert:manage')` on PUT/POST/DELETE routes |
| Invalid threshold values (non-numeric) | Tampering | Backend should validate `Number()` conversion; existing pattern returns 400 on failure |

## Sources

### Primary (HIGH confidence)
- `apps/db-ops-api/server.ts` lines 1674-1762 -- alert-rules route definitions
- `apps/db-ops-api/src/alert-database-service.ts` -- AlertRule interface and CRUD methods
- `apps/db-ops-api/src/event-aggregator.ts` -- current FLOOR bucket logic
- `apps/db-ops-api/src/alert-evaluator.ts` lines 122-147 -- resolveDynamicThreshold
- `apps/db-ops-api/src/alert-engine.ts` line 196 -- silence_minutes usage
- `apps/db-ops-api/sql/schema.sql` lines 1043-1046 -- existing ALTER TABLE columns
- `frontend/src/openclaw/ui/views/alerts.ts` -- full frontend implementation
- `frontend/src/openclaw/ui/views/reports.ts` lines 815-832 -- optimistic toggle pattern

### Secondary (MEDIUM confidence)
- `apps/db-ops-api/src/baseline-calculator.ts` -- dynamic threshold baseline logic (already exists, just needs wiring)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All files read and verified
- Architecture: HIGH - Complete data flow mapping from DB to UI
- Pitfalls: HIGH - Based on code review of all relevant files

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 (stable codebase, no fast-moving dependencies)
