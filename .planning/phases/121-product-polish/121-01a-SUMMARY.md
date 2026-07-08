---
phase: 121-product-polish
plan: 01a
status: complete
tasks_completed: 2/2
started: 2026-06-24T15:35:36Z
completed: 2026-06-24T16:22:00Z
bug_fixes: 2026-06-25
---

# 121-01a Summary: 闭环健康中心 — 后端一致性检查 API

## What was built
创建了 `GET /api/health/consistency` 端点，提供 10 项跨表完整性检查 + 系统准备度状态。

### Key files created
- `apps/db-ops-api/src/consistency-checker.ts` (634 lines) — ConsistencyChecker 类，包含：
  - 10 个独立检查方法（instance_count, capacity_sum, metrics_freshness, alert_rule_refs, event_member_status, rbac_orphans, cron_hung_jobs, chat_session_stats, approval_event_integrity, notification_closure）
  - `_checkSafe()` 错误隔离包装器（单个检查失败不崩溃整个端点）
  - `_checkReadiness()` 系统准备度（db_connected, db_reachable, llm_provider, cron_running, agent_engine TCP）
  - 所有 SQL 查询使用参数化 `pool.execute(sql, [])`

### Key files modified
- `apps/db-ops-api/server.ts` — 注册 `GET /api/health/consistency` 路由，带 `{ preHandler: [verifyToken] }` 认证；新增 `POST /api/monitor/collect-capacity` 手动触发容量采集
- `apps/db-ops-api/src/consistency-checker.test.ts` (140 lines) — 11 个单元测试覆盖 checkSafe 包装、runAllChecks 响应形状、通知延迟检查、实例计数、告警引用、错误隔离

### Verification
- `npx vitest run src/consistency-checker.test.ts` — 11/11 passed
- `grep -c 'checkSafe'` → 11 (10 calls + 1 definition)
- `grep -c 'notification_closure'` → 2 (method + _checkSafe call)
- Route registered with `preHandler: [verifyToken]`

### Deviations
None.

## Bug Fix: Oracle 容量口径统一 (2026-06-25)

健康中心发现 oracle1521 容量数据不一致（DB 1.98GB vs 采集 0.08GB，差异 +2375%）。

### 根因
多个 Oracle 容量查询口径不一致：
- `checkOracleHealth()` — `SUM(bytes) FROM DBA_DATA_FILES`（数据文件总大小，无过滤）
- `getOracleCapacity()` — 排除 SYSTEM/SYSAUX 后的 `SUM(bytes)`（用户表空间数据文件大小）
- `oracle.provider.ts` — 两处指标查询也排除 SYSTEM/SYSAUX

### 修复
1. **新增共享方法** `_queryOracleTablespaceUsage()` — 统一查询所有表空间（含系统）的实际用量（数据文件 - 空闲空间）
2. **统一所有消费者** — 健康检查、容量采集、指标采集都使用相同逻辑
3. **去掉 SYSTEM/SYSAUX 过滤** — 用户关心的是总占用，不是"用户数据占用"

### 修改文件
- `apps/db-ops-api/src/database-service.ts` — 新增 `_queryOracleTablespaceUsage()`，更新 `checkOracleHealth()` 和 `getOracleCapacity()`
- `apps/db-ops-api/src/collectors/oracle.provider.ts` — 去掉 `memory_usage` 和 `disk_usage`/`tablespace_usage` 的 SYSTEM/SYSAUX 过滤

### 验证结果
- 健康度：89% → **100%**
- 容量数据一致性：warn → **pass**（实例总容量 5.7GB 与容量历史 5.7GB 一致）
- oracle1521 差异警告消失

## Self-Check: PASSED
