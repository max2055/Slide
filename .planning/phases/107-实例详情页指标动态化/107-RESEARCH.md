# Phase 107: 实例详情页指标动态化 - Research

**Researched:** 2026-05-27
**Domain:** Frontend+ backend dynamic metric card rendering, JSON column query, category-grouped UI
**Confidence:** HIGH

## Summary

Phase 107 replaces the 4 hardcoded metric cards (CPU, memory, disk, connections) in `instance-detail.ts` with dynamic rendering driven by `metric_definitions`. Phase 106 already provides all the infrastructure: the `metric_definitions` table (with `category`, `is_collected`, `db_types`, `threshold_template`, `unit`), the `metrics_data` JSON column in `metrics_history`, the `/api/metrics/registry` API returning all definitions, the `loadMetricRegistry()` helper on the frontend, and the `GET /api/database/instances/:id/metrics/history` route with an unused `metricIds` query parameter.

The two changes needed are: (1) backend — make `getHistoricalMetricsWithRange()` accept a `metricIds` parameter and JSON_EXTRACT dynamic metrics from `metrics_data`, and (2) frontend — replace hardcoded card/sparkline/trend rendering with a loop over the `_filteredRegistry` filtered to `is_collected=true`, grouped by `category`.

**Primary recommendation:** Add `metricIds` parameter to backend history endpoint with JSON_EXTRACT fallback; on frontend, replace `_renderMetrics()` and `_renderTrend()` with data-driven loops over `this._filteredRegistry` filtered by `is_collected=true`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Metric history retrieval with metric filtering | API/Backend | Database/Storage | Backend queries metrics_history with JSON_EXTRACT for dynamic metrics, returns only requested metric IDs |
| Dynamic metric card rendering | Browser/Client | -- | Frontend iterates over metric_definitions from registry, renders cards using existing _renderStatBox() and _renderSparkline() |
| Category grouping of metric cards | Browser/Client | -- | Frontend groups metric card sections by metric_definitions.category field |
| Empty state for metrics with no data | Browser/Client | -- | Frontend shows "暂无数据" placeholder when specific metric has no value in metrics_data or fixed columns |
| Trend chart rendering | Browser/Client | -- | Frontend dynamically creates <metric-chart> components for each metric with data, passes thresholds from registry |

## User Constraints (from CONTEXT.md)

> No CONTEXT.md exists for Phase 107. The directory was empty. Research is based on the ROADMAND, Phase 106 artifacts, and codebase analysis.

## Standard Stack

### Core -- No new packages needed

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Existing: Lit 3.3 | (root project) | Frontend web components | Already used throughout instance-detail.ts |
| Existing: mysql2 | (root project) | MySQL queries with JSON_EXTRACT | Already used in metrics-database-service.ts |
| Existing: ECharts via <metric-chart> | (root project) | Charts and sparklines | Already used in instance-detail.ts |

No new dependencies needed. Phase 106 already installed `node-sql-parser`. This phase uses existing infrastructure.

**Installation:** None required.

## Package Legitimacy Audit

> Skip — no external packages are installed in Phase 107. All work uses existing code.

## Architecture Patterns

### System Architecture Diagram

