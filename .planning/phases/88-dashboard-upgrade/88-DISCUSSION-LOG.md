# Phase 88: Dashboard Upgrade - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-11
**Phase:** 88-dashboard-upgrade
**Areas discussed:** DB 类型分布图表, 数据量趋势图表, 健康状态卡片设计, 统计卡片重新设计, CSS Grid 布局重组

---

## DB Type Distribution Chart (DASH-01)

| Option | Description | Selected |
|--------|-------------|----------|
| 饼图 (Pie) | ECharts 饼图，按实例数显示各 DB 类型占比 | ✓ |
| 柱状图 (Bar) | ECharts 柱状图，按实例数显示各类型计数 | |
| 饼图+柱状图组合 | 小饼图+柱状图，同时展示数量和占比 | |

**User's choice:** 饼图 (Pie)
**Notes:** 前端聚合 (复用 GET /api/database/instances)，展示所有类型不合并，悬停 tooltip + 点击扇区跳转实例列表

---

## Data Volume Trend Chart (DASH-02)

| Option | Description | Selected |
|--------|-------------|----------|
| 预设时间按钮切换 | 24h/7d/30d/90d 固定按钮 | ✓ |
| 日期范围选择器 | 自由选择起止时间 | ✓ |
| 你来判断 | Claude 决定交互方式 | |

**User's choice:** 预设按钮 + 日期范围选择器都要

| 数据聚合方式 | | |
|---|---|---|
| 全库汇总 | 所有实例容量总和 trend | |
| 分实例多条线 | 每个实例独立趋势线 | |
| 汇总+实例筛选 | 默认汇总，可下拉切换到单实例 | ✓ |

**User's choice:** 汇总+实例筛选

| 数据来源 | | |
|---|---|---|
| 新后端聚合端点 | 新增 GET /api/dashboard/capacity-trend | ✓ |
| 前端聚合 | 前端循环所有实例求和 | |
| 你来判断 | Claude 根据实例数量判断 | |

**User's choice:** 新后端聚合端点

| 图表实现 | | |
|---|---|---|
| 复用 metric-chart | 使用现有 `<metric-chart>` 组件 | |
| 内联 ECharts | dashboard 内直接创建 ECharts 实例 | ✓ |
| 扩展现有 metric-chart | 在 metric-chart 基础上增加 areaStyle 等选项 | |

**User's choice:** 内联 ECharts

| 视觉风格 | | |
|---|---|---|
| 折线+面积填充 | 折线图+半透明面积 | ✓ |
| 纯折线 | 纯折线无填充 | |

**User's choice:** 折线+面积填充，图表上方显示当前总量概要，替换 QPS 趋势图，空数据显示提示

---

## Stat Cards Redesign

**User's choice:** 4 张统计卡片调整为：实例总数 / 数据总量 / 活跃告警 / AI 分析总数
**Notes:** 移除连接数和 QPS（单实例指标对全局仪表盘无意义）。AI 分析总数需要新增后端统计端点。数据总量卡片复用 DASH-02 端点数据。

---

## Health Status Summary Cards (DASH-03)

| Option | Description | Selected |
|--------|-------------|----------|
| 概要卡片（大数字） | 4 张独立概要卡片，大数字+状态标签+图标 | ✓ |
| 保持现有列表样式 | 维持列表+小 badge | |
| 概要卡片+环形图 | 左侧卡片+右侧环形图 | |

**User's choice:** 概要卡片（大数字）
**Notes:** 离线通过健康检查超时判定。点击跳转+状态过滤。使用 CSS 变量系统。

---

## CSS Grid Layout (DASH-04)

| 选项 | 描述 | 选择 |
|------|------|------|
| 保留现有内容 | 统计卡片+快捷操作+告警面板保留 | ✓ |
| 重新设计 | 只保留统计卡片，移除旧内容 | |

**User's choice:** 保留现有内容

| 图表排列 | | |
|---|---|---|
| 两个图表并排 | 饼图左+趋势图右 | ✓ |
| 图表上下排列 | 图表堆叠占满 | |

**User's choice:** 两个图表并排

| 响应式断点 | | |
|---|---|---|
| 三档断点 | 1200px / 768px / 480px | ✓ |
| 两档断点 | 仅 768px | |
| 桌面端即可 | 不做响应式 | |

**User's choice:** 三档断点

| CSS 变量 | | |
|---|---|---|
| 全面 CSS 变量化 | 所有硬编码颜色替换为 CSS 变量 | ✓ |
| 新代码用变量 | 仅新增组件用变量 | |
| 渐进式迁移 | 逐步替换 | |

**User's choice:** 全面 CSS 变量化

**Notes:** 最终布局：统计卡片行 → 健康状态卡片行 → 图表行 → 快捷操作行 → 双栏面板行。统计卡片内容调整为实例总数/数据总量/活跃告警/AI分析总数。

---

## Claude's Discretion

- ECharts 图表具体配置（颜色方案、tooltip、动画）
- 响应式布局 CSS 实现
- CSS 变量映射细节
- 空/加载/错误状态 UI
- 健康检查超时阈值
- 饼图跳转 URL 参数格式
- 数据总量单位格式化逻辑
- AI 分析端点聚合逻辑

## Deferred Ideas

None
