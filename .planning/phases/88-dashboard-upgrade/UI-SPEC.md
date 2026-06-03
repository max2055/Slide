# Phase 88: Dashboard Upgrade — UI Specification

**Status:** Final
**Last updated:** 2026-05-11

## 1. Overview

全面升级 Slide DBA 仪表盘：新增 ECharts 可视化图表（DB 类型分布饼图、数据量趋势折线图）、替换统计卡片为全局有意义指标、新增健康状态概要卡片组、采用 CSS Grid 重构布局、全面 CSS 变量化。

### 1.1 Key Principles

- **只读概览页**：没有破坏性操作（删除、修改），所有交互都是浏览和导航跳转
- **无 Primary CTA**：仪表盘是概览+导航入口，快捷操作区提供多个入口，保持现状
- **导航方式**：统一使用 `slide-navigate` CustomEvent (`window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab } }))`)
- **图表即导航**：饼图扇区、健康状态卡片均可点击跳转到实例列表（带过滤参数）

---

## 2. Page Layout (CSS Grid)

### 2.1 Visual Focal Point

**Primary focal point:** 顶部 4 张统计卡片行，通过大数字（22px bold）和 muted 大写标签吸引视线，建立仪表盘的信息层次入口。

### 2.2 Grid Structure

自上而下布局顺序：

```
┌──────────────────────────────────────────────┐
│  1. Stat Cards Row (4 cards)                  │
├──────────────────────────────────────────────┤
│  2. Health Status Cards Row (4 cards)         │
├──────────────────────┬───────────────────────┤
│  3a. Pie Chart       │  3b. Trend Chart      │
│  (DB type dist.)     │  (Data volume)        │
├──────────────────────┴───────────────────────┤
│  4. Quick Actions Row (3 actions)             │
├──────────────────────┬───────────────────────┤
│  5. Alerts Panel    │  6. Health List Panel  │
│  (left)             │  (right)               │
└──────────────────────┴───────────────────────┘
```

**Typography scale (4 sizes, 2 weights):**

| Size | Weight | Usage |
|------|--------|-------|
| 12px | 600 | Labels, subtitles (`--muted`, uppercase) |
| 14px | 600 | Chart titles, health status labels |
| 22px | 700 | Stat card values |
| 28px | 700 | Health status counts |

**Spacing grid:** All spacing values follow a 4px baseline grid (4, 8, 12, 16, 20, 24, 32).

### 2.2 Desktop Layout (≥1200px)

```css
.dashboard-grid {
  display: grid;
  gap: 20px;
}

/* Stat cards row */
.stat-cards-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

/* Health cards row */
.health-cards-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

/* Charts row — side by side */
.charts-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

/* Quick actions row */
.quick-actions-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

/* Bottom panels — side by side */
.panels-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
```

### 2.3 Tablet Layout (768px–1199px)

- Stat cards: 2 columns
- Health cards: 2 columns
- Charts: stacked (1 column, pie above trend)
- Quick actions: 2 columns
- Bottom panels: 2 columns

```css
@media (max-width: 1199px) {
  .stat-cards-row,
  .health-cards-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .charts-row {
    grid-template-columns: 1fr;
  }
  .quick-actions-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
```

### 2.4 Mobile Layout (≤767px)

- All grids: 1 column
- Cards and panels stack vertically

```css
@media (max-width: 767px) {
  .stat-cards-row,
  .health-cards-row,
  .charts-row,
  .quick-actions-row,
  .panels-row {
    grid-template-columns: 1fr;
  }
}
```

---

## 3. Stat Cards Row (4 Cards)

### 3.1 Card Structure (Shared Template)

```css
.stat-card {
  display: grid;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card);
}

.stat-card__icon {
  /* subtle background accent */
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  background: var(--accent-subtle, rgba(124,92,255,0.1));
}

.stat-card__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.stat-card__value {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--text);
}

.stat-card__subtitle {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
}
```