```
metric_definitions table (Phase 106)
  │
  │ (/api/metrics/registry) GET all definitions
  ▼
Frontend loadMetricRegistry() → this.metricRegistry
  │
  │ filter by db_type, is_collected=true
  ▼
this._filteredRegistry (is_collected, matches db_type)
  │
  ├──▶ _renderMetrics() dynamic loop
  │      ├── metric-card per metric
  │      │     ├── value from this.metrics[metric.id] || this.metrics.metrics_data[metric.id]
  │      │     ├── unit from registry definition
  │      │     ├── color from threshold_template comparison
  │      │     ├── sparkline from metricsHistory
  │      │     └── progress-bar (percentage metrics only)
  │      └── grouped by category (e.g., "性能", "容量", "连接")
  │
  ├──▶ _renderOverview() compact sparklines
  │      └── first N metrics as mini <metric-chart> from overviewHistory
  │
  └──▶ _renderTrend() dynamic charts
         ├── metricId filter on history endpoint
         ├── <metric-chart> per metric (or grouped)
         ├── thresholds from _buildThresholds()
         └── empty-state per chart if no data

GET /api/database/instances/:id/metrics/history?period=X&interval=Y&metrics=cpu_usage,memory_usage,custom_metric
  │
  ▼
getHistoricalMetricsWithRange(instanceId, period, interval, metricIds?)
  │
  ├── If metricIds provided:
  │     ├── fixed columns: SELECT cpu_usage, memory_usage, ... for matching IDs
  │     └── dynamic metrics: JSON_EXTRACT(metrics_data, '$.metricId') as metricId
  ├── If metricIds not provided (backward compat): return all 11 fixed columns
  └── Returns { time: string[], metrics: Record<string, number[]> }
```

### Recommended Project Structure

No new files needed. Modifications to existing files:

```
apps/db-ops-api/src/metrics-database-service.ts  -- MODIFY: getHistoricalMetricsWithRange add metricIds param + JSON_EXTRACT
apps/db-ops-api/server.ts                         -- Already passes metricIds to backend (minor fix for 4th arg)
frontend/src/app/ui/views/instance-detail.ts      -- MODIFY: dynamic _renderMetrics(), _renderTrend(), state, loadTabData(), loadTrendData(), updateMetricsHistory()
```

### Pattern 1: Filter-based History Query with JSON Column Fallback

**What:** `getHistoricalMetricsWithRange()` accepts an optional `metricIds` array. When provided, it filters fixed columns by a whitelist of known metric IDs and uses `JSON_EXTRACT` for dynamic metric IDs. When not provided (backward compat), returns all 11 hardcoded keys.

**When to use:** Every call to the history endpoint should pass `metricIds` to reduce payload size. The no-`metricIds` path is for Phase 107->108 backward compat only and can be deprecated.

```typescript
// Source: Codebase analysis + standard MySQL JSON_EXTRACT pattern
// apps/db-ops-api/src/metrics-database-service.ts

async getHistoricalMetricsWithRange(
  instanceId: number,
  period: '1h' | '6h' | '24h' | '7d',
  interval: '1m' | '5m' | '15m' | '1h',
  metricIds?: string[]
): Promise<{ time: string[]; metrics: Record<string, number[]> }> {
  // ... (existing period/interval logic unchanged)

  // Determine which columns to query
  if (metricIds && metricIds.length > 0) {
    // Fixed columns: metrics that are columns in metrics_history
    const fixedCols = metricIds.filter(id => FIXED_COLUMNS.includes(id));
    // Dynamic metrics: stored in metrics_data JSON column
    const dynamicCols = metricIds.filter(id => !FIXED_COLUMNS.includes(id));

    // Build SELECT: fixed columns + JSON_EXTRACT for dynamic
    const selectParts = [
      ...fixedCols.map(c => `AVG(${c}) as ${c}`),
      ...dynamicCols.map(c => `AVG(JSON_EXTRACT(metrics_data, '$.${c}')) as \`${c}\``),
    ];

    // Rest of query uses selectParts.join(', ')
  }
  // ... backward compat path unchanged
}
```

### Pattern 2: Data-Driven Metric Card Rendering

**What:** Iterate over `_filteredRegistry`, filter for `is_collected=true`, group by `category`, render a section per category with metric cards.

**When to use:** Replace all 4 hardcoded `.metric-card.cpu/.memory/.disk/.connections` blocks.

```typescript
// Source: Existing _renderStatBox, _renderSparkline, _renderMetrics patterns
// frontend/src/app/ui/views/instance-detail.ts

