# Phase 95: Dameng Database Support - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning

## Phase Boundary

为 Slide 添加达梦数据库（DM8）的完整基础纳管能力：连接管理、指标采集、SQL 控制台、实例详情。代码库已有达梦类型定义、连接测试（oracledb）和前端表单选项，本阶段将其升级为完整支持。

**In scope**: 连接管理、指标采集（对标 MySQL 6-8 核心指标）、SQL 控制台（达梦专用 CodeMirror 模式）、实例详情页、AI agent 工具对接。

**Out of scope**: Slow Query 慢查询分析、QAN 查询分析 — 达梦慢查询视图与 MySQL 差异大，后续单独规划。

## Implementation Decisions

### SQL 方言支持
- **D-01:** 达梦专用 CodeMirror 模式 — 不使用 Oracle 模式。需包含达梦特有系统视图（V$DM_*）、函数（DM_SQL_*）和保留字的精确高亮。

### 指标采集
- **D-02:** 对标 MySQL 指标集 — 连接数、QPS、TPS、缓存命中率、表空间使用率等 6-8 个核心指标。不需要 PSE 会话、HUGE 表等高级指标。

### 实例详情 UI
- **D-03:** 复用现有 MySQL/PostgreSQL 详情布局 — 概览、监控、TopSQL、慢查询、容量、会话六个 tab。数据换达梦来源即可，不增加达梦专属标签页。

### AI Agent 工具
- **D-04:** 所有现有数据库工具（db_health_check、db_performance_analysis 等）支持达梦实例。需要修改工具的 db_type 判断逻辑，将 dameng 纳入支持范围。

### 驱动选型
- **D-05:** 使用达梦官方 Node.js 驱动替代 oracledb。当前连接测试和指标采集使用了 oracledb（利用达梦 Oracle 兼容模式），需要替换为官方驱动以获得完整的达梦功能支持和更好的兼容性。

### 功能范围
- **D-06:** 基础纳管范围 — 连接管理、指标采集、SQL 控制台、实例详情。不包括 Slow Query 和 QAN。

### Claude's Discretion
- 达梦默认端口 5236（前端已有），db_type 标识使用 'dameng'
- 达梦模式名称在 CodeMirror 中使用 'dameng'

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Dameng Implementation
- `apps/db-ops-api/src/instance-database-service.ts` — db_type 类型（含 'dameng'）、连接测试逻辑（当前用 oracledb）
- `apps/db-ops-api/src/database-service.ts` — 连接池管理、getDamengMetrics() 方法、达梦指标采集骨架
- `apps/db-ops-api/src/sql-executor.ts` — conn.db_type === 'dameng' 分支处理
- `apps/db-ops-api/src/monitor-collector.ts` — 采集调度，需要确认达梦已纳入采集循环
- `frontend/src/openclaw/ui/views/instances-db.ts` — 前端添加实例表单（达梦选项、端口 5236）
- `frontend/src/openclaw/ui/views/instance-detail.ts` — 实例详情页布局参考
- `frontend/src/api/database.ts` — 前端 API 类型（含 'dameng'）

### Patterns
- MySQL 和 PostgreSQL 的完整流程可作为达梦实现的参考模板

## Existing Code Insights

### Reusable Assets
- **instance-database-service.ts 的 db_type 联合类型**: 已含 'dameng'，无需修改
- **database-service.ts 的 getDamengMetrics()**: 已有骨架，需要替换 oracledb 为官方驱动
- **sql-executor.ts 的 db_type 分支**: 已有 conn.db_type === 'dameng' 分支
- **前端 instances-db.ts**: 达梦选项和默认端口已就绪

### Established Patterns
- MySQL 数据库的测试连接 → 连接池 → 指标采集 → 实例详情的完整链路可作为模板
- 每种数据库类型在 sql-executor.ts 中都有对应的方言分支
- monitor-collector.ts 按 db_type 调度采集

### Integration Points
- `sql-executor.ts` — 需要达梦 CodeMirror 模式 + SQL 执行适配
- `monitor-collector.ts` — 确保达梦在采集循环中
- `database-service.ts` — 替换 oracledb 为官方驱动
- `frontend/src/openclaw/ui/views/instance-detail.ts` — 确认达梦数据能正确渲染
- Agent 工具文件（`tools/generated/slide-self-mgmt/`）— 需要更新 db_type 支持

## Specific Ideas

- 如果要为达梦 CodeMirror 创建专用的 mode，可以参考 CodeMirror 的 Oracle SQL mode 扩展达梦关键字
- 达梦官方驱动文档参考：https://eco.dameng.com/document/dm/zh-cn/pm/nodejs-brief-connection.html

## Deferred Ideas

- **Slow Query 分析**: 达梦的 V$SQL_HISTORY 视图与 MySQL slow_query_log 差异大，需要单独的 Phase 或子阶段
- **QAN 查询分析**: 同上，后续规划
- **PSE 会话管理 / HUGE 表监控**: 达梦高级特性，当前版本不需要

---

*Phase: 95-dameng-database-support*
*Context gathered: 2026-05-17*
