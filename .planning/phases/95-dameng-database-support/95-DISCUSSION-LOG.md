# Phase 95: Dameng Database Support — Discussion Log

**Date**: 2026-05-17
**Mode**: Interactive

## Gray Areas Discussed

### 1. SQL 方言支持
- **Question**: 达梦 SQL 方言适配策略？
- **Options**: 复用 Oracle 模式 | 达梦专用模式 | 两阶段先用 Oracle
- **Selected**: **达梦专用模式** — 创建 Dameng-specific CodeMirror 语法规则，包含 V$DM_* 系统视图和 DM_SQL_* 函数高亮

### 2. 指标采集深度
- **Question**: 达梦指标采集的深度？
- **Options**: 对标 MySQL（6-8 核心指标）| 完整达梦指标（15-20 个）
- **Selected**: **对标 MySQL** — 连接数、QPS、TPS、缓存命中率、表空间使用率

### 3. 实例详情 UI
- **Question**: 达梦实例详情页布局？
- **Options**: 复用现有布局 | 增加达梦专属 tab
- **Selected**: **复用现有布局** — 与 MySQL/PostgreSQL 一致，数据来源换达梦

### 4. AI Agent 工具对接
- **Question**: AI agent 工具是否支持达梦？
- **Options**: 不对接 | 对接所有工具
- **Selected**: **对接所有 agent 工具** — db_health_check、db_performance_analysis 等全部支持达梦

### 5. 驱动选型
- **Question**: Node.js 驱动选型？
- **Options**: 达梦官方 Node.js 驱动 | 复用 oracledb
- **Selected**: **达梦官方 Node.js 驱动** — 替换现有 oracledb 实现

### 6. 功能范围
- **Question**: 达梦支持的深度？
- **Options**: 基础纳管 | 全覆盖（含 Slow Query + QAN）
- **Selected**: **基础纳管** — 连接、指标、SQL 控制台、实例详情

## Deferred Ideas
- Slow Query 慢查询分析 → 后续单独 Phase
- QAN 查询分析 → 后续单独 Phase
- PSE 会话管理 / HUGE 表监控 → 低优先级

## Self-Check
- [x] 6 gray areas discussed and resolved
- [x] Decisions captured in CONTEXT.md
- [x] No scope creep — deferred ideas logged
- [x] Codebase scouted — existing partial implementation identified
