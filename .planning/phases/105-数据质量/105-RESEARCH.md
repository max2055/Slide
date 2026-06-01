# Phase 105: 数据质量 (Data Quality) - Research

**Researched:** 2026-05-21
**Domain:** Multi-dimensional health scoring, collection capability detection, trend visualization
**Confidence:** HIGH

## Summary

Phase 105 implements multi-dimensional health scoring (replacing the current deduct-from-100 algorithm), health score trend visualization, per-check-item health details, and automatic collection capability detection. The backend needs new API endpoints and scoring logic; the frontend needs a new "health score" tab and collection capabilities display in the instance detail page.

The current `checkXxxHealth()` methods in `database-service.ts` use a simple 100-minus-deductions approach with 2-5 checks per DB type. Phase 105 replaces this with a weighted four-dimension score: availability (0.35), performance (0.35), capacity (0.20), security (0.10). Scoring weights are stored in `system_config` (following the `ai-analysis-config-service.ts` pattern). Each existing health check item maps to one of these four dimensions.

The frontend uses ECharts (already bundled at `echarts@^5.4.0`) via the reusable `<metric-chart>` component -- no need to add Chart.js. The instance detail page already has 11 tabs; a new "health score" tab fits naturally.

There is **no existing collection capability tracking** system. QUAL-03 requires building one: storing per-metric, per-instance success/failure state and exposing it as an API.

**Primary recommendation:** Replace the simple score logic in `checkXxxHealth()` with a dimension-aware scoring function. Add dimension weights via `system_config`. Use ECharts `<metric-chart>` for the trend chart. Build collection capability tracking as a new table or in-memory tracker.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** 多维度加权评分：availability (0.35) + performance (0.35) + capacity (0.20) + security (0.10)。权重可配置。
- **D-02:** 权重存储在配置中（新增配置 JSON 或 metric_definitions 扩展），前端设置页面可编辑。
- **D-03:** 在实例详情页新增「健康评分」tab，折线图展示 health_check_history 的趋势。支持可配置时间范围（24h/7d/30d）。
- **D-04:** 自动检测。基于 metric_definitions 的 db_types + 实际采集成功/失败状态，自动判断每个指标对当前实例是否可用。前端显示 green/grey 状态标签。
- **D-05:** 在实例详情页展示最近一次健康检查的逐项结果（连接状态 ✓、慢查询 ✗ 等），可折叠展开。数据来源 health_check_history.checks JSON。

### Claude's Discretion
- 评分维度内的具体检查项映射由 Agent 根据现有 checkXxxHealth() 方法确定
- 图表库选择：复用现有 dashboard 中的 Chart.js 或同等轻量方案

### Deferred Ideas (OUT OF SCOPE)
None.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| QUAL-01 | 多维度实例评分算法（可用性 0.35、性能 0.35、容量 0.20、安全性 0.10，权重可配置） | Current scoring is deduct-from-100 in database-service.ts. Dimension mapping defined in this research. Weights stored in system_config. |
| QUAL-02 | 基于 health_check_history 实现评分趋势图表 | health_check_history table exists with health_score, status, checks JSON. getHealthCheckHistory() method exists but needs API exposure. ECharts metric-chart component reusable. |
| QUAL-03 | 实现每实例采集能力检测（collection_capabilities JSON 列 + 权限检测端点） | No existing capability tracking. Must build new: table or in-memory tracker for per-metric, per-instance success/failure. metric_definitions.db_types defines expected capabilities. |
| QUAL-04 | 健康状态展示增加逐检查项详情（非仅总分） | health_check_history.checks JSON already stores per-check results. Instance detail page needs new tab + collapsible detail renderer. |
</phase_requirements>

## Summary

[Content above covers summary]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Scoring algorithm | API / Backend | -- | Health check runs server-side against live DB connections |
| Scoring weight configuration | API / Backend | Frontend (settings UI) | Weights stored in system_config; frontend exposes edit form |
| Health score trend chart | Browser / Client | API / Backend | ECharts renders client-side; API provides health_check_history data |
| Collection capability detection | API / Backend | -- | Requires access to metric_registry + collection success/failure state |
| Per-check-item health detail | Browser / Client | API / Backend | Frontend renders collapsible UI from health_check_history.checks JSON |
| Collection capability display | Browser / Client | -- | Frontend renders green/grey status labels from API data |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| -- (in-project) | -- | Scoring algorithm | Custom logic in database-service.ts / new scoring service -- no external library |
| ECharts | ^5.4.0 | Trend chart rendering | Already in frontend/package.json, used by metric-chart.ts and dashboard.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `<metric-chart>` (in-project) | -- | Reusable ECharts line chart component | Trend chart for health scores (QUAL-02); line chart for multi-series scores |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ECharts `<metric-chart>` | Chart.js | ECharts already bundled (400KB min). Adding Chart.js (200KB+) would double chart bundle without benefit. ECharts is the project standard. |
| system_config for weights | metric_definitions extension | metric_definitions is metric-level, not scoring-level. system_config pattern already proven by ai-analysis-config-service.ts. |