### 3.2 Card 1: 实例总数

| Property | Value |
|----------|-------|
| Icon | `icons.database` |
| Label | "数据库实例" |
| Value | Total instance count from `GET /api/database/instances` |
| Subtitle | "共 X 台数据库实例" |

- 数字颜色：默认 `var(--text)`
- 无特殊状态着色

### 3.3 Card 2: 数据总量

| Property | Value |
|----------|-------|
| Icon | `icons.hardDrive` |
| Label | "数据总量" |
| Value | Total data size (GB/TB auto-switch) from `GET /api/dashboard/capacity-trend` |
| Subtitle | "总数据量" |

- **单位自动切换**：≥ 1024 GB 时显示 TB（保留 2 位小数），否则显示 GB（保留 1 位小数）
  - 示例：`512.3 GB`，`1.25 TB`
- 数字颜色：默认 `var(--text)`

### 3.4 Card 3: 活跃告警

| Property | Value |
|----------|-------|
| Icon | `icons.bell` |
| Label | "活跃告警" |
| Value | Unread alert count from `GET /api/alerts` |
| Subtitle | "X 条未处理" |

- 数字颜色：`> 0` 时 `var(--destructive)`，否则 `var(--text)`

### 3.5 Card 4: AI 分析总数

| Property | Value |
|----------|-------|
| Icon | `icons.brain` |
| Label | "AI 分析" |
| Value | Today's AI analysis count from `GET /api/dashboard/ai-stats` |
| Subtitle | "今日累计 X 次分析" |

- 聚合维度：当日零点起的 `ai_analysis_cache` 表计数（RCA、故障诊断、SQL 审核、容量预测等全部 AI 功能）
- 数字颜色：默认 `var(--text)`

---

## 4. Health Status Cards Row (4 Cards)

### 4.1 Card Structure

```css
.health-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card);
  cursor: pointer;
  transition: box-shadow 0.2s ease;
}

.health-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}
```

### 4.2 Card Columns

| Card | Icon | Style | Value Color | Filter Param |
|------|------|-------|-------------|--------------|
| 健康 | `icons.checkCircle` | `--ok` / `--ok-subtle` | `var(--ok)` | `?health=healthy` |
| 警告 | `icons.alertTriangle` | `--warn` / `--warn-subtle` | `var(--warn)` | `?health=warning` |
| 异常 | `icons.alertCircle` | `--danger` / `--danger-subtle` | `var(--destructive)` | `?health=critical` |
| 离线 | `icons.xCircle` | `--muted` / `--bg-elevated` | `var(--muted)` | `?health=offline` |

### 4.3 Design Per Card

```
┌──────────────────────────────┐
│ [icon]  [status label]       │
│         [large count]        │
└──────────────────────────────┘
```

- 每张卡片包含：
  - 左侧：状态色圆角背景图标（24px × 24px，使用相应状态色 + 对应透明度背景）
  - 右侧上方：状态文字标签（如"健康实例"、"警告实例"、"异常实例"、"离线实例"），`font-size: 14px`，`font-weight: 600`，`color: var(--text)`
  - 右侧下方：大数字计数，`font-size: 28px`，`font-weight: 700`
- 点击卡片 → `slide-navigate` 跳转 `instances-db` 页面，URL 附带对应过滤参数

### 4.4 Offline Detection

- `instance.health_status === null` 或 `last_health_check_at` 超过 5 分钟未更新 → 判定为离线
- 通过 `include_offline: true` 参数调用 `GET /api/database/instances` 获取所有实例（含未激活/无健康检查记录的）

---

## 5. Charts Row

### 5.1 DB Type Distribution Pie Chart (Left)

**Data Source:** `GET /api/database/instances` → 前端按 `db_type` 字段分组计数

**Implementation:** 内联 ECharts 实例（不复用 `<metric-chart>`）

