---
phase: 96-oracle-database-support
plan: 01
subsystem: db-ops-api
tags: [oracle, connection-pool, metrics, agent-tools, backend]
dependency_graph:
  requires: []
  provides: [fully-wired-oracle-backend]
  affects: [plan-02-frontend, monitor-collector]
tech-stack:
  added: [oracledb.createPool, oracledb.sslOptions, oracledb.fetchAsString, oracledb.fetchAsBuffer]
  patterns: [delta-counter-for-qps-tps, DBA-fallback-try-catch, PLAN_TABLE-fallback]
key-files:
  created:
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/oracle_ash_report.ts
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/oracle_awr_report.ts
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/oracle_tablespace_detail.ts
  modified:
    - apps/db-ops-api/src/database-service.ts
    - apps/db-ops-api/src/metric-registry.ts
    - apps/db-ops-api/src/instance-database-service.ts
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/test_connection.ts
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/add_database.ts
decisions:
  - "use oracledb.createPool() with poolMax=4, poolMin=0, poolTimeout=60 (D-14)"
  - "TCPS DESCRIPTOR connectString + sslOptions for dev (D-13)"
  - "fetchAsString=[NUMBER], fetchAsBuffer=[CLOB] (D-17)"
  - "persistent connection from pool + oraclePool dual storage for backward compat"
  - "oracleDeltaCounter pattern aligned with existing MySQL deltaCounter"
  - "skip update_db_config.ts and get_instance_summary.ts (no db_type enum, per RESEARCH)"
  - "ASH/AWR tools preserve Oracle native HTML format (D-11)"
metrics:
  duration: ~15 minutes
  completed_date: "2026-05-19"
---

# Phase 96 Plan 01: Oracle Backend Wiring Summary

**One-liner:** Upgraded Oracle connection from single getConnection() to oracledb.createPool() with TCPS encryption, registered Oracle at all metric-registry touchpoints, fixed 3 bugs, added 3 new Agent tools, and added DBA privilege fallbacks across all Oracle methods.

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | database-service.ts pool upgrade + TCPS + fetchAs + bug fixes + schema browser + DBA fallback | e2e16f47c46 | apps/db-ops-api/src/database-service.ts |
| 2 | metric-registry + instance-database-service: register Oracle + SID/Service Name + TCPS testConnection | c3c2fe98519 | apps/db-ops-api/src/metric-registry.ts, apps/db-ops-api/src/instance-database-service.ts |
| 3 | Agent tools: extend 2 tools + create 3 new Oracle-specific tools | 6df036779bd | test_connection.ts, add_database.ts, oracle_ash_report.ts, oracle_awr_report.ts, oracle_tablespace_detail.ts |

## Artifacts by File

### database-service.ts

**Pool upgrade (D-14):** Oracle connections now use `oracledb.createPool()` with poolMax=4, poolMin=0, poolTimeout=60, queueRequests=true, queueMax=500, queueTimeout=60000. A persistent connection is obtained from the pool and stored in `oracleConnection` for backward compatibility with all existing methods. The pool is stored in the new `oraclePool` field.

**TCPS encryption (D-13):** The connectString uses the TCPS DESCRIPTOR format:
```
(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=...)(PORT=...))(CONNECT_DATA=(SERVICE_NAME=...)))
```
with `oracledb.sslOptions = { rejectUnauthorized: false }` for development.

**fetchAs configuration (D-17):** Set globally before pool creation:
- `oracledb.fetchAsString = [oracledb.NUMBER]` -- prevent precision loss
- `oracledb.fetchAsBuffer = [oracledb.CLOB]` -- handle CLOB as Buffer

**Interface additions:**
- `oraclePool: oracledb.Pool | null` in DatabaseConnection
- `oracleDeltaCounter?` in DatabaseConnection (tracks executes/commits/timestamp)
- `sga_size_mb?: number` and `pga_size_mb?: number` in RealtimeMetrics

