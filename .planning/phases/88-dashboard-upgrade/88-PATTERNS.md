# Phase 88: Dashboard Upgrade - Pattern Map

**Mapped:** 2026-05-11
**Files analyzed:** 4
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `frontend/src/openclaw/ui/views/dashboard.ts` | component | request-response | `frontend/src/openclaw/ui/views/dashboard.ts` (existing) + `frontend/src/openclaw/ui/components/metric-chart.ts` | exact (self-rewrite) |
| `apps/db-ops-api/server.ts` (edit: add 2 routes) | route | request-response | `apps/db-ops-api/server.ts` lines 276-283 (instances) + 979-988 (capacity history) | exact |
| `apps/db-ops-api/src/dashboard-service.ts` | service | CRUD (read-only) | `apps/db-ops-api/src/instance-database-service.ts` | role-match |
| `apps/db-ops-api/tests/dashboard.test.ts` | test | request-response | `apps/db-ops-api/tests/collector-api.test.ts` | role-match |

## Pattern Assignments

### `frontend/src/openclaw/ui/views/dashboard.ts` (component, request-response)

**Analog:** Existing `dashboard.ts` (lines 1-569) -- the component being rewritten; provides all component scaffolding patterns.
**Secondary analog:** `metric-chart.ts` (lines 1-285) -- ECharts lifecycle and inline configuration patterns.

**Imports pattern** (dashboard.ts lines 1-3):
```typescript
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../icons.js";
```

**ECharts import** (metric-chart.ts line 15):
```typescript
import * as echarts from "echarts";
```

**Component declaration pattern** (dashboard.ts lines 19-20):
```typescript
@customElement("dashboard-page")
export class DashboardPage extends LitElement {
```

**State properties pattern** (dashboard.ts lines 306-312):
```typescript
@state() private instanceSummary: InstanceSummary | null = null;
@state() private alertSummary: AlertSummary | null = null;
@state() private recentAlerts: Array<...> = [];
@state() private loading = true;
@state() private error: string | null = null;
```

**Auth header pattern** (dashboard.ts lines 314-317):
```typescript
private get _headers(): Record<string, string> {
  const token = localStorage.getItem("token") || "";
  return token ? { "Authorization": `Bearer ${token}` } : {};
}
```

**Data loading pattern** (dashboard.ts lines 319-397):
```typescript
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
    if (!instancesRes.ok) throw new Error("Failed to load instances");
    // ... process responses, assign @state() properties
    this.loading = false;
  } catch (err: any) {
    this.error = err.message;
    this.loading = false;
  }
}
```

**Loading / error / empty state rendering** (dashboard.ts lines 404-410):
```typescript
override render() {
  if (this.loading) {
    return html`<div class="loading">加载中...</div>`;
  }
  if (this.error) {
    return html`<div class="loading" style="color: #dc2626;">${this.error}</div>`;
  }
  // ... main template
}
```

**Navigation CustomEvent pattern** (dashboard.ts lines 399-401):
```typescript
private _navigateTo(tab: string) {
  window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab } }));
}
```

**CSS variable usage pattern -- COPY FROM instance-detail.ts** (lines 76-230):
```typescript
static override styles = css`
  :host { display: block; }
  .status-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
  }
  .status-card__title {
    color: var(--text-strong);
  }
  .status-item__time {
    color: var(--muted);
  }
  .status-badge.ok {
    background: var(--ok-subtle);
    color: var(--ok);
  }
  /* Responsive breakpoints pattern */
  @media (max-width: 1200px) { ... }
  @media (max-width: 768px) { ... }
  @media (max-width: 480px) { ... }
`;
```