**Config:**
```js
{
  tooltip: {
    trigger: 'item',
    formatter: '{b}: {c} 台 ({d}%)'
  },
  legend: {
    orient: 'vertical',
    right: 10,
    top: 'center'
  },
  series: [{
    type: 'pie',
    radius: ['40%', '65%'],  // 环形饼图
    avoidLabelOverlap: true,
    itemStyle: {
      borderRadius: 4,
      borderColor: 'var(--card)',
      borderWidth: 2
    },
    label: {
      show: false
    },
    emphasis: {
      label: {
        show: true,
        fontSize: 13,
        fontWeight: 'bold'
      }
    }
  }]
}
```

**Colors (ECharts palette):**
- MySQL: `#4CAF50` (green)
- PostgreSQL: `#336791` (blue)
- Oracle: `#E53935` (red)
- 达梦: `#FF9800` (orange)
- 其他: `#9E9E9E` (grey)

**Chart wrapper:**
```css
.chart-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}

.chart-card__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 12px;
}
```

**Interactions:**
- **Hover tooltip:** 显示类型名、实例数、占比百分比
- **Click slice:** `this._navigateTo("instances-db?db_type=mysql")` — 跳转实例列表并按该 DB 类型过滤

**Empty state:** 饼图中央显示 "暂无数据库实例"
- ECharts `graphic` 配置在中心显示提示文字
- 或通过 `title.text` 占位

**Loading state:** Chart area shows spinner text "加载中..."

### 5.2 Data Volume Trend Chart (Right)

**Data Source:** `GET /api/dashboard/capacity-trend?hours=168`

**Implementation:** 内联 ECharts 实例

**Config:**
```js
{
  tooltip: {
    trigger: 'axis',
    formatter: function(params) {
      const p = params[0];
      return `${p.axisValue}<br/>${p.marker} 数据量: ${p.value.toFixed(1)} GB`;
    }
  },
  grid: {
    left: 60,
    right: 20,
    top: 10,
    bottom: 30
  },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    axisLine: { lineStyle: { color: 'var(--border)' } }
  },
  yAxis: {
    type: 'value',
    axisLabel: {
      formatter: '{value} GB'
    },
    splitLine: {
      lineStyle: { color: 'var(--border)', type: 'dashed' }
    }
  },
  series: [{
    type: 'line',
    smooth: true,
    symbol: 'none',
    areaStyle: {
      opacity: 0.15
    },
    lineStyle: {
      width: 2
    },
    itemStyle: {
      color: '#7c5cff'  // accent color
    }
  }]
}
```

**Header controls:**
```
┌─────────────────────────────────────────────────┐
│  数据量趋势        ┌────┬────┬────┐ ┌──────────┐│
│  当前总量: X.X TB  │24h │7d  │30d │ │ [date] → ││
│                    └────┴────┴────┘ └──────────┘│
└─────────────────────────────────────────────────┘
```

- **Summary line:** "当前总量: X.X TB/GB" — 取容量趋势端点返回的当前值
- **Time preset buttons:** 24h / 7d (default) / 30d — 点击切换对应小时数
- **Date range picker:** 原生 `<input type="date">` 起止选择器（额外选项，不覆盖预设按钮）
- **Instance filter:** 原生 `<select>` 下拉，默认 "全部实例"，填充已加载的实例列表；选择单个实例时重新请求该实例的容量历史

**Empty state:** "暂无容量数据，请确保监控采集已启用"
- ECharts `graphic` 在图表中央显示
- 当返回的 `data` 数组为空时触发

**Loading state:** Chart area spinner text "加载中..."

---

## 6. Quick Actions Row

**保留现有内容**，不做功能改动。仅做 CSS 变量迁移。

Three action cards:
1. "管理实例" → `instances-db`
2. "查看告警" → `alerts`
3. "生成报表" → `reports`

---

## 7. Bottom Panels Row

**保留现有内容**，不做功能改动。仅做 CSS 变量迁移。

### 7.1 Left Panel: 待处理告警