**No new npm packages required** for this phase. All capabilities use in-project libraries (ECharts) or custom TypeScript logic.

## Package Legitimacy Audit

> No new external packages are installed in this phase. The chart library (ECharts) is already in `frontend/package.json`. No npm/pip/cargo install commands needed.

## Architecture Patterns

### System Architecture Diagram

```
┌──────────────────────┐      ┌──────────────────────────────────┐
│  Browser (Frontend)  │      │        API / Backend              │
│                      │      │                                  │
│  instance-detail.ts  │◄────►│  GET /api/database/instances/:id  │
│  ┌─────────────────┐ │      │  GET .../health-history           │
│  │ "健康评分" Tab   │ │      │  GET .../health-checks            │
│  │  - ECharts trend │ │      │  GET .../collection-capabilities  │
│  │  - Collapsible   │ │      │  GET/PUT /api/scoring/config     │
│  │    check details │ │      │                                  │
│  │  - Green/grey    │ │      │  ┌───────────────────────────┐   │
│  │    capabilities  │ │      │  │ ScoreCalculator            │   │
│  └─────────────────┘ │      │  │  - loadWeights()           │   │
│                      │      │  │  - mapChecksToDimensions() │   │
│  Settings Page       │◄────►│  │  - calculateScore()        │   │
│  (weight config)     │      │  └───────────────────────────┘   │
└──────────────────────┘      │                                  │
                              │  ┌───────────────────────────┐   │
                              │  │ system_config             │   │
                              │  │  key: scoring.weights     │   │
                              │  │  value: {"availability":  │   │
                              │  │   0.35, "performance":    │   │
                              │  │   0.35, ...}              │   │
                              │  └───────────────────────────┘   │
                              │                                  │
                              │  ┌───────────────────────────┐   │
                              │  │ health_check_history      │   │
                              │  │  - health_score (int)     │   │
                              │  │  - checks (JSON)          │   │
                              │  │  - created_at (datetime)  │   │
                              │  └───────────────────────────┘   │
                              │                                  │
                              │  ┌───────────────────────────┐   │
                              │  │ CollectionCapabilityTracker│   │
                              │  │  - per-instance, per-metric│   │
                              │  │  - success/failure/unknown │   │
                              │  └───────────────────────────┘   │
                              └──────────────────────────────────┘

Flow:
1. monitor-collector.ts tick → checkHealth() → ScoreCalculator.calculateDimensionScores()
2. Results stored in health_check_history with dimension breakdown (extend checks JSON)
3. Frontend fetches history for trend chart, latest checks for detail view
4. User configures weights via settings page → PUT /api/scoring/config → system_config
5. Collection capability tracker records metric success/failure each tick
6. Frontend fetches capabilities via GET .../collection-capabilities
```

### Recommended Project Structure

```
apps/db-ops-api/src/
├── scoring-service.ts          # NEW: dimension mapping + weighted score calculation
├── scoring-config-service.ts   # NEW: load/save scoring weights from system_config
├── collection-capabilities.ts  # NEW: per-instance per-metric collection tracker
├── database-service.ts         # MODIFY: route checkXxxHealth() through scoring service
├── instance-database-service.ts # MODIFY: expose getHealthCheckHistory() + add capability methods
├── server.ts                   # MODIFY: add 4 new API routes

frontend/src/openclaw/ui/views/
├── instance-detail.ts          # MODIFY: add "健康评分" tab + check detail section
├── health-score-tab.ts         # NEW (or inline in instance-detail.ts): trend chart + capabilities
```

### Pattern 1: Scoring Weight Configuration (system_config pattern)
**What:** Store scoring weights as JSON in system_config table, following the same pattern as ai-analysis-config-service.ts.
**Example (scoring-config-service.ts):**
```typescript
const WEIGHT_CONFIG_KEY = 'scoring.weights';
const DEFAULT_WEIGHTS = {
  availability: 0.35,
  performance: 0.35,
  capacity: 0.20,
  security: 0.10,
};

async getWeights(): Promise<Record<string, number>> {
  const pool = this.getPool();
  if (!pool) return { ...DEFAULT_WEIGHTS };
  const [rows] = await pool.execute(
    'SELECT config_value FROM system_config WHERE config_key = ?',
    [WEIGHT_CONFIG_KEY]
  ) as any;
  if (rows.length > 0) {
    return { ...DEFAULT_WEIGHTS, ...JSON.parse(rows[0].config_value) };
  }
  return { ...DEFAULT_WEIGHTS };
}
```

