---
phase: 107-instance-detail-dynamic-metrics
reviewed: 2026-05-27T01:00:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - apps/db-ops-api/src/metric-registry.ts
  - apps/db-ops-api/src/metrics-database-service.ts
  - frontend/src/app/ui/views/instance-detail.ts
findings:
  critical: 2
  warning: 5
  info: 4
  total: 11
status: issues_found
---

# Phase 107: Code Review Report — Instance Detail Page Dynamic Metrics

**Reviewed:** 2026-05-27T01:00:00Z
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Three source files implementing dynamic instance detail metrics were reviewed: `metric-registry.ts` (metric definition registry), `metrics-database-service.ts` (multi-function metrics database CRUD), and `instance-detail.ts` (large frontend Lit component). Two critical issues were identified: a SQL injection vector from unparameterized column names in dynamic metric queries, and inverted threshold coloring for metrics where "lower is worse" (buffer pool hit rate, cache hit ratio, health score, etc.). Additional warnings include broken 5m/15m aggregation bucketing, data fracture between named columns and JSON storage, a race condition in registry refresh, and fire-and-forget error swallowing on the frontend.

---

## Critical Issues

### CR-01: SQL Injection via Unparameterized Dynamic Column Names

**File:** `apps/db-ops-api/src/metrics-database-service.ts:332,362`
**Issue:** The `getHistoricalMetricsWithRange()` method interpolates dynamic metric IDs directly into SQL column names without parameterization. On line 332:

```typescript
selectParts.push(`JSON_EXTRACT(metrics_data, '$.${c}') as \`${c}\``);
```

The variable `c` comes from `dynamicCols`, which is derived from the `metricIds` parameter — an externally-supplied API input. A crafted metric ID can inject arbitrary SQL into the query. The same pattern appears on line 362 for the aggregated query path.

While the frontend sends sanitized IDs from its own registry, a direct API call to the backend endpoint (e.g., `/api/database/instances/:id/metrics/history?metrics=malicious_id`) with crafted `metrics` parameter values can exploit this.

**Fix:** Validate metric IDs against a whitelist of allowed column references, or use a lookup table to map metric IDs to safe column expressions. At minimum, reject any metric ID that contains characters outside `[a-zA-Z0-9_]`:

```typescript
// Before interpolation, validate each metric ID
const SAFE_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const dynamicCols = activeMetricIds.filter(
  id => !FIXED_COLUMNS.includes(id as any) && SAFE_ID_RE.test(id)
);
```

### CR-02: Inverted Threshold Coloring for "Lower Is Worse" Metrics

**File:** `frontend/src/app/ui/views/instance-detail.ts:1287-1327`
**Issue:** Both `_getMetricColor()` and `_getProgressClass()` use `value >= threshold` unconditionally, assuming that all metrics follow the "higher is worse" direction. This produces inverted visual results for metrics where "lower is worse" (buffer_pool_hit_rate, cache_hit_ratio, sga_hit_rate, health_score, idx_scan_ratio).

For example, `buffer_pool_hit_rate` has threshold `{ warning: 95, error: 90, critical: 80 }`:
- A healthy 97% hit rate: `97 >= 80` is `true` → shows as **destructive/critical** (WRONG)
- A terrible 70% hit rate: `70 >= 80` is `false`, `70 >= 90` is `false`, `70 >= 95` is `false` → shows as **good** (WRONG)

Metrics affected:
- `buffer_pool_hit_rate` — higher is better
- `table_open_cache_hit_rate` — higher is better
- `cache_hit_ratio` — higher is better
- `sga_hit_rate` — higher is better
- `health_score` — higher is better
- `idx_scan_ratio` — higher is better

**Fix:** The direction (higher-is-worse vs lower-is-worse) must be known per metric. Add a `higher_is_worse` field to `MetricDefinition` or use the `value_type` field to determine direction. Then use `<=` instead of `>=` when `higher_is_worse` is `false`:

```typescript
private _getMetricColor(value: number, metricDef?: MetricDefinition): string {
  if (!metricDef?.threshold_template) {
    return value > 80 ? 'var(--destructive)' : value > 60 ? 'var(--warn)' : 'var(--text-strong)';
  }
  const tpl = metricDef.threshold_template;
  const higherIsWorse = metricDef.higher_is_worse ?? true; // default true for backward compat
  const cmp = higherIsWorse
    ? (v: number, t: number) => v >= t
    : (v: number, t: number) => v <= t;
  if (tpl.critical != null) {
    const cv = this._parseThresholdValue(tpl.critical);
    if (cv !== null && cmp(value, cv)) return 'var(--destructive)';
  }
  if (tpl.error != null) {
    const ev = this._parseThresholdValue(tpl.error);
    if (ev !== null && cmp(value, ev)) return 'var(--destructive)';
  }
  if (tpl.warning != null) {
    const wv = this._parseThresholdValue(tpl.warning);
    if (wv !== null && cmp(value, wv)) return 'var(--warn)';
  }
  return 'var(--text-strong)';
}
```

---

## Warnings

### WR-01: Broken 5m / 15m Aggregation Bucketing

**File:** `apps/db-ops-api/src/metrics-database-service.ts:319-326`
**Issue:** The date format strings for `1m`, `5m`, and `15m` intervals are identical (`%Y-%m-%d %H:%i:00`). This means `5m` and `15m` intervals produce per-minute GROUP BY buckets instead of proper 5-minute or 15-minute buckets, rendering the aggregation meaningless. The data volume is 5x (or 15x) larger than intended.

**Fix:** Use a floor-based expression for 5m and 15m bucketing. For example using UNIX_TIMESTAMP arithmetic:

```typescript
const intervalMap: Record<string, string> = {
  '1m': '%Y-%m-%d %H:%i:00',
  '5m': '', // handled by floor expression below
  '15m': '', // handled by floor expression below
  '1h': '%Y-%m-%d %H:00:00',
};

