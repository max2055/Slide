# Phase 105: 数据质量 - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning

## Phase Boundary

实现实例多维度健康评分的计算、展示和趋势追踪，新增采集能力自动检测，展示健康检查逐项详情。

## Implementation Decisions

### 评分算法
- **D-01:** 多维度加权评分：availability (0.35) + performance (0.35) + capacity (0.20) + security (0.10)。权重可配置。
- **D-02:** 权重存储在配置中（新增配置 JSON 或 metric_definitions 扩展），前端设置页面可编辑。

### 评分趋势图
- **D-03:** 在实例详情页新增「健康评分」tab，折线图展示 health_check_history 的趋势。支持可配置时间范围（24h/7d/30d）。

### 采集能力检测
- **D-04:** 自动检测。基于 metric_definitions 的 db_types + 实际采集成功/失败状态，自动判断每个指标对当前实例是否可用。前端显示 green/grey 状态标签。

### 健康逐项详情
- **D-05:** 在实例详情页展示最近一次健康检查的逐项结果（连接状态 ✓、慢查询 ✗ 等），可折叠展开。数据来源 health_check_history.checks JSON。

### Claude's Discretion
- 评分维度内的具体检查项映射由 Agent 根据现有 checkXxxHealth() 方法确定
- 图表库选择：复用现有 dashboard 中的 Chart.js 或同等轻量方案

## Canonical References

### 健康检查
- `apps/db-ops-api/src/database-service.ts` — checkMySQLHealth/checkPostgreSQLHealth/checkOracleHealth/checkDamengHealth（当前 deduct-from-100 算法）
- `apps/db-ops-api/src/instance-database-service.ts:433` — updateHealthStatus()（写入 database_instances.health_score）
- `apps/db-ops-api/src/instance-database-service.ts:463` — recordHealthCheck()（写入 health_check_history）
- `apps/db-ops-api/src/monitor-collector.ts:281` — updateHealthStatusFromCheck()（周期性调用入口）
- `apps/db-ops-api/sql/schema.sql:161` — health_check_history 表定义

### 前端
- `frontend/src/openclaw/ui/views/instance-detail.ts` — 实例详情页（当前无健康 tab，无逐项详情）
- `frontend/src/openclaw/ui/views/dashboard.ts` — 仪表盘（评分趋势可参考现有趋势图）

### 指标定义
- `apps/db-ops-api/src/metric-registry.ts` — 预定义指标和 db_types 映射
- `apps/db-ops-api/sql/schema.sql:85` — database_instances 表（health_score/health_status 列）

## Existing Code Insights

### Reusable Assets
- `instance-database-service.ts` 的 `getHealthCheckHistory()` 方法已存在（line 488），可直接暴露 API
- health_check_history.checks JSON 已存储逐项检查结果，无需改写入逻辑
- 现有趋势图组件可复用

### Integration Points
- 评分算法替换 checkXxxHealth() 中的 deduct-from-100 为多维度加权
- 新增 API: GET /api/database/instances/:id/health-history, GET /api/database/instances/:id/health-checks
- 采集能力检测需读取 metric_definitions + 实际采集状态
- 实例详情页新增 tab + 健康逐项区域

## Deferred Ideas

None.

---

*Phase: 105-数据质量*
*Context gathered: 2026-05-21*