### Pattern 2: Dimension Score Calculation
**What:** Extract check items from health check result, map to dimensions, calculate weighted score.
**Example:**
```typescript
// Dimension mapping for each DB type -- Claude's discretion area
const DIMENSION_MAP: Record<string, Record<string, string>> = {
  mysql: {
    '连接状态': 'availability',
    '连接数使用率': 'capacity',
    '慢查询': 'performance',
  },
  postgresql: {
    '连接状态': 'availability',
    '连接数使用率': 'capacity',
    '缓存命中率': 'performance',
    '死锁检测': 'security',
  },
  oracle: {
    '连接状态': 'availability',
    '连接数使用率': 'capacity',
    '表空间使用率': 'capacity',
    '库缓存命中率': 'performance',
    '死锁检测': 'security',
  },
  dameng: {
    '连接状态': 'availability',
    '连接数使用率': 'capacity',
    '缓冲池命中率': 'performance',
    '锁等待检测': 'performance',
    '死锁检测': 'security',
  },
};

function calculateDimensionScores(checks, dbType, weights): { dimensions, total } {
  const map = DIMENSION_MAP[dbType] || {};
  const dims: Record<string, number[]> = {};
  for (const check of checks) {
    const dim = map[check.name] || 'availability';
    if (!dims[dim]) dims[dim] = [];
    dims[dim].push(check.score);
  }
  // Each dimension score = avg of its checks
  const dimensionScores: Record<string, number> = {};
  for (const [dim, scores] of Object.entries(dims)) {
    dimensionScores[dim] = scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  // Weighted total
  let total = 0;
  for (const [dim, weight] of Object.entries(weights)) {
    total += (dimensionScores[dim] || 0) * weight;
  }
  return { dimensions: dimensionScores, total: Math.round(total) };
}
```

