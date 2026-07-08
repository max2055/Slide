---
phase: 127-server-reports
reviewed: 2026-07-08T22:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - apps/db-ops-api/src/server-report-service.ts
  - apps/db-ops-api/server.ts
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 127: Code Review Report

**Reviewed:** 2026-07-08T22:00:00Z
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Reviewed `server-report-service.ts` (new service, ~393 lines) and the server report routes in `server.ts` (lines 1552-1579). The implementation adds `ServerReportService` for generating server health inspection reports with HTML/Markdown output, plus two API routes (`POST /api/servers/reports/generate` and `GET /api/servers/reports`).

Overall code quality is reasonable: parameterized SQL queries are used (no injection), HTML output includes `_escapeHtml` for host/label fields, and route permissions are appropriately gated. However, four warnings and three info items were identified.

Key concerns:
1. `_statusBadge()` does not escape the `status` value when interpolating it into both the CSS class attribute and the span text content -- a latent XSS vector if the status value ever deviates from the four enums.
2. NULL metric values in `server_metrics` are converted to 0 (healthy) via `Number(null)` -- a silent data integrity problem.
3. Load scoring assumes a fixed scale (thresholds 1, 2) with no awareness of CPU core count, producing false-critical alarms on multi-core servers.

## Warnings

### WR-01: _statusBadge does not escape status value (XSS vector)

**File:** `apps/db-ops-api/src/server-report-service.ts:386-388`

**Issue:** The `_statusBadge` method interpolates the `status` string directly into both the CSS class name and the span's text content without HTML escaping. While the current enum values (`'online' | 'offline' | 'error' | 'unreachable'`) are safe, there is no defense if a future schema change, data corruption, or edge case produces an unexpected value. A status like `"><script>alert(1)` would produce valid XSS.

Additionally, `_escapeHtml` is called on `host` and `label` (line 208) but not on the `status` value in `_statusBadge`, creating an inconsistency in sanitization coverage.

**Fix:** Escape the `status` value and use a class map to decouple CSS class names from raw status values:

```typescript
private _statusBadge(status: string): string {
  const cssMap: Record<string, string> = {
    online: 'online', offline: 'offline',
    error: 'error', unreachable: 'unreachable',
  };
  const cssClass = cssMap[status] || 'offline';
  return `<span class="status-badge ${cssClass}">${this._escapeHtml(status)}</span>`;
}
```

### WR-02: NULL metric_value silently converts to 0 (false healthy reading)

**File:** `apps/db-ops-api/src/server-report-service.ts:114`

**Issue:** `Number(row.metric_value)` converts `null` to `0`. If `server_metrics.metric_value` is NULL for a row (e.g., partial insert, collection edge case), the metric is silently treated as 0% usage. For CPU, memory, and disk metrics, 0% means perfect health (score 100). This masks the fact that no actual data was collected, producing a false sense of health.

The SQL subquery (lines 96-106) selects the latest row per `metric_name` regardless of whether `metric_value` is NULL, so a row with a NULL value would be found and processed.

**Fix:** Skip rows where `metric_value` is null:

```typescript
for (const row of rows) {
  if (row.metric_value === null || row.metric_value === undefined) continue;
  const value = Number(row.metric_value);
  // ...
}
```

Alternatively, guard `Number()` with a null check:

```typescript
const value = row.metric_value != null ? Number(row.metric_value) : null;
if (value === null) continue;
```

### WR-03: Load scoring ignores actual CPU core count

**File:** `apps/db-ops-api/src/server-report-service.ts:57-63`

**Issue:** `scoreLoad()` uses fixed thresholds (1, 2) for the `load_1min` metric. The comment on line 57 says "assume 4 cores" but the function does not receive or use any CPU count value. On a 32-core server, a load_1min of 6.0 is perfectly normal (0.1875 per core), yet this function scores it as 20 (critical). This will consistently produce false-critical alarms for multi-core servers, reducing trust in the report.

The load information per core is already widely available -- the function needs access to the actual CPU core count from the `server_metrics` table or the `servers` configuration table.

**Fix:** Either (a) store and query CPU core count per server and normalize `load_1min` by `core_count`, or (b) document that the current scheme only works for single/dual-core servers and add a core_count field to the server model. As a short-term correctness improvement:

```typescript
function scoreLoad(value: number | null, coreCount: number = 4): number {
  if (value === null) return 0;
  const loadPerCore = value / coreCount;
  if (loadPerCore < 1) return 100;
  if (loadPerCore <= 2) return 60;
  return 20;
}
```

This requires plumbing `core_count` (defaulting to 4) through the `ServerReportEntry` or fetching it per server.

### WR-04: Score boundary renders 80/100 as "warning" when 3/4 dimensions are perfect

**File:** `apps/db-ops-api/src/server-report-service.ts:69-73` and `181-184`

**Issue:** The classification thresholds in `scoreClass` and the count-categorization logic are `> 80` for "good"/"healthy" and `>= 60` for "warning". This means an overall_score of exactly 80 (possible from scores [100, 100, 100, 60]) is labeled "warning" even though three out of four dimensions are perfect. The human-inspection impact is that a server with a single slightly-elevated metric (80.1% CPU → score 60) and three perfect metrics (all 100) averages to 85 → "healthy", but at exactly 80% boundary → "warning". This inconsistent rule is counterintuitive.

This is not a functional bug, but the strict `> 80` vs `>= 80` split causes a misleading report summary where an 80-point server is counted as "warning" alongside servers with genuinely degraded health.

**Fix:** Align thresholds so that 80 (out of 100) is treated as "good":

```typescript
function scoreClass(value: number): string {
  if (value >= 80) return 'good';
  if (value >= 60) return 'warning';
  return 'critical';
}
```

And similarly for the count categorization:

```typescript
if (entry.overall_score >= 80) healthy_count++;
else if (entry.overall_score >= 60) warning_count++;
else critical_count++;
```

## Info

### IN-01: Misleading comment in scoreLoad

**File:** `apps/db-ops-api/src/server-report-service.ts:57`

**Issue:** The JSDoc comment says "Score load_1min relative to CPU count (assume 4 cores)" but the function does not accept a CPU count parameter and does not normalize by core count. The thresholds (1, 2) are absolute numbers, not per-core. The comment promises behavior that the function does not deliver.

**Fix:** Either implement per-core normalization (see WR-03) or correct the comment to accurately describe what the function does.

### IN-02: `as any` type assertion on query results

**File:** `apps/db-ops-api/src/server-report-service.ts:107`

**Issue:** The `pool.execute()` result is cast to `any`, bypassing all TypeScript type checking. The same pattern appears in the server metrics routes in `server.ts` (line 1414, 1461). While this is consistent with codebase-wide convention, it means type errors in row access silently pass compilation.

**Fix:** Create a typed wrapper or row mapper for `server_metrics` query results (out of scope for this phase, noted for follow-up).

### IN-03: _statusBadge uses raw status as CSS class name

**File:** `apps/db-ops-api/src/server-report-service.ts:386-388`

**Issue:** The status string is used directly as a CSS class name (`class="status-badge ${status}"`). This works for the current four enum values (`online`, `offline`, `error`, `unreachable`) but is fragile -- any new status value that contains spaces or special characters would produce invalid CSS class syntax.

**Fix:** See WR-01 fix which addresses this by using a mapping object.

---

_Reviewed: 2026-07-08T22:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