private _renderDynamicMetrics() {
  if (!this.metrics) return this._renderNoData();

  const collectedMetrics = this._filteredRegistry.filter(d => d.is_collected);
  // Group by category
  const groups = new Map<string, typeof collectedMetrics>();
  for (const def of collectedMetrics) {
    const cat = def.category || '通用';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(def);
  }

  return html`
    ${Array.from(groups.entries()).map(([category, defs]) => html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">${icons['bar-chart']} ${category}</span>
        </div>
        <div class="card-body">
          <div class="metrics-dashboard">
            ${defs.map(def => this._renderDynamicCard(def))}
          </div>
        </div>
      </div>
    `)}
  `;
}

private _renderDynamicCard(def: MetricDef) {
  // Get value from fixed column or metrics_data JSON
  const value = this.metrics[def.id] ?? this.metrics.metrics_data?.[def.id];
  if (value == null) {
    // Empty state for this specific metric
    return html`
      <div class="metric-card" style="opacity:0.5;">
        <div class="metric-header">
          <span class="metric-label">${def.name}</span>
        </div>
        <div class="metric-value-row">
          <span class="metric-value" style="color:var(--muted);font-size:16px;">暂无数据</span>
        </div>
      </div>
    `;
  }

  const val = Number(value);
  const def2 = this._filteredRegistry.find(d => d.id === def.id);
  const color = this._getMetricColor(val, def2?.threshold_template);
  const sparkline = this.metricsHistory[def.id] || [];
  const isPercent = def.unit === '%';

  return html`
    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-label">${def.name}</span>
      </div>
      <div class="metric-value-row">
        <span class="metric-value" style="color: ${color};">${val.toFixed(1)}</span>
        <span class="metric-unit">${def.unit}</span>
      </div>
      ${sparkline.length >= 2 ? this._renderSparkline(sparkline, color) : ''}
      ${isPercent ? html`
        <div class="progress-bar">
          <div class="progress-fill ${this._getProgressClass(val, def2?.threshold_template)}" style="width: ${Math.min(val, 100)}%"></div>
        </div>
      ` : ''}
    </div>
  `;
}
```

### Anti-Patterns to Avoid

- **Hardcoded metric keys in state:** `metricsHistory` and `trendData` currently use hardcoded keys like `{cpu, memory, qps, connections}`. These must become `Record<string, number[]>` so any metric ID can store history data.
- **Overwriting the entire trendData on load:** When `loadTrendData` filters specific metrics, it should merge rather than replace, or the API should return exactly the requested metrics.
- **Blocking on registry load:** `loadMetricRegistry()` is already non-blocking (`.catch(() => {})`). Keep it that way. If registry fails, show existing cards or empty sections.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Querying dynamic metric data from JSON column | Fetch all rows, parse JSON in code | `JSON_EXTRACT(metrics_data, '$.key')` in SQL | JSON_EXTRACT is optimized at DB level; parsing in Node is slower and prone to null errors |
| Metric color/threshold evaluation | Duplicate the color logic per card | Reuse existing `_buildThresholds()` + `_getMetricColor()` helpers | Already working in instance-detail.ts |
| Sparkline rendering | Draw canvas SVG manually | Existing `<metric-chart compact>` component | Already wired and working for QPS/connections overview history |
| Metric value display per type | Separate gauge/counter/histogram rendering | Single value display + unit suffix | All metrics show a scalar number + unit string |

**Key insight:** Nearly everything needed already exists. The work is primarily restructuring existing patterns into a loop over registry data.

## Common Pitfalls

### Pitfall 1: Backward Compat Break in History API
**What goes wrong:** The frontend `_renderMetrics()` and `_renderTrend()` both parse the API response hardcoded keys (`data.metrics?.cpu_usage`). If the `metricIds`-based response removes keys that existing code expects, rendering breaks.
**How to avoid:** When `metricIds` is not provided, return all 11 columns. Only filter when `metricIds` is provided. The overview tab (which uses `overviewHistory`) should always pass `metricIds` for its specific subset.
**Warning signs:** CPU/memory/disk cards disappear when overview tab loads.