### Anti-Patterns to Avoid
- **Storing weights in code:** Do not hardcode weights in scoring logic. Always read from system_config with fallback to defaults.
- **One-size-fits-all dimension mapping:** Each DB type has different checks. Use per-DB-type dimension maps (Claude's discretion).
- **Scoring as part of checkHealth():** Separate scoring logic from health check execution for testability.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Line chart rendering | Custom canvas drawing | ECharts via `<metric-chart>` | Already in project; handles time axis labels, tooltips, responsive resize, threshold lines |
| Configuration persistence | File-based config | system_config table | Existing pattern with JSON value_type; proven by ai-analysis-config-service.ts |

**Key insight:** This phase adds no external library dependencies. ECharts and system_config are already in the project.

## Runtime State Inventory

> Not applicable -- greenfield features (scoring algorithm, collection capabilities, trend chart, check details) do not rename or migrate existing state.

(Phase 105 is a new feature phase, not a rename/refactor/migration phase.)

## Common Pitfalls

### Pitfall 1: Dimension Mapping Inconsistency Across DB Types
**What goes wrong:** Each DB type has different health checks but scoring must be comparable across types. MySQL has 3 check items; Oracle has 5. If a dimension has no checks for a given DB type, the weighted calculation is incomplete.
**Why it happens:** The checkXxxHealth() methods evolved independently for each DB type.
**How to avoid:** Ensure each dimension has at least one check per DB type. For missing dimensions, assign a neutral score (100 or the dimension's weighted average of other dimensions).
**Warning signs:** Availability score is 0 for Oracle because "连接状态" was the only availability check and it passed (score 100, not 0 -- actually fine). More likely: a dimension missing entirely would silently not contribute.

### Pitfall 2: Weight JSON Schema Evolution
**What goes wrong:** Weights stored as JSON in system_config. If a new dimension is added later, old stored configs won't include it.
**Why it happens:** The weight JSON is a free-form object without schema enforcement.
**How to avoid:** Always merge stored weights with defaults (DEFAULT_WEIGHTS wins on keys not in stored config). Follow the ai-analysis-config-service.ts pattern exactly.
**Warning signs:** A new dimension defaults to 0 because the stored JSON doesn't contain it.

### Pitfall 3: Collection Capability Staleness
**What goes wrong:** Collection capabilities are reported as "available" based on metric_definitions.db_types, but the actual connection or permissions may make them unavailable (e.g., Oracle V$ views require DBA privileges).
**Why it happens:** db_types is a static match; actual success/failure is dynamic.
**How to avoid:** Track both: (1) expected capabilities from metric_definitions.db_types, (2) actual collection success from monitor-collector.ts collection results. Display the actual state as primary, with the expected state as fallback.
**Warning signs:** A metric shows green but every collection attempt has failed silently.

### Pitfall 4: Health Check Trend Time Range
**What goes wrong:** health_check_history only records when checkHealth() runs (every ~30s per instance). Over 30 days this produces ~86K rows per instance, which may cause slow queries.
**Why it happens:** No built-in retention or downsampling in health_check_history.
**How to avoid:** Limit trend queries by date range (max 30d). The existing getHealthCheckHistory() already accepts a `days` parameter. For the API, validate that requested range does not exceed 90 days.
**Warning signs:** Health history query takes >2s on instances with weeks of data.

## Code Examples

### Existing health_check_history.checks JSON structure
```json
[
  { "name": "连接状态", "status": "ok", "score": 100, "message": "连接正常" },
  { "name": "连接数使用率", "status": "warning", "score": 70, "message": "连接数使用率较高：65.2%" },
  { "name": "慢查询", "status": "ok", "score": 100, "message": "无慢查询" }
]
```
- `name` (string): Check item name, localized in Chinese
- `status` (string): `"ok"` | `"warning"` | `"critical"`
- `score` (number): 100 = ok, 70 = warning, 40 = critical, 0 = failed
- `message` (string, optional): Human-readable detail

### Existing getHealthCheckHistory() -- instance-database-service.ts:488
```typescript
async getHealthCheckHistory(instanceId: number, days: number = 7): Promise<any[]> {
  // SELECT health_score, status, created_at
  // FROM health_check_history
  // WHERE instance_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
  // ORDER BY created_at DESC
}
```
Returns only `health_score`, `status`, `created_at`. For per-check details, a separate query fetching the `checks` JSON column is needed.

### Existing metric-chart usage in instance-detail.ts (trend tab)
```typescript
<metric-chart
  title="CPU / 内存使用率"
  .timeData=${this.trendData.time}
  .series=${[
    { name: "CPU 使用率", data: this.trendData.cpu, color: cpuColor },
    { name: "内存使用率", data: this.trendData.memory, color: memoryColor },
  ]}
  percentage
  height="280px"
></metric-chart>
```
The health score trend should use a similar pattern with 4 series (availability, performance, capacity, security scores) plus the total score as a prominent line.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Deduct-from-100 scoring (checkXxxHealth) | Multi-dimension weighted scoring | Phase 105 | Breaks existing API contract for health_score values. health_check_history stores new dimension-aware scores |
| health_score as single int | health_score + per-dimension scores in checks JSON | Phase 105 | Checks JSON extended with dimension field; backward-compatible |
| No collection capability display | Per-metric green/grey capability labels | Phase 105 | New API endpoint, new frontend section |
| Instance detail has 11 tabs | Instance detail has 12 tabs (+ "健康评分") | Phase 105 | New tab inserted between "趋势" and "会话" |

**Deprecated/outdated:**
- The simple deduct-from-100 scoring in all four `checkXxxHealth()` methods is replaced by the ScoreCalculator service.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | health_check_history.checks JSON stores sufficient data to compute dimension scores retroactively (score values are preserved) | Architecture Patterns | Would need to re-run checkHealth() for historical data migration |
| A2 | Collecting per-metric, per-instance success/failure state does not require a new DB table (in-memory Map suffices) | Architecture Patterns | In-memory state lost on restart; if persistence is required, need migration script for new table |
| A3 | The dimension-to-check-item mapping for each DB type (defined in Pattern 2) is correct | Architecture Patterns | Wrong mapping means dimension scores misrepresent actual health |

## Open Questions (RESOLVED)

1. **How to handle the dimension-to-check-item mapping for DB types that are missing checks in a dimension?**
   - What we know: Each DB type has 2-5 checks. Availability has 1 check per type (connection status). Performance has 1-2. Capacity has 0-1. Security has 0-1.
   - What's unclear: When a dimension has zero checks (e.g., capacity for Dameng), do we assign a neutral 100 score, skip the dimension, or use metrics_history as fallback?
   - Recommendation: Assign neutral 100 for missing dimensions so the weighted total is not penalized. This is already effectively the current behavior (no deduction).

2. **Should collection capability tracking persist across server restarts?**
   - What we know: Collection success/failure can be derived from monitor-collector.ts logs (console.error). But there's no persistent store.
   - What's unclear: Is in-memory state sufficient (lost on restart, rebuilt after a few collection cycles), or should this be persisted (new DB table + migration)?
   - Recommendation: In-memory Map is sufficient for v1.3. The capability display updates after a few collection ticks, which is acceptable for an internal tool.

3. **Who can configure scoring weights? Which permission code?**
   - What we know: All settings-like operations use `metric:manage` or `ai:manage` type permissions.
   - What's unclear: No existing "scoring:manage" permission code exists in the RBAC system.
   - Recommendation: Use `metric:manage` permission or add a new `scoring:manage` permission to the RBAC system. Deferring to planning phase.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Backend (all scoring logic) | ✓ | Checked at runtime | -- |
| MySQL | Data layer (system_config, health_check_history) | ✓ | External | -- |
| ECharts | Frontend trend chart | ✓ | ^5.4.0 | -- |
| Vitest | Unit tests | ✓ | ^4.1.4 | -- |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.4 |
| Config file | apps/db-ops-api/vitest.config.ts |
| Quick run command | `cd apps/db-ops-api && npx vitest run --reporter=verbose src/scoring-service.test.ts` (if file created) |
| Full suite command | `cd apps/db-ops-api && npm test` (vitest run) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| QUAL-01 | ScoreCalculator correctly computes dimension scores and weighted total | unit | `npx vitest run src/scoring-service.test.ts` | ❌ Wave 0 |
| QUAL-01 | Weight config merges stored JSON with defaults correctly | unit | `npx vitest run src/scoring-config-service.test.ts` | ❌ Wave 0 |
| QUAL-02 | Health history API returns correct data format | integration | Verify via server route test | ❌ Wave 0 |
| QUAL-03 | Collection capability tracker detects missing metrics | unit | `npx vitest run src/collection-capabilities.test.ts` | ❌ Wave 0 |
| QUAL-04 | Checks JSON renders with correct dimension mapping | unit | `npx vitest run src/scoring-service.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose src/scoring-service.test.ts src/scoring-config-service.test.ts`
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/scoring-service.test.ts` -- covers QUAL-01 + QUAL-04 dimension mapping
- [ ] `src/scoring-config-service.test.ts` -- covers QUAL-01 weight config CRUD
- [ ] `src/collection-capabilities.test.ts` -- covers QUAL-03 tracking logic

*(Existing tests in `apps/db-ops-api/src/__tests__/` cover database-service.ts, metric-registry.ts but do not cover scoring or collection tracking)*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V4 Access Control | yes | Require `metric:view` or `scoring:view` permission on new API routes |
| V5 Input Validation | yes | Weight values validated as numbers 0.0-1.0 before storing |
| V6 Cryptography | no | No cryptographic operations in this phase |

### Known Threat Patterns for Fastify + MySQL

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Weight config parameter tampering | Tampering | Validate each weight is 0.0-1.0 and sum is approximately 1.0 |
| Unauthorized access to health history | Information Disclosure | New routes use `requireInstanceAccess('read-only')` (same as existing metrics routes) |
| Large health history query DoS | Denial of Service | Enforce max date range (90 days) on health-history API |

## Sources

### Primary (HIGH confidence)
- [Codebase: database-service.ts] -- All 4 checkXxxHealth() methods, current scoring logic
- [Codebase: instance-database-service.ts] -- getHealthCheckHistory(), updateHealthStatus(), recordHealthCheck()
- [Codebase: monitor-collector.ts] -- updateHealthStatusFromCheck(), collectInstanceMetrics()
- [Codebase: metric-registry.ts] -- All predefined metrics, MetricDefinition interface
- [Codebase: health_check_history table schema] -- checks JSON structure, columns
- [Codebase: instance-detail.ts] -- Current tab structure, activeTab type, rendering patterns
- [Codebase: metric-chart.ts] -- ECharts wrapper component, API
- [Codebase: dashboard.ts] -- ECharts usage pattern (echarts.init, setOption)
- [Codebase: ai-analysis-config-service.ts] -- system_config CRUD pattern to reuse
- [Codebase: frontend/package.json] -- echarts ^5.4.0 confirmed
- [Codebase: apps/db-ops-api/package.json] -- vitest ^4.1.4 confirmed

### Secondary (MEDIUM confidence)
- [Codebase: server.ts] -- All existing route registrations; confirms no health-history or health-checks routes exist

### Tertiary (LOW confidence)
- (none)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries confirmed in package.json and source code
- Architecture: HIGH - all patterns confirmed in codebase
- Pitfalls: HIGH - based on thorough codebase reading and understanding of existing patterns

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 (30 days for stable codebase)