**Bug fixes:**
- **Bug 1 (checkOracleHealth):** Added version query from V$VERSION and data size query from DBA_DATA_FILES with try/catch fallback. Previous code returned `db_version: dbVersion` and `data_size_gb: dataSizeGB` without declaring these variables (would always return undefined).
- **Bug 2 (getOracleMetrics QPS/TPS):** Replaced hardcoded `Math.floor(executes / 100)` and `Math.floor(commits / 10)` ratios with delta-based calculation via `oracleDeltaCounter`. First invocation uses fallback ratios; subsequent invocations calculate actual per-second rates.
- **Bug 3 (getSchemaObjects):** Added Oracle branch querying ALL_TAB_COLUMNS with SYS/SYSTEM/OUTLN/DBSNMP/etc exclusion filter. Previously only MySQL, PostgreSQL, and Dameng were handled.

**PLAN_TABLE fallback (Pitfall 2):** The EXPLAIN PLAN block is now wrapped in an inner try/catch. If ORA-00942 (table not found) occurs, returns a message telling the user to create PLAN_TABLE or use DBMS_XPLAN.DISPLAY_CURSOR().

**DBA privilege fallback (Pitfall 3):**
- getOracleMetrics(): DBA_SEGMENTS/DBA_DATA_FILES tablespace query wrapped in try/catch
- getOracleCapacity(): Both DBA_DATA_FILES and DBA_SEGMENTS queries wrapped in try/catch
- Both return null/empty values gracefully without crashing

**Dispatch guard update:** All 6 oracle dispatch points changed from `conn.oracleConnection` to `conn.oraclePool`. This ensures the pool exists before routing to methods (the methods still use the persistent `conn.oracleConnection` for queries).

**removeConnection:** Changed from `conn.oracleConnection.close()` to `conn.oraclePool.close(0)` for proper pool draining.

### metric-registry.ts

**8 built-in metrics extended with 'oracle' (D-01):** cpu_usage, memory_usage, disk_usage, connections, qps, tps, slow_queries, health_score.

**3 new Oracle-specific metrics (D-02):**
- `tablespace_usage` -- Oracle tablespace usage %, aggregation=last, interval=300s
- `sga_hit_rate` -- SGA hit rate, aggregation=avg, interval=30s
- `deadlock_count` -- Oracle deadlock count, aggregation=max, interval=60s

Did NOT add 'oracle' to MySQL/PG-only metrics (buffer_pool_hit_rate, table_open_cache_hit_rate, PG-only vacuums/replication, etc.).

### instance-database-service.ts

**testConnection updated (D-12, D-13):**
- TCPS DESCRIPTOR connectString with `config.database` as SERVICE_NAME (supports SID or Service Name)
- `oracledb.sslOptions = { rejectUnauthorized: false }` for dev mode

### Agent Tools

**test_connection.ts:** Added 'oracle' to db_type enum and parameter description.

**add_database.ts:** Added 'oracle' to the union type, enum array, tool description, parameter description, and default ports (`oracle: [1521]`).

**New oracle_ash_report.ts:** Queries `DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML()` to generate ASH report in native HTML format. Parameters: instance_id, start_time, end_time (ISO timestamps). Fallback: "ASH requires Oracle Enterprise Edition + Diagnostics Pack license".

**New oracle_awr_report.ts:** Queries `DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML()` to generate AWR report in native HTML format. Parameters: instance_id, begin_snap_id, end_snap_id. Fallback: "AWR requires Oracle Enterprise Edition + Diagnostics Pack license".

**New oracle_tablespace_detail.ts:** Queries DBA_TABLESPACES + DBA_DATA_FILES + DBA_SEGMENTS for detailed tablespace info with top 10 segments per tablespace. Fallback: DBA privilege error message with instructions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] checkOracleHealth db_version and data_size_gb always undefined**
- **Found during:** Task 1
- **Issue:** `checkOracleHealth()` referenced `dbVersion` and `dataSizeGB` variables that were never declared, so db_version and data_size_gb always returned undefined.
- **Fix:** Added proper V$VERSION version query and DBA_DATA_FILES data size query with try/catch fallback, declaring variables properly before use in the return object.
- **Files modified:** apps/db-ops-api/src/database-service.ts
- **Commit:** e2e16f47c46

