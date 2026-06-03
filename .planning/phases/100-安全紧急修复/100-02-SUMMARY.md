---
phase: 100
plan: 02
subsystem: backend
tags: [monitor-collector, alerts, health-score, code-cleanup, bug-fix]
requires: []
provides: [SEC-03, SEC-04]
affects: [monitor-collector, report-service, vitest-config]
tech-stack:
  added: []
  patterns:
    - "checkHealth() for real-time health score instead of hardcoded 100"
    - "alert-engine as single alert origin (checkAlerts removed)"
key-files:
  created:
    - apps/db-ops-api/tests/monitor-collector.test.ts
  modified:
    - apps/db-ops-api/src/monitor-collector.ts
    - apps/db-ops-api/src/report-service.ts
    - apps/db-ops-api/vitest.config.ts
decisions:
  - "checkAlerts() removed: alert-engine is the sole alert creation entry point"
  - "health_score computed via databaseService.checkHealth() instead of hardcoded 100"
  - "vitest.config include updated to support tests/ directory"
metrics:
  duration: "~5 min"
  completed_date: "2026-05-20"
---

# Phase 100 Plan 02: 移除重复告警和修复虚假健康评分

monitor-collector 中的 checkAlerts() 方法移除，3 处硬编码 health_score: 100 替换为 databaseService.checkHealth() 实际计算值。

## 变更内容

### Task 1: monitor-collector 清理

**Files modified:** `apps/db-ops-api/src/monitor-collector.ts`, `apps/db-ops-api/tests/monitor-collector.test.ts`, `apps/db-ops-api/vitest.config.ts`

- 删除 checkAlerts() 方法（L311-341）及上方注释段（L309）
- 删除 collectInstanceMetrics 中的 2 处 checkAlerts 调用（metrics 成功路径 + retryMetrics 成功路径）
- 替换 2 处 `updateHealthStatus(instance.id, 100, 'healthy')` 为 databaseService.checkHealth() 获取实际评分
- 删除 `import { alertDatabaseService }`（checkAlerts 为其唯一使用者）
- 清理测试文件中的 `vi.mock('../src/alert-database-service')` 块
- vitest.config.ts 增加 `tests/**/*.test.ts` 到 include 模式

### Task 2: report-service 修复

**Files modified:** `apps/db-ops-api/src/report-service.ts`

- collectHealthMetrics() 方法中 `health_score: 100` 替换为 `databaseService.checkHealth(instanceId)?.health_score ?? 0`
- `health_status: 'healthy'` 替换为 `databaseService.checkHealth(instanceId)?.status ?? 'unknown'`
- 移除 TODO 注释

## 测试结果

4 个 pre-existing 测试失败（全为 `status.jobs` 属性不存在问题）：
- getStatus() 返回的 object 不含 jobs 属性，测试文件编写于 setInterval 实现之前的 cron 版本
- 本任务未引入新测试失败

## 验证检查

| 检查项 | 结果 |
|--------|------|
| checkAlerts 不在 source 中出现 | PASS (0 hits) |
| health_score: 100 不在任意文件出现 | PASS (0 hits) |
| alertDatabaseService 引用已清除 | PASS (0 hits in source + test) |
| test 文件存在且可运行 | PASS |
