# Phase 88: Dashboard Upgrade - Context

**Gathered:** 2026-05-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Upgrade the Slide DBA dashboard with new ECharts visualizations (DB type distribution pie chart, data volume trend line chart), replace per-instance metrics with globally meaningful stat cards, add health status summary cards, and reorganize layout with CSS Grid and full CSS variable adoption.

Requirements: DASH-01 through DASH-04.
</domain>

<decisions>
## Implementation Decisions

### DB Type Distribution Chart (DASH-01)
- **D-01:** ECharts 饼图，按实例数显示各 DB 类型占比
- **D-02:** 前端聚合 — 复用 `GET /api/database/instances` 返回的 `db_type` 字段，在浏览器端按类型分组计数
- **D-03:** 展示所有数据库类型（MySQL/PostgreSQL/Oracle/达梦），不合并为"其他"
- **D-04:** 悬停 tooltip 显示类型名、实例数、百分比；点击扇区跳转到 instances-db 页面并按该类型过滤

### Data Volume Trend Chart (DASH-02)
- **D-05:** 预设时间按钮（24h / 7d / 30d）+ 日期范围选择器，默认 7 天
- **D-06:** 默认全库汇总趋势线，通过下拉选择器可切换到单实例视图
- **D-07:** 新增后端聚合端点（如 `GET /api/dashboard/capacity-trend?hours=168`），跨所有活跃实例按时间聚合 `total_size_gb`
- **D-08:** 内联 ECharts 实例（不复用 `<metric-chart>`），折线图 + 半透明面积填充
- **D-09:** 图表上方显示当前汇总数字概要："当前总量: X.X TB/GB"
- **D-10:** 替换现有仪表盘底部的 QPS 趋势图
- **D-11:** 暂无容量数据时显示空状态提示："暂无容量数据，请确保监控采集已启用"

### Stat Cards Redesign
- **D-12:** 第一行 4 张统计卡片内容调整为：实例总数 / 数据总量 / 活跃告警 / AI 分析总数
- **D-13:** 移除连接数和 QPS 卡片（单实例指标对全局仪表盘无实际意义）
- **D-14:** AI 分析总数包含告警 RCA、故障诊断、SQL 审核、容量预测等所有 AI 相关功能
- **D-15:** AI 分析总数需要新增后端统计端点（如 `GET /api/dashboard/ai-stats`），从 `ai_analysis_cache` 表聚合当日计数
- **D-16:** 数据总量卡片数字从 DASH-02 容量趋势端点获取当前值

### Health Status Summary Cards (DASH-03)
- **D-17:** 概要卡片风格 — 大数字 + 状态标签 + 状态色图标，健康/警告/异常/离线 4 张
- **D-18:** 离线实例通过健康检查超时判定（`health_status` 为 null 或超过阈值分钟数未更新健康检查记录的实例）
- **D-19:** 点击卡片跳转到 instances-db 页面并按该状态过滤
- **D-20:** 使用 CSS 变量系统统一视觉（`--ok`, `--warn`, `--danger`, `--muted`）

### CSS Grid Layout (DASH-04)
- **D-21:** 保留现有内容（快捷操作、待处理告警面板、实例健康列表）+ 新增图表和卡片
- **D-22:** 最终布局自上而下：统计卡片行 → 健康状态卡片行 → 图表行（饼图左 + 趋势图右并排）→ 快捷操作行 → 双栏面板行
- **D-23:** 三档响应式断点（1200px / 768px / 480px），逐级回退：卡片 4→2→1 列，图表并排→上下，底部双栏→单栏
- **D-24:** 全面 CSS 变量化 — 所有硬编码颜色（`#e5e5ea`, `#ffffff`, `#1a1a1e`, `#6e6e73` 等）替换为项目已有的 CSS 变量

### Claude's Discretion
- ECharts 饼图和折线图的具体配置（颜色方案、tooltip 格式、动画参数）
- 三档响应式断点的具体 CSS 实现和回退行为
- CSS 变量映射细节（硬编码颜色到变量的完整替换方案）
- 空状态/加载态/错误态的具体 UI 设计
- 4 张统计卡片和 4 张健康状态卡片的具体视觉设计（布局、图标、间距）
- 健康检查超时判定的具体分钟数阈值
- 饼图扇区点击跳转的 URL 参数格式（如 `?health=critical`）
- 数据总量卡片的单位格式化逻辑（GB/TB 自动切换）
- AI 分析总数端点的具体聚合逻辑（按天/按类型/按实例）
- 实例筛选下拉选择器的 UI 实现
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Planning
- `.planning/ROADMAP.md` — Phase 88 goal, success criteria (4 items), DASH-01 through DASH-04 requirements
- `.planning/REQUIREMENTS.md` — DASH-01 through DASH-04 detailed requirement descriptions

