---
phase: 105-数据质量
plan: 01
subsystem: backend
tags:
  - scoring
  - health-checks
  - collection-capabilities
  - api
requires: []
provides: [scoring-service, scoring-config-service, collection-capabilities]
affects:
  - apps/db-ops-api/src/database-service.ts
  - apps/db-ops-api/src/instance-database-service.ts
  - apps/db-ops-api/src/monitor-collector.ts
  - apps/db-ops-api/server.ts
tech-stack:
  added:
    - scoring-service.ts — 多维度加权评分算法
    - scoring-config-service.ts — system_config CRUD for scoring weights
    - collection-capabilities.ts — 内存级采集能力追踪器
  patterns:
    - ai-analysis-config-service 的 config CRUD 模式
    - metric-registry.getByDbType() for metric filtering
key-files:
  created:
    - apps/db-ops-api/src/scoring-service.ts
    - apps/db-ops-api/src/scoring-config-service.ts
    - apps/db-ops-api/src/collection-capabilities.ts
    - apps/db-ops-api/src/scoring-service.test.ts
    - apps/db-ops-api/src/scoring-config-service.test.ts
    - apps/db-ops-api/src/collection-capabilities.test.ts
  modified:
    - apps/db-ops-api/src/database-service.ts
    - apps/db-ops-api/src/instance-database-service.ts
    - apps/db-ops-api/src/monitor-collector.ts
    - apps/db-ops-api/server.ts
decisions:
  - Request-scoring inside _withAutoReconnect callback to access conn.db_type for dimension mapping
  - Neutral 100 for missing dimensions per DB type (instead of 0, avoiding artificially low scores)
  - recordMetricAttempt preserves available=true on transient failures if metric was previously successful
metrics:
  duration: 5 minutes
  completed_date: 2026-05-21
---

# Phase 105 Plan 01: 后端评分基础设施 Summary

实现后端评分基础设施：多维度加权评分算法、权重配置 CRUD、采集能力追踪、新 API 路由。

## Tasks

### Task 1: Create scoring-service.ts, scoring-config-service.ts, collection-capabilities.ts + unit tests

- **scoring-service.ts**: 导出 `calculateDimensionScores()` 和 `DIMENSION_MAP`。定义按 DB 类型的检查项→维度映射（mysql: 3项, postgresql: 4项, oracle: 5项, dameng: 5项）。缺失维度赋中性值 100，加权总分用 Math.round()
- **scoring-config-service.ts**: 遵循 ai-analysis-config-service 的 CRUD 模式。DEFAULT_WEIGHTS: availability 0.35, performance 0.35, capacity 0.20, security 0.10。`getWeights()` 从 system_config 读取并与默认值合并。`saveWeights()` 验证每项 0.0-1.0 且 sum ≈ 1.0
- **collection-capabilities.ts**: `CollectionCapabilityTracker` 类，内部 `Map<number, Map<string, AttemptRecord>>`。`recordMetricAttempt()` 记录采集尝试，`getCapabilities()` 合并 metric_registry 期望指标与实际状态。导出单例
- **测试**: 3 个 test 文件共 19 个测试全部通过

### Task 2: Modify database-service.ts checkHealth() and instance-database-service.ts methods

- **database-service.ts**: 在 `checkHealth()` 的 `_withAutoReconnect` 回调内部，获取权重后调用 `calculateDimensionScores()` 替换原有 health_score。HealthCheckResult 接口增加 `dimensions?` 可选字段
- **instance-database-service.ts**: 新增 3 个方法: `getHealthCheckHistoryWithChecks()` (含 checks JSON 解析), `getLatestHealthChecks()` (LIMIT 1), `getHealthScoreHistory()` (ASC 时间序)
- **monitor-collector.ts**: 在 `collectInstanceMetrics()` 的成功/失败/异常 3 个路径分别调用 `collectionCapabilityTracker.recordMetricAttempt()`

### Task 3: Register 5 new API routes in server.ts

- `GET /api/database/instances/:id/health-history` — 评分趋势（days 参数，max 90）
- `GET /api/database/instances/:id/health-checks` — 最新 checks 详情（无记录返回 `{ checks: [], status: 'unknown' }`）
- `GET /api/database/instances/:id/collection-capabilities` — 采集能力状态（需先获取实例的 db_type）
- `GET /api/scoring/config` — 获取权重（permission: `metric:view`）
- `PUT /api/scoring/config` — 更新权重（permission: `metric:manage`，返回验证错误）

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

None found — all new routes use existing preHandler/auth middleware patterns.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 6b7eaafb1b7 | Create 3 service files + 3 test files |
| 2 | 74d84d4981e | Integrate scoring into database-service, add query methods, record capabilities |
| 3 | 4abffdf66e5 | Register 5 new API routes in server.ts |

## Verification

- All 19 unit tests pass across 3 test files
- All modified files contain expected function/import references
- No untracked files or accidental deletions

## Self-Check: PASSED

- All 6 created files verified on disk
- All 3 commits verified in git log