### Pitfall 2: Non-Scrollable Overflow with Many Metrics
**What goes wrong:** If a db_type has 20+ collected metrics, the `.metrics-dashboard` grid (`grid-template-columns: repeat(4, 1fr)`) wraps and may overflow the card container.
**How to avoid:** Keep the 4-column grid. Cards wrap naturally within it. Ensure the `.card-body` handles vertical overflow by letting the layout flow normally.
**Warning signs:** Cards overflow the card boundary or get clipped.

### Pitfall 3: metrics_data Column is NULL (New Instances)
**What goes wrong:** A newly created instance has metrics_history rows but `metrics_data IS NULL`. Accessing `metrics_data.$.custom_metric` returns NULL, and the frontend shows "暂无数据" for all custom metrics.
**How to avoid:** `JSON_EXTRACT` returns NULL for missing keys by default. The frontend must handle `null` metric values gracefully by showing an empty state per card, not for the entire metrics section.
**Warning signs:** Whole metrics section is empty instead of individual cards showing "暂无数据".

### Pitfall 4: metricIds of Different Sizes per Request
**What goes wrong:** Frontend passes `metrics=cpu_usage,memory_usage` to history endpoint, receives back `{ time: [...], metrics: { cpu_usage: [...], memory_usage: [...] } }`. The existing `loadTrendData` expects `data.metrics?.cpu_usage` etc. If the requested metrics change between calls, results must be mapped dynamically.
**How to avoid:** In `loadTrendData`, store `trendData` as `{ time: string[]; metrics: Record<string, number[]> }` and reference dynamically: `this.trendData.metrics[def.id]` instead of `this.trendData.cpu`.
**Warning signs:** Trend chart stays blank when switching between metric categories.

### Pitfall 5: Sparkline History stored per-metric
**What goes wrong:** `updateMetricsHistory()` currently reads exactly 4 fields from newMetrics: `cpu_usage`, `memory_usage`, `qps`, `connections`. A dynamic approach must store sparkline data for ALL collected metrics.
**How to avoid:** Change `metricsHistory` type from `{ cpu: number[]; memory: number[]; qps: number[]; connections: number[] }` to `Record<string, number[]>`. In `updateMetricsHistory()`, iterate over `_filteredRegistry` and push values for each metric ID from `newMetrics` or `newMetrics.metrics_data`.
**Warning signs:** Sparklines are only shown for the original 4 hardcoded metrics.

## Runtime State Inventory

> This section applies because Phase 107 modifies the data model of `getHistoricalMetricsWithRange()` and changes which data is returned to the frontend.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `metrics_history` rows with `metrics_data` JSON column — existing data already has this column from Phase 106 | None — just needs JSON_EXTRACT in queries |
| Stored data | `metrics_history` rows with fixed columns — existing data (cpu_usage, etc.) | Backward compat path unchanged |
| Live service config | The history API route at `server.ts:1087` already passes `metricIds` as 4th arg to `getHistoricalMetricsWithRange()` | Fix function signature to accept 4th param (currently takes 3 params) |
| OS-registered state | None — this is an in-process API change | None |
| Secrets/env vars | None — no new credentials | None |
| Build artifacts | None — no build-time changes | None |

**Nothing found requiring migration:** All changes are backward compatible. The `metricIds` param is additive (default: undefined falls back to all fixed columns).

## Code Examples

### Example 1: Backend -- getHistoricalMetricsWithRange with metricIds (aggregated path)