- 显示最近 3 条未确认告警
- 空状态: "暂无未处理告警" + "系统运行正常"
- "查看全部" 导航到 alerts

### 7.2 Right Panel: 实例健康状态

- 当前实例健康状态的概要列表
- 空状态: "暂无实例健康数据"
- "查看全部" 导航到 instances-db

---

## 8. States

### 8.1 Loading State

```
┌──────────────────────────────────────────────┐
│                                              │
│              [spinner icon]                   │
│               加载中...                        │
│                                              │
└──────────────────────────────────────────────┘
```

- 全页加载时：整个仪表盘内容替换为居中 loading 指示器
- 图表区域加载时：ECharts 显示 loading 动画 (`myChart.showLoading()`)
- CSS: `display: flex; align-items: center; justify-content: center; min-height: 300px; color: var(--muted);`

### 8.2 Error State

- 保持现有仪表盘错误处理模式：
  - `fetch` 失败时捕获异常，设置 `this.error = err.message`
  - 渲染时 `if (error) → html`<div class="error">${this.error}</div>``
  - 错误容器：居中显示，使用 `var(--destructive)` 颜色
- **部分组件错误**（如仅图表加载失败）：在图表容器内显示错误提示，不影响其他区域
- **全局错误**（实例列表加载失败）：显示完整错误替换仪表盘内容

### 8.3 Empty States

| Component | Empty Text |
|-----------|-----------|
| Pie chart (no instances) | "暂无数据库实例" |
| Trend chart (no capacity data) | "暂无容量数据，请确保监控采集已启用" |
| Health cards (no instances) | "暂无实例健康数据" |
| Alerts panel (no unread alerts) | "暂无未处理告警" + "系统运行正常" |

---

## 9. Error Handling Pattern

保持现有仪表盘的统一错误提示风格：

```typescript
// Error display (existing pattern)
.error-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  color: var(--destructive);
}
```

- 全局加载失败：完整页面居中错误提示
- 部分数据失败：若统计卡片或图表的数据源失败，在该组件内部显示错误，不影响其他正常区域

---

## 10. CSS Variables Migration

### 10.0 Color Strategy (60/30/10)

- **60% Neutral backgrounds:** `var(--card)`, `var(--bg-elevated)`, `var(--border)` — page surface, card fills, dividers
- **30% Text & borders:** `var(--text)`, `var(--muted)`, `var(--border)` — primary/secondary text, structural lines
- **10% Accent & status:** `var(--accent)`, `var(--ok)`, `var(--warn)`, `var(--destructive)` — interactive highlights, health indicators

### 10.1 Complete Replacement Map

| Hardcoded Value | CSS Variable | Usage Locations |
|----------------|--------------|-----------------|
| `#e5e5ea` | `var(--border)` | Card borders, dashed borders |
| `#ffffff` | `var(--card)` | Card backgrounds |
| `#1a1a1e` | `var(--text)` | Primary text, card values |
| `#6e6e73` | `var(--muted)` | Hint text, labels, secondary text |
| `#f8f9fa` | `var(--bg-elevated)` | Status item backgrounds, empty state bg |
| `#f1f3f5` | `var(--border)` or `var(--bg-elevated)` | Card header borders, hover backgrounds |
| `#7c5cff` | `var(--accent)` | Hover states, "查看全部" links |
| `#15803d` | `var(--ok)` | Healthy status, success badges |
| `#b45309` | `var(--warn)` | Warning status |
| `#dc2626` | `var(--destructive)` | Critical/danger status, error text |
| `#2563eb` | `var(--info)` | Info text |
| `rgba(124,92,255,0.1)` | `var(--accent-subtle)` | Action card icon bg, hover bg |
| `rgba(124,92,255,0.12)` | `var(--accent-subtle)` | Action card hover shadow |
| `rgba(124,92,255,0.15)` | `var(--accent-subtle)` | Action card icon border |

### 10.2 Status Badge Colors

