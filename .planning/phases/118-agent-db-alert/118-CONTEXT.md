---
phase: 118
name: agent-db-alert
status: context
created: 2026-06-08
---

## Phase 118: Agent DB 连接 + 告警机制完善

### Goal
1. Agent 可以通过工具获取数据库实例连接信息，从而连接数据库进行分析
2. 告警采集和触发机制彻底完善 — 该触发时触发，不该触发时不误报

### Current State

**Agent DB 连接问题**:
- Agent 目前只能访问 `metrics_history` 和 `alerts` 数据
- 缺少让 Agent 获取实例连接字符串（host/port/user/password/db_type）的工具
- 现有的 `slide-self-mgmt` 工具集不包含 DB 连接查询

**告警系统当前 Bug**:
1. `_availability` 误报: 健康实例（达梦/mysql/oracle）每 15min 触发一次可用性告警，5min stale 阈值太短
2. QPS 阈值修改未生效: 规则阈值 30000 但 Oracle QPS~888 仍在触发告警（54条），说明 `resolveDynamicThreshold()` 覆盖了规则阈值
3. API 字段缺失: API 返回的 `metric_name` 为 null，但 DB 中有值
4. mysql-3308/pg 的可用性告警（95106/95107）已 4 天未处理，缺少告警升级通知

### Requirements
R1: Agent 工具新增 `list_database_instances` 和 `get_instance_connection` 两个工具
R2: 修复 `_availability` 误报（stale 阈值调整为 3 倍采集间隔而非固定 5min）
R3: 修复 `resolveDynamicThreshold()` 覆盖规则阈值导致 QPS>30000 不生效
R4: 修复 API 返回 `metric_name` 为 null
R5: 告警升级/通知机制（可选，后续迭代）