```typescript
// Source: Codebase analysis + standard MySQL JSON_EXTRACT pattern
// apps/db-ops-api/src/metrics-database-service.ts (aggregated path)

// Known fixed columns in metrics_history (from INSERT at line 135-142)
const FIXED_COLUMNS = [
  'cpu_usage', 'memory_usage', 'disk_usage', 'connections',
  'qps', 'tps', 'active_transactions', 'slow_queries',
  'buffer_pool_hit_rate', 'threads_running', 'threads_connected',
  'bytes_received', 'bytes_sent', 'queries_total', 'commits_total',
  'rollbacks_total'
];

// In getHistoricalMetricsWithRange, after existing period/interval logic:
const activeMetricIds = metricIds || [
  'cpu_usage', 'memory_usage', 'disk_usage', 'connections',
  'qps', 'tps', 'active_transactions', 'slow_queries',
  'buffer_pool_hit_rate', 'threads_running', 'threads_connected',
];

// Split into fixed columns vs dynamic (JSON) columns
const fixed = activeMetricIds.filter(id => FIXED_COLUMNS.includes(id));
const dynamic = activeMetricIds.filter(id => !FIXED_COLUMNS.includes(id));

// Build SELECT clause
const selectParts: string[] = [];

if (interval === '1m') {
  // Non-aggregated: direct column names
  fixed.forEach(c => selectParts.push(c));
  dynamic.forEach(c =>
    selectParts.push(`JSON_EXTRACT(metrics_data, '$.${c}') as \`${c}\``)
  );
} else {
  // Aggregated: AVG() for fixed, AVG(JSON_EXTRACT(...)) for dynamic
  fixed.forEach(c => selectParts.push(`AVG(${c}) as ${c}`));
  dynamic.forEach(c =>
    selectParts.push(`AVG(JSON_EXTRACT(metrics_data, '$.${c}')) as \`${c}\``)
  );
}

// For interval='1m' path:
let sql = `SELECT recorded_at, ${selectParts.join(', ')}
           FROM metrics_history WHERE instance_id = ? AND recorded_at BETWEEN ? AND ?
           ORDER BY recorded_at ASC LIMIT 1000`;

// For aggregated path:
const dateFormat = intervalMap[interval] || '%Y-%m-%d %H:%i:00';
const avgCols = selectParts.join(', ');
sql = `SELECT DATE_FORMAT(recorded_at, '${dateFormat}') as time_str, ${avgCols}
       FROM metrics_history WHERE instance_id = ? AND recorded_at BETWEEN ? AND ?
       GROUP BY DATE_FORMAT(recorded_at, '${dateFormat}')
       ORDER BY time_str ASC`;
```

### Example 2: Frontend -- Dynamic state type changes

```typescript
// Source: instance-detail.ts current state pattern — just making it dynamic

// CHANGE: trendData from hardcoded keys to dynamic
// BEFORE:
@state() private trendData: { time: string[]; cpu: number[]; memory: number[]; connections: number[]; slowQueries: number[] } | null = null;

// AFTER:
@state() private trendData: { time: string[]; metrics: Record<string, number[]> } | null = null;

// CHANGE: metricsHistory from hardcoded keys to dynamic
// BEFORE:
@state() private metricsHistory: { cpu: number[]; memory: number[]; qps: number[]; connections: number[] } = { cpu: [], memory: [], qps: [], connections: [] };

// AFTER:
@state() private metricsHistory: Record<string, number[]> = {};

// CHANGE: loadTrendData to use dynamic metric list
// BEFORE: hardcoded `data.metrics?.cpu_usage` etc.
private async loadTrendData(period: string) {
  this.trendLoading = true;
  this.trendTab = period;
  try {
    // Build metricIds from filtered registry
    const collected = this._filteredRegistry.filter(d => d.is_collected);
    const metricIds = collected.map(d => d.id).join(',');
    const res = await authFetch(
      `/api/database/instances/${this.instanceId}/metrics/history?period=${period}&interval=5m&metrics=${metricIds}`
    );
    if (res.ok) {
      const data = await res.json();
      this.trendData = { time: data.time || [], metrics: data.metrics || {} };
      this.trendLoaded = true;
    }
  } catch (e) {
    console.error("Failed to load trend data:", e);
  }
  this.trendLoading = false;
}

