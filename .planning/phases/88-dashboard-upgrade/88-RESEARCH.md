# Phase 88: Dashboard Upgrade - Research

**Researched:** 2026-05-11
**Domain:** Frontend Dashboard (Lit + ECharts) + Backend Dashboard API endpoints (Fastify)
**Confidence:** HIGH

## Summary

Phase 88 upgrades the Slide DBA dashboard by adding four new capabilities: (1) an ECharts pie chart showing DB type distribution using frontend aggregation from `GET /api/database/instances`, (2) an ECharts line chart with area fill showing total data volume trend via a new backend aggregate endpoint, (3) four health status summary cards (healthy/warning/critical/offline), and (4) a CSS Grid layout reorganization with full CSS variable adoption and responsive breakpoints.

The existing dashboard (`dashboard.ts`, Lit web component) already imports ECharts (5.4.0 bundled via npm) and uses `fetch()` + JWT auth for API calls. The dashboard tab is already registered in the navigation system -- no route or navigation changes needed. Two new backend endpoints need to be added to `server.ts`: a cross-instance capacity trend aggregator and an AI analysis count endpoint. The existing CSS variable system in `base.css` is comprehensive and ready for full adoption.

**Primary recommendation:** Rewrite `dashboard.ts` with the new layout and inline ECharts instances, add two backend endpoints following existing patterns, and fully replace hardcoded colors with CSS variables.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** ECharts pie chart showing DB type distribution by instance count
- **D-02:** Frontend aggregation -- reuse GET /api/database/instances response's db_type field, group and count in browser
- **D-03:** Show all database types (MySQL/PostgreSQL/Oracle/Dameng), do not merge into "Other"
- **D-04:** Hover tooltip shows type name, instance count, percentage; click slice navigates to instances-db page filtered by type
- **D-05:** Preset time buttons (24h / 7d / 30d) + date range picker, default 7 days
- **D-06:** Default aggregated trend line across all instances, dropdown selector switches to single-instance view
- **D-07:** New backend aggregate endpoint (e.g. GET /api/dashboard/capacity-trend?hours=168), aggregates total_size_gb across all active instances by time
- **D-08:** Inline ECharts instance (do NOT reuse `<metric-chart>`), line chart + semi-transparent area fill
- **D-09:** Current total summary above chart: "X.X TB/GB"
- **D-10:** Replace the existing QPS trend chart at the bottom of the current dashboard
- **D-11:** Show empty state when no capacity data: "暂无容量数据，请确保监控采集已启用"
- **D-12:** First row: 4 stat cards -- Total Instances / Total Data Volume / Active Alerts / AI Analysis Count
- **D-13:** Remove connection count and QPS cards (per-instance metrics are meaningless on global dashboard)
- **D-14:** AI Analysis Count includes alert RCA, fault diagnosis, SQL audit, capacity prediction, and all AI-related features
- **D-15:** AI Analysis Count needs a new backend stats endpoint (e.g. GET /api/dashboard/ai-stats), aggregate daily count from the ai_analysis table
- **D-16:** Data Volume card number is sourced from the DASH-02 capacity trend endpoint's current value
- **D-17:** Health summary card style -- large number + status label + status-colored icon, 4 cards for healthy/warning/critical/offline
- **D-18:** Offline instances determined by health check timeout (health_status is null or last_health_check_at exceeds threshold minutes)
- **D-19:** Clicking a health card navigates to instances-db page filtered by that status
- **D-20:** Use CSS variable system for unified visuals (--ok, --warn, --danger, --muted)
- **D-21:** Preserve existing content (quick actions, unhandled alerts panel, instance health list) + add new charts/cards
- **D-22:** Final layout top to bottom: stat cards row -> health status cards row -> charts row (pie left+trend right side by side) -> quick actions row -> dual-panel row
- **D-23:** Three responsive breakpoints (1200px / 768px / 480px), progressive fallback: cards 4->2->1 columns, charts side-by-side->stacked, bottom dual-panel->single-column
- **D-24:** Full CSS variable adoption -- replace ALL hardcoded colors (#e5e5ea, #ffffff, #1a1a1e, #6e6e73 etc.) with existing CSS variables

### Claude's Discretion
- ECharts pie/line chart specific configuration (color scheme, tooltip format, animation)
- Three-stage responsive breakpoint CSS implementation and fallback behavior
- CSS variable mapping details (hardcoded colors -> variable replacement plan)
- Empty/loading/error state specific UI design
- 4 stat cards and 4 health status cards specific visual design (layout, icons, spacing)
- Health check timeout threshold for offline detection (minutes)
- Pie chart slice click URL parameter format (e.g. ?health=critical)
- Data volume card unit formatting logic (GB/TB auto-switch)
- AI analysis count endpoint aggregation logic (daily/by type/by instance)
- Instance filter dropdown UI implementation

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DASH-01 | Dashboard shows DB type distribution as ECharts pie/bar chart (MySQL/PostgreSQL counts and ratios) | `GET /api/database/instances` already returns all active instances with `db_type` field. Frontend aggregation per D-02. ECharts 5.4.0 already bundled. Pie chart is a standard ECharts series type. |
| DASH-02 | Dashboard shows total data volume trend as ECharts line chart (aggregated from capacity_history) | `capacity_history` table has `total_size_gb` per instance per time. `metricsDatabaseService.getCapacityHistory()` exists for per-instance query. New aggregate endpoint needed cross-instance. Inline ECharts per D-08. |
| DASH-03 | Dashboard shows instance health status summary cards (healthy/warning/critical/offline counts) | `GET /api/database/instances` returns `health_status` for all instances. Offline detection needs `last_health_check_at` age check (Claude's discretion on threshold). Frontend aggregation. |
| DASH-04 | Dashboard card layout is reorganized with CSS Grid (stat cards row -> charts row -> instance list) | CSS Grid already used in existing dashboard (`.ov-cards { display: grid }`). CSS variable system fully defined in `base.css`. Current dashboard uses hardcoded colors that must be replaced. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| DB type distribution rendering | Browser / Client | -- | D-02 mandates frontend aggregation from existing API response; no data from backend needed beyond what `/api/database/instances` already provides |
| Data volume trend data | API / Backend | -- | D-07 requires new aggregate backend endpoint; cross-instance aggregation cannot be done efficiently from frontend |
| Data volume trend rendering | Browser / Client | -- | D-08 inline ECharts instance renders on client; data is fetched from backend endpoint |
| Health status summary | Browser / Client | -- | Aggregation from existing `/api/database/instances` response; offline detection uses `last_health_check_at` in existing response data |
| AI analysis counts | API / Backend | -- | D-15 requires new backend endpoint querying `ai_analysis` table; not derivable from existing APIs |
| Stat card data (data volume) | API / Backend | Browser / Client | Total data volume sourced from DASH-02's backend capacity-trend endpoint; displayed in card by frontend |
| CSS Grid layout | Browser / Client | -- | Purely frontend CSS responsibility per D-22/D-23 |
| Pie chart click navigation | Browser / Client | -- | Client-side CustomEvent dispatch (`slide-navigate`) per existing pattern; navigates to instances-db page with filter |
| Health card click navigation | Browser / Client | -- | Same pattern as pie chart; navigates to instances-db with status filter |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Lit | 3.3.2 | Web Components framework | Project standard, all UI built with it [VERIFIED: frontend/package.json] |
| ECharts | 5.4.0 | Charting library | Already bundled, used via `<metric-chart>` and in instance-detail. Pie and line charts are built-in. [VERIFIED: frontend/package.json] |
| Fastify | 4.24.3 | Backend HTTP framework | Project standard for all API endpoints [VERIFIED: apps/db-ops-api/package.json] |
| mysql2 | 3.20.0 | Database driver | All backend services use it [VERIFIED: apps/db-ops-api/package.json] |
| TypeScript | 5.3.2 | Type system | Project standard [VERIFIED: apps/db-ops-api/package.json] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| -- | -- | -- | No additional libraries needed. All capabilities (pie chart, line chart, CSS Grid, stat cards) use existing dependencies. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline ECharts (D-08) | `<metric-chart>` component | D-08 explicitly rejects reusing `<metric-chart>`; inline instance gives full control over pie chart config and trend chart area fill without retrofitting component API |
| Frontend capacity aggregation | New backend endpoint (D-07) | Frontend would need to N+1 fetch all instances' capacity histories; aggregate endpoint is more efficient for cross-instance data |
| Server-side template | Lit Web Components | Project standard is full SPA with Lit; no SSR in the stack |

**Installation:**
No new npm packages needed. ECharts 5.4.0 and Lit 3.3.2 are already in `frontend/package.json`.

## Architecture Patterns

### System Architecture Diagram

```
User Browser
    |
    v
Lit Web Component: <dashboard-page> (dashboard.ts)
    |                                        |
    | (DASH-01, DASH-03)                    | (DASH-02, DASH-12/DASH-15)
    | Frontend aggregation                  | Backend data
    v                                        v
GET /api/database/instances          GET /api/dashboard/capacity-trend?hours=168
    |                                        |
    | returns: db_type,                     | returns: aggregated total_size_gb
    | health_status,                       | time series + current total
    | last_health_check_at                  |
    |                                        v
    v                               GET /api/dashboard/ai-stats
[Browser-side grouping]              [count today's ai_analysis records]
    |                                        |
    v                                        v
Pie chart (DB types)            Line chart (capacity trend)
Health cards (status)           Stat card (data volume)
                                Stat card (AI analysis)
    
    v
slide-navigate CustomEvent -> instances-db page (pie slice / health card clicks)
```

**Data flow for primary use case (dashboard load):**
1. User navigates to `/dashboard` -- router renders `<dashboard-page>`
2. `firstUpdated()` calls `loadDashboardData()`
3. Parallel fetch: `GET /api/database/instances` (existing), `GET /api/alerts` (existing), `GET /api/dashboard/capacity-trend` (new), `GET /api/dashboard/ai-stats` (new)
4. Instances response -> frontend groups by `db_type` -> renders pie chart (DASH-01)
5. Instances response -> frontend counts by `health_status`, checks `last_health_check_at` age -> renders health cards (DASH-03)
6. Capacity-trend response -> renders line chart with area fill + current total in stat card (DASH-02/DASH-12)
7. Alerts response + AI-stats response -> stat cards for alert count and AI analysis count (DASH-12/DASH-15)
8. Clicking pie slice or health card dispatches `slide-navigate` event to navigate to instances-db with filter params

### Recommended Project Structure
```
src/
├── frontend/src/openclaw/ui/views/dashboard.ts   # REWRITE: new layout and charts
├── apps/db-ops-api/server.ts                      # EDIT: add two new routes near capacity routes
└── ...
```

Both changes are in existing files -- no new files needed unless you prefer a `dashboard-service.ts`.

**Alternative (optional):** Create `apps/db-ops-api/src/dashboard-service.ts` for the two new aggregation methods (capacity-trend, ai-stats) to keep `server.ts` cleaner.

### Pattern 1: Fastify Route Registration
**What:** Backend API endpoints are registered by calling `fastify.get()` with optional `preHandler` middleware and a handler function.
**When to use:** For each new backend endpoint needed by the dashboard.
**Example:**
```typescript
// Source: apps/db-ops-api/server.ts existing pattern (per-instance capacity history)
fastify.get('/api/database/instances/:id/capacity/history', async (request, reply) => {
  try {
    const { id } = request.params as any;
    const hours = Number((request.query as any)?.hours) || 168;
    const history = await metricsDatabaseService.getCapacityHistory(Number(id), hours);
    reply.send({ history });
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});
```

### Pattern 2: Lit Web Component Data Loading
**What:** Dashboard uses `@state()` properties, fetches data in `firstUpdated()`, renders conditionally based on loading/error states.
**When to use:** All new frontend data fetching follows this pattern.
**Example:**
```typescript
// Source: dashboard.ts lines 319-397
override firstUpdated() {
  this.loadDashboardData();
}

private async loadDashboardData() {
  try {
    const h = this._headers;
    const [instancesRes, alertsRes] = await Promise.all([
      fetch("/api/database/instances", { headers: h }),
      fetch("/api/alerts", { headers: h }),
    ]);
    // process responses -> assign @state() properties
    this.loading = false;
  } catch (err: any) {
    this.error = err.message;
    this.loading = false;
  }
}
```

### Pattern 3: Inline ECharts Creation
**What:** Create ECharts instance directly in `firstUpdated()` using `echarts.init(containerRef)` with ResizeObserver for responsive resizing.
**When to use:** DASH-02 mandates inline ECharts instance (do NOT reuse `<metric-chart>`).
**Example:**
```typescript
// Source: metric-chart.ts lines 119-167 (reference pattern -- dashboard.ts will adapt for inline use)
private _initChart() {
  this._chart = echarts.init(this._chartContainer, undefined, { renderer: "canvas" });
  this._setupResizeObserver();
  this._updateChart();
}

private _setupResizeObserver() {
  this._resizeObserver = new ResizeObserver(() => {
    if (this._chart) this._chart.resize();
  });
  this._resizeObserver.observe(this._chartContainer);
}
```

### Anti-Patterns to Avoid
- **Reusing `<metric-chart>` for the trend chart:** D-08 explicitly forbids this. Use inline ECharts init/destroy in dashboard.ts.
- **Adding dashboard-specific fields to `GET /api/database/instances`:** D-02 says frontend aggregation. The existing endpoint is sufficient. No API change needed for DASH-01 or DASH-03.
- **Adding new npm dependencies:** ECharts 5.4.0 and Lit 3.3.2 already cover all chart and layout needs.
- **Per-instance capacity fetching in frontend:** D-07 requires a new aggregate backend endpoint. Do not loop all instances from the frontend.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Chart rendering | Custom SVG/Canvas chart | ECharts 5.4.0 (already bundled) | ECharts handles animations, tooltips, responsive resize, legend, color schemes -- all required by D-04, D-08, D-09 |
| Layout | Custom flex-based layout with media queries | CSS Grid (`display: grid; grid-template-columns: repeat(4, 1fr)`) | CSS Grid is already the project pattern (see `.ov-cards`), handles 4->2->1 column responsive fallback via `grid-template-columns` with media queries (D-23) |
| Navigation | Custom URL routing | `slide-navigate` CustomEvent pattern | Project standard, already used in dashboard for "管理实例" / "查看告警" clicks (D-04, D-19) |
| Auth headers | Custom token management | `localStorage.getItem("token")` + `Authorization: Bearer` header | Project standard, already in `_headers` getter in dashboard.ts |
| Icons | Third-party icon library | Existing icons.ts (Lucide-style inline SVG) | All needed icons exist: `database`, `bell`, `barChart`, `check`, `alertTriangle`, `x`, `info`, `checkCircle`, `alertCircle`, `hardDrive`, `trendingUp` |

**Key insight:** Every required capability (pie chart, line chart with area fill, CSS Grid layout, stat cards, health badges, navigation, icons) is already available in the project's existing dependencies. No new packages are needed.

## Common Pitfalls

### Pitfall 1: Capacity History Table Name
**What goes wrong:** D-15 in CONTEXT.md refers to `ai_analysis_cache`, but the actual table is `ai_analysis` (checked in `ai-analysis-database-service.ts`). [CITATION: apps/db-ops-api/src/ai-analysis-database-service.ts -- uses `ai_analysis` table throughout]
**Why it happens:** CONTEXT.md was written from discussion notes, not code audit.
**How to avoid:** Use `ai_analysis` table for the AI stats endpoint. The `aiAnalysisDatabaseService.getAnalysisStats()` method already provides the query pattern.

### Pitfall 2: Offline Detection Logic
**What goes wrong:** Offline instances are those with `health_status` null or `last_health_check_at` too old. However, `getAllInstances()` filters `WHERE status = 'active'`, so instances with `status = 'inactive'` or `status = 'error'` are never returned. The offline count could be wrong if the plan only counts returned instances.
**Why it happens:** The current query excludes instances that might be offline. [CITATION: instance-database-service.ts line 67 `WHERE status = 'active'`]
**How to avoid:** Two options (Claude's discretion): (1) Add a query parameter `include_all=true` to bypass the active filter, or (2) rely on `last_health_check_at` age within the returned active instances -- instances whose health checks have timed out while remaining `status = 'active'` are reasonable candidates for "offline". D-18 says "health_status is null or exceeds threshold", which works within the active-only set.

### Pitfall 3: Hardcoded Colors in Existing Dashboard
**What goes wrong:** The current `dashboard.ts` uses 30+ instances of hardcoded colors (`#e5e5ea`, `#ffffff`, `#1a1a1e`, `#6e6e73`, `#dc2626`, `#15803d`, `#b45309`, `#2563eb`, `#f59e0b`, `#f8f9fa`, `#f1f3f5`) in inline style attributes (`style="..."`) AND in CSS `static styles`.
**Why it happens:** Original dashboard was built before the CSS variable system was fully established.
**How to avoid:** D-24 mandates full CSS variable adoption. Every hardcoded color must be mapped to its CSS variable equivalent. The existing CSS variables in `base.css` cover all semantic colors. Reference `instance-detail.ts` for patterns of CSS variable usage (it uses `var(--card)`, `var(--border)`, `var(--text)`, `var(--accent)`, etc.).

### Pitfall 4: ECharts Instance Lifecycle
**What goes wrong:** ECharts instances must be disposed in `disconnectedCallback()` to prevent memory leaks. The inline ECharts instances in the new dashboard are NOT managed by a pre-built component lifecycle.
**Why it happens:** The `<metric-chart>` component handles dispose automatically. Inline instances require manual lifecycle management.
**How to avoid:** Follow the dispose pattern from `metric-chart.ts` lines 108-117:
```typescript
override disconnectedCallback() {
  super.disconnectedCallback();
  this._resizeObserver?.disconnect();
  this._chart?.dispose();
  this._chart = null;
}
```

### Pitfall 5: CSS Grid Inline Styles vs Shadow DOM Scoped Styles
**What goes wrong:** The current dashboard mixes CSS in `static override styles` with inline `style=""` attributes. This is inconsistent -- inline styles cannot use CSS variables for semantic colors easily (values like `"color: var(--ok)"` work fine but variable fallbacks are harder).
**Why it happens:** Inline styles were used for dynamic values in template literals.
**How to avoid:** Move ALL layout styling to `static override styles` CSS. Use conditional class names (e.g., `class="status-item ${s.class}"`) instead of inline styles for dynamic colors. This aligns with the pattern in `instance-detail.ts`.

### Pitfall 6: NO `ai_analysis_cache` Table Exists
**What goes wrong:** The CONTEXT.md D-15 mentions `ai_analysis_cache`, but this table does not exist in the codebase. [CITED: grep for `ai_analysis_cache` returned no results across entire project]
**Why it happens:** Typo in discussion notes.
**How to avoid:** Use the `ai_analysis` table (not `ai_analysis_cache`) for the AI stats endpoint. Reference `aiAnalysisDatabaseService.getAnalysisStats()` at line 346 of `ai-analysis-database-service.ts` as the query pattern.

## Code Examples

### Backend: New Capacity Trend Aggregate Endpoint
```typescript
// Add to server.ts near existing capacity routes (around line 988)
fastify.get('/api/dashboard/capacity-trend', async (request, reply) => {
  try {
    const hours = Number((request.query as any)?.hours) || 168;
    const pool = dbConnection.getPool();
    if (!pool) return reply.code(500).send({ error: '数据库未连接' });

    // Cross-instance aggregation with 2-hour bucket interval (adjustable via discretionary)
    const [rows] = await pool.execute(
      `SELECT
         DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00') as time_bucket,
         SUM(total_size_gb) as total_size_gb,
         COUNT(DISTINCT instance_id) as instance_count
       FROM capacity_history
       WHERE recorded_at >= NOW() - INTERVAL ? HOUR
       GROUP BY DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00')
       ORDER BY time_bucket ASC`,
      [hours]
    ) as any;

    // Current total from the latest record
    const [current] = await pool.execute(
      `SELECT SUM(total_size_gb) as current_total
       FROM (SELECT instance_id, MAX(recorded_at) as max_time
             FROM capacity_history GROUP BY instance_id) latest
       JOIN capacity_history ch ON ch.instance_id = latest.instance_id
         AND ch.recorded_at = latest.max_time`,
    ) as any;

    reply.send({
      current_total_gb: Number(current[0]?.current_total || 0),
      trend: rows.map((r: any) => ({
        time: r.time_bucket,
        total_size_gb: Number(r.total_size_gb),
        instance_count: r.instance_count,
      })),
    });
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});
```

### Backend: New AI Analysis Count Endpoint
```typescript
// Add to server.ts
fastify.get('/api/dashboard/ai-stats', async (request, reply) => {
  try {
    const pool = dbConnection.getPool();
    if (!pool) return reply.code(500).send({ error: '数据库未连接' });

    const [rows] = await pool.execute(
      `SELECT
         COUNT(*) as total,
         COUNT(DISTINCT instance_id) as instance_count,
         analysis_type,
         COUNT(*) as type_count
       FROM ai_analysis
       WHERE created_at >= CURDATE()
       GROUP BY analysis_type WITH ROLLUP`
    ) as any;

    const total = rows.length > 0
      ? rows.find((r: any) => r.analysis_type === null)?.total || 0
      : 0;

    const breakdown: Record<string, number> = {};
    for (const r of rows) {
      if (r.analysis_type) breakdown[r.analysis_type] = r.type_count;
    }

    reply.send({
      today_total: Number(total),
      breakdown,
      last_updated: new Date().toISOString(),
    });
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});
```

### Frontend: Pie Chart Configuration (inline ECharts)
```typescript
// Inside dashboard.ts, add inline ECharts initialization for the pie chart
private _initPieChart(container: HTMLDivElement, typeData: { name: string; value: number }[]) {
  const chart = echarts.init(container, undefined, { renderer: "canvas" });
  const total = typeData.reduce((s, d) => s + d.value, 0);

  chart.setOption({
    tooltip: {
      trigger: "item",
      formatter: (params: any) => {
        const pct = ((params.value / total) * 100).toFixed(1);
        return `${params.name}<br/>实例数: ${params.value}<br/>占比: ${pct}%`;
      },
    },
    series: [{
      type: "pie",
      radius: ["40%", "70%"],
      center: ["50%", "55%"],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: "var(--card)", borderWidth: 2 },
      label: {
        show: true,
        formatter: "{b}\n{d}%",
        fontSize: 11,
        color: "var(--muted)",
      },
      data: typeData,
    }],
  });

  // Click handler for navigation (D-04)
  chart.on("click", (params: any) => {
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "instances-db", filter: { db_type: params.name.toLowerCase() } },
    }));
  });

  // Resize observer
  new ResizeObserver(() => chart.resize()).observe(container);
  return chart;
}
```

### Frontend: Line Chart Configuration (inline ECharts)
```typescript
// Inside dashboard.ts, add inline ECharts initialization for the capacity trend
private _initTrendChart(container: HTMLDivElement, data: { time: string[]; values: number[] }) {
  const chart = echarts.init(container, undefined, { renderer: "canvas" });

  chart.setOption({
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        return `${params[0].name}<br/>数据总量: ${params[0].value.toFixed(2)} GB`;
      },
    },
    grid: { left: 50, right: 20, top: 10, bottom: 30 },
    xAxis: {
      type: "category",
      data: data.time,
      boundaryGap: false,
      axisLabel: { color: "var(--muted)", fontSize: 11 },
      axisLine: { lineStyle: { color: "var(--border)" } },
    },
    yAxis: {
      type: "value",
      name: "GB",
      axisLabel: { color: "var(--muted)", fontSize: 11 },
      splitLine: { lineStyle: { color: "var(--border)", type: "dashed" } },
    },
    series: [{
      type: "line",
      data: data.values,
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: "var(--accent)" },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: "rgba(210, 190, 252, 0.3)" },
          { offset: 1, color: "rgba(210, 190, 252, 0.05)" },
        ]),
      },
    }],
  });

  new ResizeObserver(() => chart.resize()).observe(container);
  return chart;
}
```

### Health Card Click Navigation
```typescript
private _navigateToInstances(status: string) {
  window.dispatchEvent(new CustomEvent("slide-navigate", {
    detail: { tab: "instances-db", filter: { health_status: status } },
  }));
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-instance QPS trend chart (bottom of dashboard) | Global data volume trend (replaces QPS) | Phase 88 | D-10 mandates replacement. The old QPS chart was per-instance and meaningless on a global dashboard. |
| Hardcoded colors throughout dashboard.ts | Full CSS variable adoption | Phase 88 | D-24 requires replacing `#e5e5ea`, `#ffffff`, `#1a1a1e`, `#6e6e73`, etc. with `var(--border)`, `var(--card)`, `var(--text-strong)`, `var(--muted)` |
| Per-instance stat cards (connections, QPS) | Global stat cards (instance count, data volume, alerts, AI analysis) | Phase 88 | D-12/D-13: remove per-instance metrics, replace with globally meaningful indicators |
| `<metric-chart>` component | Inline ECharts instance | Phase 88 | D-08 specifically rejects reusing `<metric-chart>` for the new trend chart |

**Deprecated/outdated:**
- `metricsSummary` state (connections, qps): Removed by D-13
- `qpsTrend` state: Removed by D-10

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `ai_analysis` table name is the correct source (not `ai_analysis_cache` as mentioned in CONTEXT.md) | Code Examples: AI Stats Endpoint | LOW -- verified by code audit; table name `ai_analysis` is used throughout `ai-analysis-database-service.ts` |
| A2 | The 2-hour bucket interval for capacity trend aggregation is acceptable | Code Examples: Capacity Trend Endpoint | LOW -- Claude's discretion on aggregation granularity; adjust as needed for performance vs. granularity |
| A3 | Offline detection uses `last_health_check_at` from the existing `getAllInstances()` response | Architecture Patterns | LOW -- D-18 defines logic; frontend computes offline within returned active instances |
| A4 | `aiAnalysisDatabaseService.getAnalysisStats()` provides a sufficient query pattern even though it's not the exact endpoint needed | Architecture Patterns | LOW -- the method groups by status, not by type or daily count; a custom query is needed for the daily count with type breakdown |
| A5 | No new backend files are needed -- routes can be added inline in `server.ts` | Recommended Project Structure | MEDIUM -- if multiple aggregation methods are complex, extracting to `dashboard-service.ts` would be cleaner. This is a judgment call left to the planner. |

## Open Questions (RESOLVED)

1. **Should the new dashboard endpoints require authentication?** (RESOLVED)
   - Resolution: Dashboard endpoints (`capacity-trend`, `ai-stats`) do NOT use `preHandler` auth, following the pattern of existing read-only endpoints (`GET /api/database/instances`, `GET /api/database/instances/:id/capacity/history`). These return aggregate statistics; T-88-02 accepts the elevation risk as minimal. [Per Plan 88-01 Task 2 and threat model T-88-02]

2. **What exact table columns does `capacity_history` use?** (RESOLVED)
   - Resolution: Confirmed via code audit -- `capacity_history` has `instance_id, total_size_gb, db_count, table_count, recorded_at` columns with `recorded_at` auto-set. The bucket aggregation uses `DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00')` -- proven pattern from `getHistoricalMetricsWithRange()`. [Per Plan 88-01 Task 2 SQL]

3. **What parameter format does instances-db use for filtering?** (RESOLVED)
   - Resolution: Navigation uses the existing `slide-navigate` CustomEvent with `filter: { db_type: "...", health_status: "..." }` in the detail object. This pattern matches existing navigation usage in the codebase. If instances-db does not yet handle filter params, the plan defers this to the instances-db phase. [Per Plan 88-02 Task 2 L section]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Frontend dev server (Vite) | Yes | -- | -- |
| npm/pnpm | Package management | Yes | -- | -- |
| MySQL | Backend capacity_history + ai_analysis queries | Yes (in production) | -- | -- |
| ECharts | Pie chart + trend chart | Yes | 5.4.0 | -- |

**Missing dependencies with no fallback:** None -- all dependencies are already in the project.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (backend) |
| Config file | `apps/db-ops-api/vitest.config.ts` |
| Quick run command | `cd apps/db-ops-api && npx vitest run --reporter=verbose` |
| Full suite command | `cd apps/db-ops-api && npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DASH-02 | Capacity trend endpoint returns aggregated data | integration | `cd apps/db-ops-api && npx vitest run tests/dashboard.test.ts` | ❌ Wave 0 |
| DASH-03 | AI stats endpoint returns daily count | integration | same as above | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** Run backend tests via `cd apps/db-ops-api && npx vitest run --changed --reporter=verbose`
- **Per wave merge:** Full backend suite via `cd apps/db-ops-api && npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/db-ops-api/tests/dashboard.test.ts` -- integration tests for new dashboard endpoints (capacity-trend, ai-stats)
- [ ] Possibly `frontend/src/openclaw/ui/views/__tests__/dashboard.test.ts` -- if UI component testing is desired (note: no existing Lit component tests in the project)

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Fastify query parameter validation (hours param as Number, default fallback) |

### Known Threat Patterns for {stack}
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via query params | Tampering | Parameterized queries (all existing backend services use `pool.execute(sql, params)` with `?` placeholders -- the new endpoints should follow this pattern) |

**Note:** The dashboard is a read-only view with no mutation endpoints. No CSRF, XSS, or authorization elevation concerns beyond what the existing API patterns already handle.

## Sources

### Primary (HIGH confidence)
- [Codebase: frontend/package.json] - ECharts 5.4.0, Lit 3.3.2 versions and dependencies
- [Codebase: apps/db-ops-api/package.json] - Fastify 4.24.3, mysql2 3.20.0
- [Codebase: server.ts] - All existing API route patterns
- [Codebase: frontend/src/openclaw/ui/views/dashboard.ts] - Current dashboard implementation (base for rewrite)
- [Codebase: frontend/src/openclaw/ui/components/metric-chart.ts] - ECharts lifecycle and config patterns
- [Codebase: apps/db-ops-api/src/metrics-database-service.ts] - capacity_history query patterns, getCapacityHistory()
- [Codebase: apps/db-ops-api/src/instance-database-service.ts] - getAllInstances() query structure and filters
- [Codebase: apps/db-ops-api/src/ai-analysis-database-service.ts] - ai_analysis table schema and query patterns
- [Codebase: frontend/src/openclaw/ui/icons.ts] - Available SVG icons
- [Codebase: frontend/src/openclaw/styles/base.css] - Full CSS variable definitions
- [Codebase: frontend/src/openclaw/ui/views/instance-detail.ts] - CSS variable usage patterns
- [Codebase: apps/db-ops-api/vitest.config.ts] - Backend test configuration

### Secondary (MEDIUM confidence)
- [CONTEXT.md: 88-CONTEXT.md] - Phase decisions and constraints
- [UI-SPEC.md: 88-UI-SPEC.md] - Design contracts for typography, spacing, colors, copy

### Tertiary (LOW confidence)
None -- all findings verified against the codebase.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries confirmed in package.json files
- Architecture: HIGH - Patterns confirmed across existing components
- Pitfalls: HIGH - All verified by reading actual code
- Backend endpoints: MEDIUM - The exact SQL queries for aggregation are discretionary; the patterns and tables are confirmed
- Offline detection: MEDIUM - Logic depends on discretionary threshold value

**Research date:** 2026-05-11
**Valid until:** 2026-06-11 (stable stack, no fast-moving dependencies)