| State | Background | Text |
|-------|-----------|------|
| ok | `rgba(var(--ok-rgb), 0.1)` | `var(--ok)` |
| warn | `rgba(var(--warn-rgb), 0.1)` | `var(--warn)` |
| danger | `rgba(var(--destructive-rgb), 0.1)` | `var(--destructive)` |

---

## 11. Data Flow

### 11.1 Parallel Data Loading

```typescript
// On firstUpdated()
const [instancesRes, alertsRes, capacityRes, aiStatsRes] = await Promise.all([
  fetch("/api/database/instances"),
  fetch("/api/alerts"),
  fetch("/api/dashboard/capacity-trend?hours=168"),
  fetch("/api/dashboard/ai-stats"),
]);
```

- **实例列表** — 统计卡片（实例总数）、饼图（DB 类型分布）、健康状态卡片（健康/警告/异常/离线计数）、底部面板（实例健康状态列表）
- **告警数据** — 统计卡片（活跃告警计数）、底部面板（待处理告警列表）
- **容量趋势** — 统计卡片（数据总量）、趋势图
- **AI 统计** — 统计卡片（今日分析总数）

### 11.2 Instance Filter → Trend Chart

当用户切换实例下拉选择器时：

```typescript
const url = selectedInstanceId
  ? `/api/database/instances/${selectedInstanceId}/metrics/capacity?hours=${this.selectedHours}`
  : `/api/dashboard/capacity-trend?hours=${this.selectedHours}`;
```

### 11.3 Auto-refresh

- 所有数据在 `firstUpdated()` 时首次加载
- 后续可通过手动刷新按钮触发重新加载（可选，Claude's Discretion）

---

## 12. New Backend Endpoints

### 12.1 `GET /api/dashboard/capacity-trend`

**Purpose:** 跨所有活跃实例按时间聚合 `total_size_gb`

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | number | 168 | 统计最近多少小时的数据 |
| `instance_id` | number | null | 指定实例（为空则全库汇总） |

**Response:**
```json
{
  "current_total_gb": 512.3,
  "time": ["2026-05-04 00:00", "2026-05-05 00:00", ...],
  "data": [480.2, 495.1, 512.3, ...]
}
```

### 12.2 `GET /api/dashboard/ai-stats`

**Purpose:** 从 `ai_analysis_cache` 表聚合当日 AI 分析计数

**Query Parameters:** 无

**Response:**
```json
{
  "today_count": 42
}
```

**Aggregation Logic:**
```sql
SELECT COUNT(*) as today_count
FROM ai_analysis_cache
WHERE created_at >= CURDATE()
```
- 包含所有 `analysis_type`（RCA、故障诊断、TopSQL、容量预测等）

---

## 13. Transition: Removal of QPS Trend

- 移除仪表盘底部的 QPS 趋势图（原 `<metric-chart>` 引用）
- 对应删除 `qpsTrend` state、获取 QPS 趋势数据的代码块（`loadDashboardData` 末尾部分）
- 对应删除 metricsSummary 中的 QPS/connections 聚合逻辑（轮询所有健康实例 `/metrics` 的代码）
- `metricsSummary` interface 移除

---

## 14. Implementation Notes

1. **Inline ECharts:** 使用 `import * as echarts from "echarts"` 直接创建实例，不经过 `<metric-chart>` 组件
2. **ECharts resize:** 在 `firstUpdated()` 和窗口 `resize` 事件中调用 `chart.resize()`，同时考虑 `ResizeObserver` 以处理容器大小变化
3. **Pie click:** ECharts `click` 事件通过 `this._navigateTo` 导航
4. **Health card click:** 通过 Lit `@click` 事件绑定，调用 `this._navigateTo("instances-db?health=healthy")`
5. **Loading orchestration:** 全页 loading 由 `this.loading` 控制；图表 loading 由 ECharts `.showLoading()` 独立控制
6. **CSS variable fallback:** 对于较新的变量（如 `--accent-subtle`），在 `:host` 或根级别提供 fallback 值
