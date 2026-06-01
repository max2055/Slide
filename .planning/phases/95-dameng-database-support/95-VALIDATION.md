---
phase: 95
slug: dameng-database-support
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-17
updated: 2026-05-19
---

# Phase 95 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (backend apps/db-ops-api + frontend) |
| **Config file** | `apps/db-ops-api/vitest.config.ts`, `frontend/vitest.config.ts` |
| **Quick run command** | `cd apps/db-ops-api && npx vitest run` |
| **Full suite command** | `cd apps/db-ops-api && npx vitest run && cd ../../frontend && npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/db-ops-api && npx vitest run`
- **After every plan wave:** Run full suite (backend + frontend)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| DB-01-A | 01-1 | 1 | dmdb driver import + dmConnection interface field | T-95-02 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-connection-source` | `src/__tests__/dameng-connection-source.test.ts` | green |
| DB-01-B | 01-1 | 1 | addConnection dameng branch: dmdb.getConnection(), oracleConnection=null | T-95-02 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-connection-source` | `src/__tests__/dameng-connection-source.test.ts` | green |
| DB-01-C | 01-1 | 1 | removeConnection: dmConnection.close() | T-95-03 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-connection-source` | `src/__tests__/dameng-connection-source.test.ts` | green |
| DB-01-D | 01-1 | 1 | Dispatch guards: getRealtimeMetrics, getSlowQueries, checkHealth, getExplainPlan all use conn.dmConnection | T-95-04 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-connection-source` | `src/__tests__/dameng-connection-source.test.ts` | green |
| DB-01-E | 01-1 | 1 | getDamengMetrics/checkDamengHealth/getDamengSlowQueries/getDamengExplainPlan use conn.dmConnection guards + execute | T-95-04 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-methods-source` | `src/__tests__/dameng-methods-source.test.ts` | green |
| DB-01-F | 01-1 | 1 | getDamengActiveSessions method: queries V$SESSIONS via conn.dmConnection | T-95-04 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-methods-source` | `src/__tests__/dameng-methods-source.test.ts` | green |
| DB-01-G | 01-1 | 1 | getDamengCapacity method: queries DBA_DATA_FILES / DBA_SEGMENTS via conn.dmConnection | T-95-05 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-methods-source` | `src/__tests__/dameng-methods-source.test.ts` | green |
| DB-01-H | 01-1 | 1 | getActiveSessions dispatch: separate oracle + dameng branches (no shared `\|\|`) | T-95-04 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-methods-source` | `src/__tests__/dameng-methods-source.test.ts` | green |
| DB-01-I | 01-1 | 1 | getCapacityInfo dispatch: separate oracle + dameng branches (no shared `\|\|`) | T-95-05 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-methods-source` | `src/__tests__/dameng-methods-source.test.ts` | green |
| DB-01-J | 01-1 | 1 | Oracle methods (getOracleActiveSessions, getOracleCapacity) unchanged — still use conn.oracleConnection | T-95-04 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-methods-source` | `src/__tests__/dameng-methods-source.test.ts` | green |
| DB-01-K | 01-2 | 1 | testConnection() dameng branch uses dynamic dmdb import | T-95-02 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-tools-source` | `src/__tests__/dameng-tools-source.test.ts` | green |
| DB-01-L | 01-2 | 1 | getSchemaObjects() dameng branch queries ALL_TAB_COLUMNS via conn.dmConnection | T-95-04 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-tools-source` | `src/__tests__/dameng-tools-source.test.ts` | green |
| DB-01-M | 01-2 | 1 | Metric registry: 7 common metrics include 'dameng' in db_types (cpu_usage, memory_usage, disk_usage, connections, qps, tps, health_score) | T-95-01 | N/A | unit (module) | `cd apps/db-ops-api && npx vitest run dameng-metric-registry` | `src/__tests__/dameng-metric-registry.test.ts` | green |
| DB-01-N | 01-2 | 1 | Metric registry: slow_queries and buffer_pool_hit_rate do NOT include 'dameng' | T-95-01 | N/A | unit (module) | `cd apps/db-ops-api && npx vitest run dameng-metric-registry` | `src/__tests__/dameng-metric-registry.test.ts` | green |
| DB-01-O | 01-2 | 1 | add_database.ts: 'dameng' in union type, enum, description, defaultPort 5236 | T-95-01 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-tools-source` | `src/__tests__/dameng-tools-source.test.ts` | green |
| DB-01-P | 01-2 | 1 | test_connection.ts: 'dameng' in enum + conn.dmConnection fast-path | T-95-01 | N/A | unit (source) | `cd apps/db-ops-api && npx vitest run dameng-tools-source` | `src/__tests__/dameng-tools-source.test.ts` | green |
| DB-01-Q | 02-1 | 1 | DamengDialect defined via SQLDialect.define() with DM8 keywords, builtins (V$*, DBA_*), types, config flags | T-95-04 | N/A | unit (source) | `cd frontend && npx vitest run dameng-dialect-source` | `frontend/.../dameng-dialect-source.test.ts` | green |
| DB-01-R | 02-1 | 1 | Dialect switching: dameng instances use DamengDialect; caseInsensitiveIdentifiers:true; upperCaseKeywords:true for Dameng | T-95-04 | N/A | unit (source) | `cd frontend && npx vitest run dameng-dialect-source` | `frontend/.../dameng-dialect-source.test.ts` | green |

*Status: pending · green · red · flaky*

---

## Wave 0 Requirements

- [x] Verify existing vitest infrastructure covers dameng-related test files
- [x] Stub test files for new Dameng modules if created

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dameng DB connection | DB-01 | Requires live DM8 instance | Connect with dmdb driver, verify pool creation, run SELECT 1 |
| SQL console Dameng dialect | DB-01 | Visual verification of syntax highlighting | Open SQL console on a Dameng instance, verify DM8 keywords highlighted |
| Instance detail page rendering | DB-01 | Requires live metrics data | View instance detail page with Dameng instance, verify all 6 tabs render |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

---

## Audit Trail

| Date | Action | By | Details |
|------|--------|----|---------|
| 2026-05-19 | Nyquist validation | Developer | Created 5 test files (4 backend + 1 frontend) with 76 total tests covering all Dameng requirements: dmdb connection lifecycle, method migration, dispatch splits, metric registry, agent tools, and Dameng SQL dialect. All 76 tests pass. |