**2. [Rule 1 - Bug] getOracleMetrics QPS/TPS hardcoded static ratios**
- **Found during:** Task 1
- **Issue:** QPS was hardcoded as `Math.floor(executes / 100)` and TPS as `Math.floor(commits / 10)`, giving meaningless static values regardless of real database load.
- **Fix:** Implemented `oracleDeltaCounter` pattern (matching existing MySQL deltaCounter) that tracks executes/commits/timestamp across calls and calculates actual per-second rates. First call falls back to the static ratios.
- **Files modified:** apps/db-ops-api/src/database-service.ts
- **Commit:** e2e16f47c46

**3. [Rule 1 - Bug] getSchemaObjects missing Oracle branch**
- **Found during:** Task 1
- **Issue:** The method only handled MySQL, PostgreSQL, and Dameng -- Oracle would fall through to return empty array.
- **Fix:** Added Oracle branch querying ALL_TAB_COLUMNS with SYS/SYSTEM/OUTLN/DBSNMP/XDB/APPQOSSYS/ORACLE_OCM/GSMADMIN_INTERNAL exclusion filter.
- **Files modified:** apps/db-ops-api/src/database-service.ts
- **Commit:** e2e16f47c46

**4. [Rule 3 - Blocking] Worktree path mismatch**
- **Found during:** Task 1
- **Issue:** Initial edits went to the main repo path (`/Users/max/Coding/39-Slide/apps/db-ops-api/...`) instead of the worktree path (`/Users/max/Coding/39-Slide/.claude/worktrees/agent-aa7afd6290d86cb94/apps/db-ops-api/...`).
- **Fix:** Restored main repo file to clean state via `git checkout`, then re-applied all edits with worktree-absolute paths. Installed path safety for all subsequent operations.
- **Files modified:** apps/db-ops-api/src/database-service.ts (restored + re-edited)
- **Commit:** e2e16f47c46

### Scope Boundaries Respected

- Did NOT modify: monitor-collector.ts (D-16 confirmed no changes needed), sql-executor.ts (already dispatches to Oracle), update_db_config.ts (no db_type enum), get_instance_summary.ts (generic db_type string, not enum)
- Did NOT modify: other db-type code paths (MySQL, PostgreSQL, Dameng)

## TypeScript Compilation

PASSED (only pre-existing tsconfig deprecation warning for `baseUrl`, no type errors).

## Success Criteria

- [x] Oracle connections use oracledb.createPool() per D-14 (poolMax=4, poolMin=0, poolTimeout=60)
- [x] TCPS encrypted connections used for all Oracle connections (D-13), dev mode skips wallet
- [x] fetchAsString for NUMBER and fetchAsBuffer for CLOB set globally (D-17)
- [x] checkOracleHealth() returns correct db_version and data_size_gb (Bug 1 fixed)
- [x] getOracleMetrics() uses delta-based QPS/TPS via oracleDeltaCounter (Bug 2 fixed)
- [x] getOracleMetrics() returns sga_size_mb and pga_size_mb values
- [x] getSchemaObjects() has Oracle branch returning schema objects (Bug 3 fixed)
- [x] getOracleExplainPlan() handles missing PLAN_TABLE gracefully
- [x] getOracleMetrics() and getOracleCapacity() handle missing DBA_* privileges gracefully
- [x] All 8 built-in metrics registered for Oracle in metric-registry (D-01)
- [x] 3 new Oracle-specific metrics registered (D-02)
- [x] testConnection supports SID/Service Name via config.database + TCPS (D-12, D-13)
- [x] test_connection agent tool supports 'oracle' db_type
- [x] add_database agent tool supports 'oracle' db_type + default port 1521
- [x] 3 new agent tools created: oracle_ash_report, oracle_awr_report, oracle_tablespace_detail
- [x] ASH/AWR tools preserve Oracle native HTML format (D-11)
- [x] Code compiles without TypeScript errors

## Self-Check: PASSED

All verification grep checks passed. All 8 modified/created files exist in the worktree. All 3 commits are present in git history.