// CHANGE: updateMetricsHistory to handle dynamic metrics
private updateMetricsHistory(newMetrics: any) {
  const MAX_HISTORY = 20;
  for (const def of this._filteredRegistry.filter(d => d.is_collected)) {
    const value = newMetrics[def.id] ?? newMetrics.metrics_data?.[def.id];
    if (value != null) {
      if (!this.metricsHistory[def.id]) this.metricsHistory[def.id] = [];
      this.metricsHistory[def.id] = [
        ...this.metricsHistory[def.id].slice(-(MAX_HISTORY - 1)),
        Number(value),
      ];
    }
  }
}
```

### Example 3: Frontend -- Dynamic trend chart rendering

```typescript
// Source: Existing _renderTrend() pattern, made dynamic

private _renderDynamicTrend() {
  const periods = [
    { key: "1h", label: "1小时" },
    { key: "6h", label: "6小时" },
    { key: "24h", label: "24小时" },
    { key: "7d", label: "7天" },
  ];

  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title">${icons['trending-up']} 指标趋势</span>
        <div style="display: flex; gap: var(--space-xs);">
          ${periods.map(p => html`
            <button class="trend-period-btn ${this.trendTab === p.key ? 'active' : ''}"
              @click=${() => this.loadTrendData(p.key)}
              ?disabled=${this.trendLoading}>${p.label}</button>
          `)}
        </div>
      </div>
      <div class="card-body">
        ${this.trendLoading
          ? html`<div class="loading loading-pulse">加载趋势数据...</div>`
          : !this.trendData || this.trendData.time.length === 0
            ? html`<div class="empty-state">...</div>`
            : html`
                ${this._filteredRegistry
                  .filter(d => d.is_collected && this.trendData!.metrics[d.id]?.length > 0)
                  .map(def => {
                    const data = this.trendData!.metrics[def.id];
                    if (!data || data.length === 0) return html`
                      <div class="card" style="margin-bottom: var(--space-md);">
                        <div class="card-body" style="text-align:center;padding:20px;color:var(--muted);">
                          <div class="empty-title">${def.name} — 暂无趋势数据</div>
                        </div>
                      </div>`;
                    return html`
                      <div style="margin-bottom: 16px;">
                        <metric-chart
                          title="${def.name} (${def.unit})"
                          .timeData=${this.trendData!.time}
                          .series=${[{ name: def.name, data, color: this._getChartColor(def.id) }]}
                          .thresholds=${this._buildThresholds(def.id)}
                          percentage=${def.unit === '%'}
                          height="280px"
                          yAxisLabel=${def.unit}
                        ></metric-chart>
                      </div>
                    `;
                  })}
              `}
      </div>
    </div>
  `;
}

// Color assignment helper (cycle through a palette)
private _getChartColor(metricId: string): string {
  const palette = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  let hash = 0;
  for (let i = 0; i < metricId.length; i++) {
    hash = ((hash << 5) - hash) + metricId.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length];
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| 4 hardcoded metric cards (CPU/memory/disk/connections) | Dynamic cards from metric_definitions loop | Phase 107 | New DB types automatically get relevant cards |
| Hardcoded metricsHistory state `{cpu, memory, qps, connections}` | Dynamic `Record<string, number[]>` | Phase 107 | Custom metrics get sparklines automatically |
| Hardcoded trendData state `{cpu, memory, connections, slowQueries}` | Dynamic `{time, metrics: Record<string, number[]>}` | Phase 107 | Any metric can be charted in trends tab |
| `getHistoricalMetricsWithRange()` 3 params | 4th optional `metricIds` param | Phase 107 | Frontend passes exact metrics needed, reduces payload |
| history endpoint returns all fixed columns | Returns only requested metricIds + JSON_EXTRACT dynamic | Phase 107 | Smaller payload, supports custom metrics |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | All existing 11 hardcoded metricKeys in `getHistoricalMetricsWithRange` are fixed columns in `metrics_history` | Backend | Verified from schema.sql — they are all fixed columns. Low risk. |
| A2 | Dynamic metrics (from CustomSQLProvider) are stored as keys in `metrics_data` JSON column | Backend | Confirmed from Phase 106 D-05 and code at metrics-database-service.ts:180. Low risk. |
| A3 | The frontend `_filteredRegistry` already filters by `db_type` and includes `is_collected` | Frontend | Confirmed from code at instance-detail.ts:1170-1175. The registry object has all fields. VERIFIED. |
| A4 | `metricRegistry` on the frontend `MetricDefinition` interface does not include `category` | Frontend | Confirmed from instance-detail.ts:959-966 — no `category` field. Need to add it. MEDIUM risk. |

## Open Questions (RESOLVED)

1. **How to handle overview tab sparkline history?**
   - The overview tab currently renders 2 compact sparklines (QPS, connections). After dynamic cards, these should show the most important/representative metrics. Recommend: render the first N (= 2-4) collected metrics as compact sparklines from overviewHistory, or deprecate the overview sparkline section entirely since the metrics tab already shows full cards with sparklines.

2. **What is the backward compat story for `getHistoricalMetricsWithRange`?**
   - Phase 109+ code (AI agent, agent-core) may still call the old 3-param signature. Solution: make `metricIds` optional (default: the 11 hardcoded keys list). Old callers get all fixed columns. New callers pass specific IDs.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| MySQL | JSON_EXTRACT queries | ✓ | (external) | -- |
| Node.js | Backend runtime | ✓ | >=22.14 | -- |
| Vite | Frontend dev server | ✓ | (existing) | -- |

**Missing dependencies with no fallback:** none

## Validation Architecture

> Skip — Phase 107 has no `getHistoricalMetricsWithRange` test file in existing test infrastructure. No new packages added.

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | `metricIds` alphanumeric validation at server.ts:1104-1106 already implemented |
| V4 Access Control | yes | Existing `instanceAccess('read-only')` on history route + `metric:view` on registry |

No new security surface. The `metricIds` parameter is sanitized by the existing regex whitelist (`/^[a-zA-Z0-9_-]+$/`) before reaching the query. `JSON_EXTRACT` is MySQL built-in, not user-evaluated.

## Sources

### Primary (HIGH confidence)
- [VERIFIED: codebase] `apps/db-ops-api/src/metrics-database-service.ts` — Full file: current getHistoricalMetricsWithRange at line 294 with 3 params, 11 hardcoded metricKeys
- [VERIFIED: codebase] `apps/db-ops-api/server.ts` — History route at line 1087, already passes metricIds as 4th arg (mismatch with 3-param function)
- [VERIFIED: codebase] `frontend/src/app/ui/views/instance-detail.ts` — Full file: state at line 947/951, registry at 959, helpers at 1170-1249, hardcoded rendering at 1806-1934, trends at 1936-2018
- [VERIFIED: codebase] `apps/db-ops-api/src/metric-database-service.ts` — MetricDefinitionRow interface, getMetricsByDbType at line 86
- [VERIFIED: codebase] `apps/db-ops-api/src/metric-registry.ts` — MetricRegistry class with getByDbType, getById, getAll
- [VERIFIED: codebase] `.planning/phases/106-*/106-*-SUMMARY.md` — Phase 106 implementation artifacts

### Secondary (MEDIUM confidence)
- [VERIFIED: codebase] `frontend/src/app/ui/views/metric-registry.ts` — MetricDefinition interface with category, value_type fields

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — No new dependencies. All patterns exist.
- Architecture: HIGH — Dynamic rendering from registry is well-supported by existing code.
- Pitfalls: HIGH — All pitfalls are concrete edge cases observable from codebase analysis.

**Research date:** 2026-05-27
**Valid until:** Phase 107 is backward-compatible by design. Valid indefinitely for architecture, but implementation must verify exact line numbers.
