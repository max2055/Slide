---
phase: 107-instance-detail-dynamic-metrics
fixed_at: 2026-05-27T02:00:00Z
review_path: .planning/phases/107-实例详情页指标动态化/107-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 107: Code Review Fix Report

**Fixed at:** 2026-05-27T02:00:00Z
**Source review:** .planning/phases/107-实例详情页指标动态化/107-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (2 critical + 5 warning)
- Fixed: 7
- Skipped: 0

## Fixed Issues

### CR-01: SQL Injection via Unparameterized Dynamic Column Names

**Files modified:** `apps/db-ops-api/src/metrics-database-service.ts`
**Commit:** 8e6b1eb496f
**Applied fix:** Added `SAFE_ID_RE` regex filter (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) that validates all metric IDs before they are interpolated into SQL column references in `getHistoricalMetricsWithRange()`. Metric IDs containing characters outside the safe identifier pattern are silently excluded, preventing SQL injection through the `metrics` query parameter.

### CR-02: Inverted Threshold Coloring for "Lower Is Worse" Metrics

**Files modified:** `apps/db-ops-api/src/metric-registry.ts`, `frontend/src/app/ui/views/instance-detail.ts`
**Commit:** f1934b69f7b
**Applied fix:** Added `higher_is_worse` field to `MetricDefinition` interface in the backend. Set `higher_is_worse: false` on 6 predefined metrics where higher values are better (buffer_pool_hit_rate, cache_hit_ratio, sga_hit_rate, health_score, idx_scan_ratio, table_open_cache_hit_rate). Updated frontend `_getMetricColor()` and `_getProgressClass()` to use `<=` comparison when `higher_is_worse` is false, and `>=` (the default) otherwise.

### WR-01: Broken 5m / 15m Aggregation Bucketing

**Files modified:** `apps/db-ops-api/src/metrics-database-service.ts`
**Commit:** e83e73cfbf6
**Applied fix:** Replaced the identical `%Y-%m-%d %H:%i:00` DATE_FORMAT strings for 5m and 15m intervals with `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / N) * N)` expressions using 300s (5m) and 900s (15m) divisors. This produces correct 5-minute and 15-minute GROUP BY buckets.

### WR-02: Data Fracture Between Named Columns and metrics_data JSON

**Files modified:** `apps/db-ops-api/src/metrics-database-service.ts`
**Commit:** f7433ec19f5
**Applied fix:** Added `NAMED_EXTENDED_COLUMNS` set enumerating all dedicated columns in the `metrics_history` table. In both the raw data and aggregation query paths, uses `COALESCE(JSON_EXTRACT(metrics_data, '$.col'), col_name)` when a dynamic metric ID corresponds to a named column. This bridges the gap between `recordMetrics()` storing values in named columns and `getHistoricalMetricsWithRange()` reading from `metrics_data` JSON.

### WR-03: Race Condition in MetricRegistry Refresh

**Files modified:** `apps/db-ops-api/src/metric-registry.ts`
**Commit:** 0c9066ad5e4
**Applied fix:** Replaced `this.definitions.clear()` followed by `await this.initialize()` with an atomic swap pattern. Saves the old definitions map, swaps to a new empty map, calls `initialize()` to populate it, and restores the old map on failure. This ensures concurrent readers always see a consistent (either new or old) registry state.

### WR-04: LIMIT Value Interpolated into SQL String

**Files modified:** `apps/db-ops-api/src/metrics-database-service.ts`
**Commit:** 5df015181b1
**Applied fix:** Changed `LIMIT ${Number(limit)}` to `LIMIT ?` with `[instanceId, limit]` as the parameter array, matching the parameterized style used elsewhere in the file (e.g., `getFaultDiagnoses` at line 645).

### WR-05: Fire-and-Forget Metric Registry Load Swallows Errors

**Files modified:** `frontend/src/app/ui/views/instance-detail.ts`
**Commit:** e6e75632617
**Applied fix:** Replaced the empty `.catch(() => {})` handler with a `console.warn()` call that logs the error message. The original intent (not crashing metrics display on registry failure) is preserved while making failures visible in developer tools for diagnosis.

---

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-05-27T02:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
