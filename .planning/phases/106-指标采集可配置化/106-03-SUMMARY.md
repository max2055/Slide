---
phase: 106
plan: 03
subsystem: alert-engine, metric-registry
tags: [alert, metric, permission, JSON-column, delete-ref-check]
requires: [106-01]
provides: [alert-evaluator-json-merge, metric-write-permission, metric-delete-ref-check, alert-rule-validation, metrics-data-json-column]
affects: [alert-evaluator, alert-engine, metric-database-service, metrics-database-service, server-routes]
tech-stack:
  added: []
  patterns: [JSON-column-for-dynamic-metrics, three-stage-metric-lookup, pre-delete-referential-integrity-check]
key-files:
  created:
    - path: apps/db-ops-api/src/__tests__/alert-evaluator-merge.test.ts
      purpose: Tests for getMetricValue JSON merge (D-15), 8 test cases
  modified:
    - path: apps/db-ops-api/src/alert-evaluator.ts
      changes: Export getMetricValue, add three-stage lookup (fixed columns -> metrics_data JSON -> direct access)
    - path: apps/db-ops-api/src/alert-engine.ts
      changes: Add warning log when is_collected=false metric has existing alert rules
    - path: apps/db-ops-api/src/metric-database-service.ts
      changes: Add deleteMetricWithRefCheck method with alert_rules reference check
    - path: apps/db-ops-api/server.ts
      changes: metric:write permission on POST/PUT/DELETE, delete ref check handler, SQL validation on POST/PUT, alert rule save validation
    - path: apps/db-ops-api/src/metrics-database-service.ts
      changes: Add metrics_data field to MetricsRecord interface, recordMetrics INSERT, and SELECT queries
decisions:
  - metric write routes use fine-grained metric:write permission instead of broad metric:manage
  - deleteMetricWithRefCheck returns has_alerts reason with referencedBy array for user-friendly 400 response
  - metrics_data stored as JSON column with JSON.stringify() on write, parsed by MySQL on read
metrics:
  duration: 12 min
  completed-date: 2026-05-22
  tasks: 2
  commits: 5
  test-files: 1
  test-cases: 8
---

# Phase 106 Plan 03: 告警端到端集成 SUMMARY

## Objective

实现告警端到端集成：alert-evaluator 合并 JSON 列取值 (D-15)、告警规则保存时验证 (D-14)、metric:write 权限路由保护 (D-16)、删除指标时检查告警引用 (D-17)、metrics-database-service 写入 JSON 列 (D-05)。

## Treść wykonania

### Task 1: Alert evaluator JSON column merge + alert rule validation (TDD)

**RED phase:** Exported `getMetricValue`, created test file with 8 test cases covering merge behavior, backward compat, null safety. 2 tests failed as expected (metrics_data merge not yet implemented).

**GREEN phase:** Implemented three-stage lookup in `getMetricValue`:
1. Fixed column fast path (type-safe number check)
2. `metrics_data` JSON object fallback (D-15)
3. Direct property access last resort

All 8 tests pass.

**alert-engine.ts enhancement:** Added warning logging in `syncRulesFromRegistry` for metrics where `is_collected=false` but still have existing alert rules.

### Task 2: Route protection, delete ref check, JSON column support

Four sub-targets implemented:

**D-16 (metric:write permission):** Changed `requirePermission('metric:manage')` to `requirePermission('metric:write')` on POST/PUT/DELETE `/api/metrics/registry` routes.

**D-17 (delete ref check):** Added `deleteMetricWithRefCheck` method to `MetricDatabaseService` that queries `alert_rules` by `metric_name` before deletion. DELETE route handler returns 400 with `referencedBy` array when alerts reference the metric.

**D-14 (alert rule validation):** Added validation in POST and PUT `/api/alert-rules` handlers. Checks `metricRegistry.getById()` for existence and `is_collected=true`. Returns 400 with clear Chinese error message if invalid.

**D-05 (JSON column write):** Added `metrics_data` field to `MetricsRecord` interface, `recordMetrics()` INSERT SQL and VALUES array, and SELECT queries for `getRealtimeMetrics` and `getHistoricalMetrics`.

## TDD Gate Compliance

- RED gate commit: `test(106-03): add failing test for alert-evaluator JSON column merge`
- GREEN gate commit: `feat(106-03): implement getMetricValue JSON column merge`
- REFACTOR gate: Not needed (implementation was minimal and clean)

## Deviations from Plan

None -- plan executed exactly as written.

## Commit History

| Commit | Message |
|--------|---------|
| `665b0641e25` | test(106-03): add failing test for alert-evaluator JSON column merge |
| `f2d2a68e3c6` | feat(106-03): implement getMetricValue JSON column merge |
| `159495cf758` | feat(106-03): add is_collected warning in syncRulesFromRegistry |
| `8a0835e47a6` | feat(106-03): add metric:write permissions, delete ref check, JSON column support |

## Threat Surface Scan

No new security-relevant surface introduced beyond what was in the plan's threat model. All three threats (T-106-08, T-106-09, T-106-10) are properly mitigated:

- T-106-08: `requirePermission('metric:write')` on all metric write routes
- T-106-09: `deleteMetricWithRefCheck` queries `alert_rules` before deletion
- T-106-10: Alert rule save validates `metric_name` exists and `is_collected=true`

## Self-Check: PASSED

- `apps/db-ops-api/src/__tests__/alert-evaluator-merge.test.ts`: FOUND
- `apps/db-ops-api/src/alert-evaluator.ts` (modified): FOUND (export getMetricValue + merge logic)
- `apps/db-ops-api/src/alert-engine.ts` (modified): FOUND (warning log)
- `apps/db-ops-api/src/metric-database-service.ts` (modified): FOUND (deleteMetricWithRefCheck)
- `apps/db-ops-api/server.ts` (modified): FOUND (permissions, ref check, SQL validation, alert rule validation)
- `apps/db-ops-api/src/metrics-database-service.ts` (modified): FOUND (metrics_data column)
- Commit hashes verified: all 4 commits exist