**ECharts lifecycle pattern -- COPY FROM metric-chart.ts** (lines 108-139):
```typescript
override disconnectedCallback() {
  super.disconnectedCallback();
  this._resizeObserver?.disconnect();
  this._chart?.dispose();
  this._chart = null;
}

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

**CSS variable mapping for dashboard.ts rewrite -- replace ALL the following hardcoded colors:**

| Current Hardcoded | Replace With |
|---|---|
| `#ffffff` | `var(--card)` |
| `#1a1a1e` | `var(--text-strong)` |
| `#6e6e73` | `var(--muted)` |
| `#e5e5ea` | `var(--border)` |
| `#f1f3f5` | `var(--bg-elevated)` or `var(--border)` |
| `#f8f9fa` | `var(--secondary)` or `var(--bg-accent)` |
| `#dc2626` | `var(--danger)` (note: danger=#b08df5 in dark, #7c5cff in light -- different hue than red. Use `--ok` for green status colors instead of `#15803d`) |
| `#15803d` | `var(--ok)` |
| `#b45309` | `var(--warn)` |
| `#2563eb` | `var(--info)` |
| `#f59e0b` | `var(--warn)` |
| `#7c5cff` | `var(--accent)` |
| `rgba(124,92,255,...)` | `var(--accent-subtle)` |
| `rgba(0,0,0,0.04)` | `var(--card-highlight)` |

**Important note on semantic colors vs hardcoded:** The new CSS variable system uses `--ok` (green), `--warn` (amber), `--danger` (violet, not red). The dashboard currently uses `red/danger` for critical alerts and `green/ok` for healthy -- the `--danger` variable maps to violet (#b08df5 dark / #7c5cff light). For critical/high-severity indicators, use `--danger` consistently; do NOT hardcode `#dc2626` red.

---

### `apps/db-ops-api/server.ts` (route, request-response -- add 2 new routes)

**Analog:** Lines 979-988 (per-instance capacity history route) for capacity-trend; lines 276-283 (instances list) for ai-stats.

**Existing route import pattern** (lines 16-55):
```typescript
import Fastify from 'fastify';
import { dbConnection } from './src/db-connection.js';
import { metricsDatabaseService } from './src/metrics-database-service.js';
import { aiAnalysisDatabaseService } from './src/ai-analysis-database-service.js';
```

**New imports to add (after line 55):**
```typescript
// Already imported: metricsDatabaseService (line 27), aiAnalysisDatabaseService (line 55)
// No new imports needed -- both services are already imported
```

**Per-instance capacity history route -- analog for capacity-trend** (server.ts lines 979-988):
```typescript
fastify.get('/api/database/instances/:id/capacity/history', async (request, reply) => {
  try {
    const { id } = request.params as any;
    const hours = Number((request.query as any)?.hours) || 168; // default 7 days
    const history = await metricsDatabaseService.getCapacityHistory(Number(id), hours);
    reply.send({ history });
  } catch (error: any) {
    reply.code(500).send({ error: '获取容量历史失败：' + error.message });
  }
});
```

**Instances list route -- analog for ai-stats (no auth)** (server.ts lines 276-283):
```typescript
fastify.get('/api/database/instances', async (request, reply) => {
  try {
    const instances = await instanceDatabaseService.getAllInstances();
    reply.send(instances);
  } catch (error: any) {
    reply.code(500).send({ error: '获取实例列表失败：' + error.message });
  }
});
```

**New capacity-trend route (insert around line 988, after existing capacity history route):**
```typescript
fastify.get('/api/dashboard/capacity-trend', async (request, reply) => {
  try {
    const hours = Number((request.query as any)?.hours) || 168;
    const pool = dbConnection.getPool();
    if (!pool) return reply.code(500).send({ error: '数据库未连接' });

    // Cross-instance aggregation with hour-level bucket
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

    // Current total from the latest record per instance
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

**New ai-stats route (insert after capacity-trend):**
```typescript
fastify.get('/api/dashboard/ai-stats', async (request, reply) => {
  try {
    const pool = dbConnection.getPool();
    if (!pool) return reply.code(500).send({ error: '数据库未连接' });

    const [rows] = await pool.execute(
      `SELECT
         COUNT(*) as total,
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

---

### `apps/db-ops-api/src/dashboard-service.ts` (service, CRUD read-only)

**Optional file -- only create if capacity-trend/ai-stats logic is non-trivial.**
**Analog:** `apps/db-ops-api/src/metrics-database-service.ts`

**Singleton service pattern** (lines 844-845):
```typescript
// At end of file
export const dashboardService = new DashboardService();
```

**Service class structure** (metrics-database-service.ts lines 71-77):
```typescript
class DashboardService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  private isConnected(): boolean {
    return dbConnection.isConnected();
  }
```

**Method pattern with parameterized queries** (metrics-database-service.ts lines 763-791):
```typescript
  async getCapacityTrend(hours: number = 168): Promise<...> {
    const pool = this.getPool();
    if (!pool) {
      return []; // or null
    }

    try {
      const [rows] = await pool.execute(
        `SELECT DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00') as time_bucket,
                SUM(total_size_gb) as total_size_gb
         FROM capacity_history
         WHERE recorded_at >= NOW() - INTERVAL ? HOUR
         GROUP BY DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00')
         ORDER BY time_bucket ASC`,
        [hours]
      ) as any;

      return rows.map((r: any) => ({
        time: r.time_bucket,
        total_size_gb: Number(r.total_size_gb),
      }));
    } catch (error) {
      console.error('获取容量趋势失败:', error);
      return [];
    }
  }
```

**Error handling pattern** (metrics-database-service.ts lines 126-128):
```typescript
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }
```

---

### `apps/db-ops-api/tests/dashboard.test.ts` (test, request-response)

**Analog:** `apps/db-ops-api/tests/collector-api.test.ts`

**Test structure pattern** (collector-api.test.ts lines 1-86):
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify from 'fastify';

describe('Dashboard API', () => {
  let app: ReturnType<typeof fastify>;

  beforeAll(async () => {
    app = fastify({ logger: false });

    // Register the dashboard routes directly
    app.get('/api/dashboard/capacity-trend', async (request, reply) => {
      // ... simplified test handler or use actual service
    });
    app.get('/api/dashboard/ai-stats', async (request, reply) => {
      // ...
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/dashboard/capacity-trend returns aggregated data', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/capacity-trend?hours=24',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('current_total_gb');
    expect(body).toHaveProperty('trend');
    expect(Array.isArray(body.trend)).toBe(true);
  });

  it('GET /api/dashboard/ai-stats returns daily count', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/ai-stats',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('today_total');
    expect(body).toHaveProperty('breakdown');
  });

  it('unauthenticated requests succeed (no auth preHandler)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/capacity-trend',
    });
    expect(response.statusCode).toBe(200);
  });
});
```

---

## Shared Patterns

### Lit Component Scaffolding
**Source:** `frontend/src/openclaw/ui/views/dashboard.ts` (entire file)
**Apply to:** Rewritten dashboard.ts

All dashboard components follow this pattern:
- `@customElement("dashboard-page")` decorator
- `extends LitElement`
- `static override styles = css\`...\``
- `@state()` decorators for reactive data
- `override firstUpdated()` to trigger initial data load
- `override render()` returning `html\`...\`` template
- Loading/error states handled at top of render()

### Auth for Backend Routes
**Source:** `apps/db-ops-api/server.ts` lines 81-107
**Apply to:** Both new dashboard endpoints

**Decision guidance:** The existing dashboard-facing endpoints (`GET /api/database/instances` at line 276, `GET /api/database/instances/:id/capacity/history` at line 979) do NOT use `preHandler` auth middleware. They rely on the handler to optionally use auth headers. The new capacity-trend and ai-stats endpoints follow the same pattern -- NO `preHandler` auth required, matching the read-only dashboard data convention.

If auth is desired, use:
```typescript
fastify.get('/api/dashboard/capacity-trend', {
  preHandler: [verifyToken],
  handler: async (request, reply) => { ... }
});
```

### Navigation CustomEvent
**Source:** `dashboard.ts` line 399-401
**Apply to:** Pie chart click (DASH-04) and health card click (DASH-19)

```typescript
// Pie slice click -> instances-db filtered by db_type
window.dispatchEvent(new CustomEvent("slide-navigate", {
  detail: { tab: "instances-db", filter: { db_type: params.name.toLowerCase() } },
}));

// Health card click -> instances-db filtered by status
window.dispatchEvent(new CustomEvent("slide-navigate", {
  detail: { tab: "instances-db", filter: { health_status: "critical" } },
}));
```

### ECharts ResizeObserver Lifecycle
**Source:** `metric-chart.ts` lines 108-139
**Apply to:** Both inline ECharts instances in dashboard.ts

```typescript
// MUST be paired: init in firstUpdated / dispose in disconnectedCallback
private _initPieChart(container: HTMLDivElement, ...) {
  const chart = echarts.init(container, undefined, { renderer: "canvas" });
  chart.setOption({ ... });
  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(container);
  return { chart, ro }; // store for cleanup
}

override disconnectedCallback() {
  super.disconnectedCallback();
  this._pieRO?.disconnect();
  this._pieChart?.dispose();
  this._trendRO?.disconnect();
  this._trendChart?.dispose();
}
```

### CSS Variable System (available variables)
**Source:** `frontend/src/openclaw/styles/base.css` lines 1-100
**Apply to:** All CSS in rewritten dashboard.ts

| Category | Variables | Usage |
|---|---|---|
| Background | `--bg`, `--bg-accent`, `--bg-elevated`, `--bg-hover`, `--bg-muted` | Section backgrounds, hover states |
| Card | `--card`, `--card-foreground`, `--card-highlight` | `.ov-card`, `.action-card`, `.status-card` |
| Text | `--text`, `--text-strong`, `--muted`, `--muted-strong` | Labels, values, hints |
| Border | `--border`, `--border-strong`, `--border-hover` | Card borders, dividers |
| Accent | `--accent`, `--accent-hover`, `--accent-subtle`, `--accent-glow` | Primary actions, links, highlights |
| Semantic | `--ok`, `--ok-subtle`, `--warn`, `--warn-subtle`, `--danger`, `--danger-subtle`, `--info` | Health status, alert severity |
| Sizing | `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full` | Border radius |
| Shadow | `--shadow-sm`, `--shadow-md`, `--shadow-lg` | Card shadows |
| Typography | `--font-body`, `--mono` | Font families |

### Icons Available
**Source:** `frontend/src/openclaw/ui/icons.ts`
**Apply to:** Stat cards and health status cards

Relevant icons for the new dashboard:
- `icons.database` -- instances card, health/db type sections
- `icons.bell` -- alerts card
- `icons.barChart` -- reports/quick actions, data volume
- `icons.trendingUp` -- data volume trend card
- `icons.hardDrive` -- data volume card
- `icons.spark` -- AI analysis card
- `icons.brain` -- AI/analysis
- `icons.check` -- healthy status
- `icons.alertTriangle` -- warning status, alerts panel
- `icons.alertCircle` -- critical status
- `icons.x` -- offline/error
- `icons.checkCircle` -- healthy, empty state success
- `icons.info` -- informational
- `icons.circle` -- generic dot indicator
- `icons.activity` -- activity/trend indicator

## No Analog Found

All files have close matches in the codebase. No files lacking analogs.

| File | Role | Reason for Complete Confidence |
|---|---|---|
| -- | -- | Dashboard.ts is a rewrite of itself; server.ts routes follow existing identical patterns; test follows existing vitest+fastify.inject pattern |

## Metadata

**Analog search scope:**
- `frontend/src/openclaw/ui/views/dashboard.ts`
- `frontend/src/openclaw/ui/components/metric-chart.ts`
- `frontend/src/openclaw/ui/views/instance-detail.ts`
- `frontend/src/openclaw/ui/icons.ts`
- `frontend/src/openclaw/styles/base.css`
- `apps/db-ops-api/server.ts`
- `apps/db-ops-api/src/metrics-database-service.ts`
- `apps/db-ops-api/src/instance-database-service.ts`
- `apps/db-ops-api/src/ai-analysis-database-service.ts`
- `apps/db-ops-api/tests/collector-api.test.ts`

**Files scanned:** 10
**Pattern extraction date:** 2026-05-11
