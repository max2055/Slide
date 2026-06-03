---
phase: 106-指标采集可配置化
plan: 02
subsystem: backend-collectors
tags:
  - providers
  - dispatcher
  - custom-sql
  - monitor-wiring
requires:
  - 106-01 (Registry, BaseMetricProvider, MetricProvider interface)
provides:
  - MySQLProvider (mysql.provider.ts)
  - PostgreSQLProvider (postgresql.provider.ts)
  - OracleProvider (oracle.provider.ts)
  - DamengProvider (dameng.provider.ts)
  - CustomSQLProvider (custom-sql.provider.ts)
  - UnifiedCollector (collector.ts)
  - collectorRegistry singleton (registry.ts)
affects:
  - apps/db-ops-api/src/database-service.ts (no changes — maintained backward compat)
  - apps/db-ops-api/src/monitor-collector.ts (delegates to UnifiedCollector)
  - apps/db-ops-api/src/collectors/registry.ts (added collectorRegistry singleton)
tech-stack:
  added: []
metrics:
  duration: 15m
  completed: 2026-05-22
  tasks: 2
  files_created: 7
  files_modified: 2
  commits: 4
  tdd_compliant: true
---

# Phase 106 Plan 02: Provider Extraction and UnifiedCollector

## One-Liner

Extracted 4 DB-specific getXxxMetrics() methods into standalone Provider classes, created CustomSQLProvider for user-defined SQL metrics, built UnifiedCollector dispatch architecture, wired into MonitorCollector, all with TDD test-first commits.

## Decisions Made

1. **Provider.collect() returns scalar (number | null), not RealtimeMetrics** — Each call handles one metric by metricDef.id via switch/case. UnifiedCollector iterates definitions and assembles results.
2. **Delta counters stay on DatabaseConnection** — conn.deltaCounter, conn.pgDeltaCounter, conn.oracleDeltaCounter remain on the connection object for cross-call state, not moved to Provider instances.
3. **MonitorCollector calls UnifiedCollector first, then getRealtimeMetrics** — Keeps existing logging and backward compatibility while the new Provider pipeline feeds metrics_history.
4. **CollectorRegistry singleton in registry.ts** — Single global Registry<MetricProvider> instantiated at module level with all 5 providers auto-registered at collector.ts init.

## Tasks

### Task 1: Extract 4 getXxxMetrics() into Provider classes

| Step | Type | Commit | Description |
|------|------|--------|-------------|
| RED | test | 1fa5b6ac1a0 | Failing tests for 4 Provider contracts (name, types, null safety) |
| GREEN | feat | 85ef966ab64 | MySQLProvider, PostgreSQLProvider, OracleProvider, DamengProvider |
| VERIFY | tsc | — | All provider files compile (pre-existing errors in database-service.ts only) |

**Files created:**
- `apps/db-ops-api/src/collectors/mysql.provider.ts` — 24 metric cases via conn.deltaCounter
- `apps/db-ops-api/src/collectors/postgresql.provider.ts` — 13 metric cases via conn.pgDeltaCounter
- `apps/db-ops-api/src/collectors/oracle.provider.ts` — 11 metric cases via conn.oracleDeltaCounter
- `apps/db-ops-api/src/collectors/dameng.provider.ts` — 6 metric cases (no delta counter)
- `apps/db-ops-api/src/collectors/__tests__/providers.test.ts` — 6 structural tests

### Task 2: Create CustomSQLProvider + UnifiedCollector + wire into MonitorCollector

| Step | Type | Commit | Description |
|------|------|--------|-------------|
| RED | test | 7a8c3d1b753 | Failing tests for CustomSQLProvider, registry, UnifiedCollector, wiring |
| GREEN | feat | d771801b50a | CustomSQLProvider, collectorRegistry, UnifiedCollector, MonitorCollector delegation |
| VERIFY | tsc | — | All new files compile (pre-existing errors in database-service.ts only) |

**Files created:**
- `apps/db-ops-api/src/collectors/custom-sql.provider.ts` — AST validation, 15s timeout, multi-DB execution
- `apps/db-ops-api/src/collector.ts` — UnifiedCollector + auto-registration of all 5 providers

**Files modified:**
- `apps/db-ops-api/src/collectors/registry.ts` — Added `MetricProvider` import + `collectorRegistry` singleton
- `apps/db-ops-api/src/monitor-collector.ts` — Added `unifiedCollector` import, called `collectInstance(instance)` before existing getRealtimeMetrics

## Deviations from Plan

### Rule 2 — Auto-added null safety check

Found during Task 1 (provider tests): all 4 providers crashed with `TypeError: Cannot read properties of null` when `instance` parameter was null. Added `!instance` guard before connection-type checks in all 4 providers' `collect()` methods. This is a correctness requirement since UnifiedCollector could pass a null connection in edge cases.

**Files modified:** mysql.provider.ts, postgresql.provider.ts, oracle.provider.ts, dameng.provider.ts
**Commit:** 85ef966ab64 (part of GREEN commit)

## Threat Surface Scan

No new security-relevant surface found beyond what the `<threat_model>` covers. CustomSQLProvider's SQL validation (T-106-04, T-106-07) is handled via node-sql-parser AST checks and wrapped SELECT format. Execution timeout (D-12) implemented at 15s. Provider auto-disable (D-13) 3 consecutive failures.

## Verification

- [x] `npx vitest run src/collectors/__tests__/providers.test.ts` — 6/6 pass
- [x] `npx vitest run src/collectors/__tests__/task2.test.ts` — 6/6 pass
- [x] `npx tsc --noEmit --skipLibCheck src/collectors/*.provider.ts src/collector.ts` — no errors in new files (pre-existing errors only)
- [x] MonitorCollector imports `unifiedCollector` from `./collector` and calls `collectInstance(instance)`
- [x] collectorRegistry singleton available with all 5 providers auto-registered at module init
- [x] Provider auto-disable at >=3 consecutive failures via `collectorRegistry.recordFailure` + `collectorRegistry.disable`
- [x] describeSchema() on CustomSQLProvider returns 'no schema description available'

## TDD Gate Compliance

Both tasks follow the test-first TDD cycle:

| Task | RED commit | GREEN commit | Compliant |
|------|-----------|-------------|-----------|
| 1 — 4 DB Providers | `test(106-02): add failing test for 4 DB-specific Provider contracts` (1fa5b6ac1a0) | `feat(106-02): implement 4 DB-specific MetricProvider classes` (85ef966ab64) | Yes |
| 2 — CustomSQL + Collector | `test(106-02): add failing test for Task 2` (7a8c3d1b753) | `feat(106-02): implement CustomSQLProvider, UnifiedCollector, MonitorCollector wiring` (d771801b50a) | Yes |
