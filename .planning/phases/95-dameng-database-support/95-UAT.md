---
status: testing
phase: 95-dameng-database-support
source: 95-01-SUMMARY.md, 95-02-SUMMARY.md
started: 2026-05-18T01:34:00Z
updated: 2026-05-18T01:34:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Backend health check + TypeScript compilation
expected: 后端运行正常，TypeScript 编译无 Phase 95 引入的新错误。
result: pass

### 2. 新建达梦实例并测试连接
expected: 实例管理中选择"达梦"类型，填写连接信息，测试连接成功，保存成功。
result: issue
reported: "测试连接报错 dmdb.getConnection is not a function → DB ENUM 缺少 dameng → 视图/列名不匹配"
severity: blocker

### 3. test_connection AI Agent tool supports dameng
expected: test_connection.ts db_type enum 包含 'dameng'，快速路径 conn.dmConnection 检查。
result: pass

### 4. 达梦实例健康检查
expected: 实例状态显示 healthy (100)，版本号显示正确。
result: pass

### 5. 达梦实例指标采集
expected: 指标详情页显示 CPU、内存、连接数、QPS、TPS、缓冲池命中率等。
result: pass

### 6. 达梦实例活动会话
expected: 会话列表显示活跃会话，包含用户、来源IP、SQL文本。
result: pass

### 7. 达梦实例容量信息
expected: 容量页面显示表空间和段信息。
result: pass

### 4. Metric registry includes dameng in 7 common metrics
expected: metric-registry.ts 中 cpu_usage, memory_usage, disk_usage, connections, qps, tps, health_score 的 db_types 数组包含 'dameng'。
result: [pending]

### 5. getSchemaObjects supports Dameng via ALL_TAB_COLUMNS
expected: database-service.ts 中 getSchemaObjects() 方法有 dameng 分支，查询 ALL_TAB_COLUMNS，过滤 SYS/SYSDBA/SYSAUDITOR。
result: [pending]

### 6. Dameng SQL dialect defined in sql-console.ts
expected: sql-console.ts 中有 DamengDialect 定义（SQLDialect.define），包含 V$DM_* 视图、DM_SQL_* 函数、caseInsensitiveIdentifiers: true。
result: [pending]

### 7. Dameng connection requires live DM8 instance
expected: 需要一个运行中的达梦 DM8 数据库实例来验证连接、指标采集、健康检查、活动会话、容量信息等功能。没有可达的 Dameng 实例时无法完整验证。
result: [pending]

## Summary

total: 7
passed: 6
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "达梦实例测试连接使用 dmdb 驱动（非 oracledb）"
  status: resolved
  reason: "测试连接→dmdb.getConnection fail→DB ENUM missing→视图/列名不匹配。共修复6处：ESM import .default、NODE_OPTIONS legacy provider、server.ts database fallback、V$BUFFERPOOL/BLOCKED/STATE/STAT_VAL/SVR_VERSION/V$SQL_HISTORY"
  severity: blocker
  test: 2
  root_cause: "dmdb ESM import缺.default + OpenSSL 3.0 + DB schema ENUM缺少dameng + DM8视图名/列名与Oracle不同"
  artifacts:
    - path: "apps/db-ops-api/src/instance-database-service.ts"
      issue: "const dmdb = await import('dmdb') 应为 const dmdb = (await import('dmdb')).default"
    - path: "apps/db-ops-api/server.ts"
      issue: "dameng/oracle实例database fallback为'mysql'导致dmdb schema参数错误"
    - path: "apps/db-ops-api/src/database-service.ts"
      issue: "V$BUFFER_POOL_STATISTICS→V$BUFFERPOOL, BLOCK→BLOCKED, STATUS→STATE, VALUE→STAT_VAL, VERSION→SVR_VERSION, V$SQLAREA→V$SQL_HISTORY, V$MEMORY_INFO→V$SYSSTAT"
  missing: []
  debug_session: ""