### Existing Frontend — Dashboard
- `frontend/src/openclaw/ui/views/dashboard.ts` — Current dashboard (stat cards, quick actions, alerts panel, health list, QPS chart). Base component for all upgrades.
- `frontend/src/openclaw/ui/components/metric-chart.ts` — Existing ECharts wrapper (`<metric-chart>`) with `@customElement`, `LitElement`, property-based config. Reference only — DASH-02 uses inline ECharts instead.
- `frontend/src/openclaw/ui/navigation.ts` — Tab definitions, TAB_GROUPS. Dashboard already registered as `"dashboard"` at path `/dashboard`.
- `frontend/src/openclaw/ui/app-render.ts` — Route dispatch (line 1563 renders `<dashboard-page>`). No navigation changes needed.

### Existing Backend — Data Sources
- `apps/db-ops-api/src/instance-database-service.ts` § `getAllInstances()` — Returns `id, name, db_type, health_status, health_score, last_health_check_at`. Used for DASH-01 (db_type aggregation) and DASH-03 (health status counts). Currently filters `WHERE status = 'active'` — may need adjustment for offline detection.
- `apps/db-ops-api/src/metrics-database-service.ts` § `getCapacityHistory(instanceId, hours)` — Per-instance capacity history query from `capacity_history` table. DASH-02 needs a new cross-instance aggregation endpoint.
- `apps/db-ops-api/src/ai-analysis-database-service.ts` — `ai_analysis_cache` table with `analysis_type` field (RCA, fault diagnosis, TopSQL, capacity prediction). Reference for new AI stats endpoint.

### Frontend Patterns Reference
- `frontend/src/openclaw/ui/views/instance-detail.ts` — ECharts inline usage pattern (via `<metric-chart>`)
- `frontend/src/openclaw/ui/views/llm-config.ts` — CSS variables usage pattern (`var(--card)`, `var(--border)`, `var(--text)`)
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **ECharts** (`echarts` npm dependency): Already bundled and used via `<metric-chart>` and inline in instance-detail. Both chart types (pie, line) are built-in.
- **`GET /api/database/instances`**: Already returns all active instances with `db_type`, `health_status`, `health_score`, `last_health_check_at`. Frontend can compute type distribution and health breakdown without new endpoints.
- **CSS variable system**: `--card`, `--border`, `--bg-elevated`, `--accent`, `--muted`, `--text`, `--ok`, `--ok-subtle`, `--destructive`, `--danger-subtle`, `--warn`, `--warn-subtle` — already defined and used throughout. Dashboard currently uses hardcoded colors instead.
- **`icons` module** (`../icons.js`): `database`, `bell`, `barChart`, `check`, `alertTriangle`, `x`, `info`, `checkCircle`, `alertCircle` — all usable in new cards.

### Established Patterns
- `@customElement("dashboard-page")` + `LitElement` + `@state()` decorators
- `static override styles = css\`...\`` component-scoped styles
- `fetch()` + `localStorage.getItem("token")` for API calls with `_headers()` getter
- `slide-navigate` CustomEvent for tab navigation (`window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab } }))`)

### Integration Points
- **Navigation**: Dashboard tab already at `"dashboard"` in navigation.ts — no changes needed
- **Route dispatch**: `app-render.ts` line 1563 already renders `<dashboard-page>` for `state.tab === "dashboard"` — no changes needed
- **New API endpoints needed**: Two new endpoints for dashboard stats — aggregate capacity trend and AI analysis count
- **CSS variables**: Dashboard currently uses hardcoded colors inline — must adopt existing variable system

### Creative Options
- DB type pie chart can use a single ECharts instance with standard pie config
- Data volume trend can use a single ECharts instance with `areaStyle` for fill
- Health status cards can reuse the existing stat card grid pattern (`.ov-cards`)
- Offline detection can be implemented via a new endpoint parameter (`include_all: true` to bypass `WHERE status = 'active'`) or by querying `last_health_check_at` age
- Instance filter on data volume chart can use native `<select>` dropdown populated from fetched instances
</code_context>

<specifics>
## Specific Ideas

- 统计卡片内容从运维视角重新设计：全局有意义的前瞻性指标，而非单实例技术指标
- 饼图扇区可点击跳转实例列表（按类型过滤）—— 图表不仅是展示也是导航入口
- 健康状态卡片可点击跳转实例列表（按状态过滤）—— 从概览到详情的快捷路径
- AI 分析总数体现 Slide 作为 AI Agent 运维助手的核心定位

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

### Reviewed Todos (not folded)
- **自动 AI 分析结果在告警列表中不可见** — AI/alert area, not relevant to dashboard scope. Score: 0.9
- **定时任务改为可配置** — Backend infrastructure, not dashboard scope. Score: 0.6

</deferred>

---

*Phase: 88-dashboard-upgrade*
*Context gathered: 2026-05-11*