// For 5m/15m, use FROM_UNIXTIME floor
if (interval === '5m') {
  sql = `
    SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / 300) * 300) as time_str,
           ${selectParts.join(', ')}
    FROM metrics_history
    WHERE ... GROUP BY time_str ORDER BY time_str
  `;
} else if (interval === '15m') {
  sql = `
    SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / 900) * 900) as time_str,
           ${selectParts.join(', ')}
    FROM metrics_history
    WHERE ... GROUP BY time_str ORDER BY time_str
  `;
}
```

### WR-02: Data Fracture Between Named Columns and metrics_data JSON

**File:** `apps/db-ops-api/src/metrics-database-service.ts:90-188,294-390`
**Issue:** Extended metrics (e.g., `table_open_cache_hit_rate`, `handler_read_rnd_next`, etc.) have dedicated named columns in the `metrics_history` table AND can also be stored in the `metrics_data` JSON column. The `recordMetrics()` function (line 90) stores individual metrics in dedicated columns, while `getHistoricalMetricsWithRange()` (line 331-332) only reads dynamic metrics from `JSON_EXTRACT(metrics_data, ...)` and never from the dedicated columns.

If a metric collector passes `table_open_cache_hit_rate` as a named parameter to `recordMetrics()`, it goes into the dedicated column. But `getHistoricalMetricsWithRange()` looks for it via `JSON_EXTRACT(metrics_data, '$.table_open_cache_hit_rate')` — which returns `NULL`. The metric silently disappears from historical queries.

**Fix:** Two options:
1. In `recordMetrics()`, always write extended metrics to BOTH the named column and `metrics_data` JSON (single source of truth), OR
2. In `getHistoricalMetricsWithRange()`, for each dynamic metric, use `COALESCE(JSON_EXTRACT(metrics_data, '$.col'), col)` to read from either location.

### WR-03: Race Condition in MetricRegistry Refresh

**File:** `apps/db-ops-api/src/metric-registry.ts:97-99`
**Issue:** `refreshFromDB()` calls `this.definitions.clear()` before `await this.initialize()`, creating a time window where the registry is empty. If any code reads the registry between these two operations (e.g., a concurrent `getById()` or `getAll()` call during the `await`), it will see an empty definitions map.

```typescript
async refreshFromDB(): Promise<void> {
    this.definitions.clear();
    await this.initialize(); // definitions is empty during this await
}
```

**Fix:** Build the new state in a temporary map, then atomically swap:

```typescript
async refreshFromDB(): Promise<void> {
    // Build new state independently
    const newDefs = new Map<string, MetricDefinition>();
    const oldDefs = this.definitions;
    this.definitions = newDefs; // point to temp map
    try {
      await this.initialize(); // this populates this.definitions
    } catch {
      this.definitions = oldDefs; // restore on failure
    }
}
```

This requires `initialize()` to operate on `this.definitions`, so it would need a small refactor to populate a given map.

### WR-04: LIMIT Value Interpolated into SQL String

**File:** `apps/db-ops-api/src/metrics-database-service.ts:539`
**Issue:** `getSlowQueries()` uses string interpolation for the LIMIT clause (`LIMIT ${Number(limit)}`) instead of a parameterized placeholder. While `Number()` provides some safety, it is inconsistent with the parameterized `?` pattern used everywhere else in the file (compare line 617 which uses `LIMIT ? OFFSET ?` correctly).

```typescript
`... LIMIT ${Number(limit)}`,
[instanceId]
```

**Fix:** Use a parameterized placeholder consistently:

```typescript
`... LIMIT ?`,
[instanceId, limit]
```

### WR-05: Fire-and-Forget Metric Registry Load Swallows Errors

**File:** `frontend/src/app/ui/views/instance-detail.ts:1082`
**Issue:** `loadMetricRegistry()` is called as a fire-and-forget promise with a silent catch:

```typescript
this.loadMetricRegistry(true).catch(() => {}); // don't fail metrics load on registry error
```

If the registry fails to load, all downstream features silently break: metric tooltips will not render, threshold-based coloring uses fallback logic, category grouping collapses to '通用', and there is no user-facing feedback. The `.catch(() => {})` suppresses all errors.

**Fix:** At minimum, log the failure so it can be diagnosed:

```typescript
this.loadMetricRegistry(true).catch((e) => {
  console.warn('[InstanceDetail] Failed to load metric registry:', e);
});
```

Better yet, surface a subtle indicator to the user (e.g., set a `@state()` flag and show a dismissible banner).

---

## Info

### IN-01: Unreachable Dead Code After Return in `_getPredefinedMetrics()`

**File:** `apps/db-ops-api/src/metric-registry.ts:456-458`
**Issue:** Lines 456-458 follow the return statement (line 454 `];`) and are never executed. The variable `metrics` is not defined in the function scope — would cause a `ReferenceError` if reached. This appears to be a copy-paste remnant from `loadPredefinedMetrics()`.

```typescript
    ];
    // ↓ DEAD CODE — never executes, `metrics` is not defined
    for (const metric of metrics) {
      this.definitions.set(metric.id, metric);
    }
