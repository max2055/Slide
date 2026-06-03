---
phase: 106-指标采集可配置化
plan: 01
subsystem: backend-infrastructure
tags:
  - registry
  - providers
  - schema-migration
  - sql-validator
  - metric-crud
requires: []
provides:
  - Generic Registry<T> abstraction (registry.ts)
  - MetricProvider interface + BaseMetricProvider abstract class (base-provider.ts)
  - SQL whitelist validator (sql-validator.ts)
  - Phase 106 schema migration (schema.sql)
  - MetricDatabaseService CRUD enhancement
affects:
  - apps/db-ops-api/src/metric-database-service.ts
tech-stack:
  added:
    - node-sql-parser (SQL AST validation)
key-files:
  created:
    - apps/db-ops-api/src/collectors/registry.ts (51 lines)
    - apps/db-ops-api/src/collectors/base-provider.ts (31 lines)
    - apps/db-ops-api/src/sql-validator.ts (48 lines)
    - apps/db-ops-api/src/__tests__/collectors/registry.test.ts (114 lines)
    - apps/db-ops-api/src/__tests__/sql-validator.test.ts (68 lines)
  modified:
    - apps/db-ops-api/sql/schema.sql
    - apps/db-ops-api/src/metric-database-service.ts
    - apps/db-ops-api/package.json
decisions:
  - describeSchema in BaseMetricProvider implemented as non-optional concrete method returning Promise.resolve('') rather than optional (?), because an abstract class with optional abstract methods is not valid TypeScript. Subclasses can still override it voluntarily.
  - Import Pattern for CJS modules: node-sql-parser is CommonJS, imported via default-import-then-destructure pattern (`import pkg from 'node-sql-parser'; const { Parser } = pkg`), consistent with esModuleInterop: true in tsconfig.json.
  - getProvidersByDbType uses runtime duck-typing (`(provider as any).supportedDbTypes`) rather than constraining T further, preserving full generic flexibility for Registry<T>.
metrics:
  duration: null
  completed_date: "2026-05-22"
---

# Phase 106 Plan 01: 后端基础设施层 Summary

## Objective

创建 Phase 106 的后端基础设施层：Generic Registry<T> 抽象、BaseMetricProvider 基类、数据库迁移（metric_definitions + metrics_history 新列）、SQL 白名单验证器、MetricDatabaseService CRUD 增强。

## Tasks

| # | Name | Type | Files | Commit |
|---|------|------|-------|--------|
| 1 | Create Generic Registry<T> + BaseMetricProvider | TDD (auto) | registry.ts, base-provider.ts, registry.test.ts | `dddfd9326f1` (RED), `0bcdc54737f` (GREEN) |
| 2 | SQL schema migration — metric_definitions + metrics_history | auto | schema.sql | `b25aeb3c436` |
| 3 | Create SQL validator + enhance MetricDatabaseService CRUD | TDD (auto) | sql-validator.ts, metric-database-service.ts, sql-validator.test.ts | `1a0d27c2b66` (RED), `d0543292e3d` (GREEN) |

## TDD Gate Compliance

- Task 1: RED gate commit `dddfd9326f1` (failing test), GREEN gate commit `0bcdc54737f` (passing implementation) -- Compliant
- Task 3: RED gate commit `1a0d27c2b66` (failing test), GREEN gate commit `d0543292e3d` (passing implementation) -- Compliant

## Verification Results

| Check | Result |
|-------|--------|
| `npx vitest run src/__tests__/collectors/registry.test.ts` | 9/9 pass |
| `npx vitest run src/__tests__/sql-validator.test.ts` | 11/11 pass |
| schema.sql has metrics_data JSON | Confirmed |
| schema.sql has metric:write permission seed | Confirmed |
| `npx tsc --noEmit` (project tsconfig) | No errors in changed files |

## Deviations from Plan

None - plan executed exactly as written.

## Success Criteria

- [x] Registry<T> and BaseMetricProvider exist and are typed correctly
- [x] schema.sql has Phase 106 changes (collection_sql, value_type, category, updated_by, metrics_data JSON)
- [x] metric:write permission seeded
- [x] sql-validator.ts rejects non-SELECT statements using node-sql-parser AST
- [x] MetricDatabaseService.createMetric/updateMetric handles new fields (collection_sql, value_type, category, updated_by)
- [x] Collector singleton not yet created (delegated to Plan 02)

## Self-Check: PASSED

| Check | Status |
|-------|--------|
| Created files (5) | All FOUND |
| Commits (5) | All FOUND |
| metrics_data in schema.sql | FOUND |
| metric:write in schema.sql | FOUND |