```

Remove lines 456-458.

### IN-02: Predefined Metrics Lack `category` and `value_type` Fields

**File:** `apps/db-ops-api/src/metric-registry.ts:126-453`
**Issue:** None of the ~30 predefined metrics set the `category` field (used for frontend grouping) or `value_type` field. Without category, all metrics group under the default '通用' label. The `MetricDefinition` interface supports these fields but they remain unfilled.

**Fix:** Add appropriate `category` values to each predefined metric (e.g., '性能', '容量', '连接', '缓存') and set `value_type: 'gauge'` explicitly rather than relying on defaults.

### IN-03: `console.log` Debug Artifacts

**File:** `apps/db-ops-api/src/metric-registry.ts:48,50,53,66,73,91`
**Issue:** Multiple `console.log` statements are present in the `initialize()` and `_seedPredefinedToDB()` methods. These output internal details (row counts, seed results) to stdout in production. They should be either removed or converted to `console.debug` / a structured logger.

### IN-04: Unused `isConnected()` Method

**File:** `apps/db-ops-api/src/metric-database-service.ts:83-85`
**Issue:** The `isConnected()` private method is defined but never called within `MetricDatabaseService`. Every operation (e.g., `getPool()`) inlines its own null check instead.

### IN-05: `NaN` Rendering in Metric Cards

**File:** `frontend/src/app/ui/views/instance-detail.ts:1943`
**Issue:** If a metric value cannot be parsed as a number, `Number(value)` produces `NaN`, and `val.toFixed(1)` renders the string `"NaN"` directly to the user in place of the metric value. While unlikely with current data sources, it is an unhandled edge case.

---

_Reviewed: 2026-05-27T01:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
