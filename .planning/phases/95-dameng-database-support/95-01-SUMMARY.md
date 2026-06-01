---
phase: 95-dameng-database-support
plan: 01
subsystem: db-ops-api
tags:
  - dameng
  - dmdb
  - connection
  - metrics
  - agent-tools
depends_on: []
provides:
  - dmdb driver integration for Dameng DM8 connections
  - Separate Dameng-only active sessions and capacity methods
  - Metric registry with dameng db_type for 7 common metrics
  - AI agent tools (add_database, test_connection) with 'dameng' support
affects:
  - apps/db-ops-api/src/database-service.ts
  - apps/db-ops-api/src/instance-database-service.ts
  - apps/db-ops-api/src/metric-registry.ts
  - apps/db-ops-api/src/tools/generated/slide-self-mgmt/add_database.ts
  - apps/db-ops-api/src/tools/generated/slide-self-mgmt/test_connection.ts
  - apps/db-ops-api/package.json
key-files:
  created: []
  modified:
    - apps/db-ops-api/package.json
    - apps/db-ops-api/src/database-service.ts
    - apps/db-ops-api/src/instance-database-service.ts
    - apps/db-ops-api/src/metric-registry.ts
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/add_database.ts
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/test_connection.ts
metrics:
  duration: 25m
  completed_date: "2026-05-18"
decisions: []
---

# Phase 95 Plan 01: Dameng Database Support — Connection Migration & Core Backend

**One-liner:** Installed dmdb driver, migrated all Dameng connection paths from oracledb to dmdb, created separate getDamengActiveSessions/getDamengCapacity methods, split oracle/dameng dispatchers, added 'dameng' to metric registry and AI agent tools.

## Tasks Executed

### Task 1: dmdb install + database-service.ts migration — 3e6811c

**Installation:** dmdb@^1.0.48286 installed via npm.

**Changes to database-service.ts:**
- Added `import dmdb from 'dmdb'`
- Added `dmConnection: dmdb.Connection | null` to `DatabaseConnection` interface
- Migrated `addConnection()` dameng branch: `oracledb.getConnection()` -> `dmdb.getConnection()` with `connectString: "host:port"` and `schema` parameter
- Added `conn.dmConnection.close()` in `removeConnection()`
- Migrated dispatch guards in `getRealtimeMetrics()`, `getSlowQueries()`, `checkHealth()`, `getExplainPlan()` from `conn.oracleConnection` to `conn.dmConnection`
- Migrated all `conn.oracleConnection.execute()` calls to `conn.dmConnection.execute()` in `getDamengMetrics()`, `checkDamengHealth()`, `getDamengSlowQueries()`, `getDamengExplainPlan()`
- Created new `getDamengActiveSessions()`: queries V$SESSIONS via `conn.dmConnection`, excludes self via ROWNUM subquery, maps Dameng-specific column names (SESS_ID, CLNT_IP, APPNAME)
- Created new `getDamengCapacity()`: queries DBA_DATA_FILES/DBA_SEGMENTS via `conn.dmConnection`, returns tablespaces + top_segments
- Split `getActiveSessions()` dispatch: separate `'oracle' -> getOracleActiveSessions()` and `'dameng' -> getDamengActiveSessions()` branches
- Split `getCapacityInfo()` dispatch: separate `'oracle' -> getOracleCapacity()` and `'dameng' -> getDamengCapacity()` branches
- All Oracle (oracledb) code paths completely untouched
- Added `dmConnection: null` to PostgreSQL, Oracle, and MySQL connection blocks for TypeScript correctness

### Task 2: testConnection migration + getSchemaObjects + metric-registry + agent tools — ad3b058

**instance-database-service.ts:**
- Migrated testConnection() dameng branch: `oracledb.getConnection()` replaced with dynamic `dmdb.getConnection()`, connectString format `host:port` (removed `/DAMENG` suffix), added `schema` and `connectTimeout`

**database-service.ts getSchemaObjects():**
- Added `conn.db_type === 'dameng' && conn.dmConnection` branch querying `ALL_TAB_COLUMNS`
- Filters out SYS, SYSDBA, SYSAUDITOR schemas
- Builds same schemaMap structure as PostgreSQL branch

**metric-registry.ts:**
- Added `'dameng'` to db_types for: cpu_usage, memory_usage, disk_usage, connections, qps, tps, health_score (7 metrics)
- Did NOT add 'dameng' to slow_queries (per D-06) or MySQL/PG-specific metrics

**add_database.ts agent tool:**
- Added `'dameng'` to `AddDatabaseArgs.db_type` union type
- Added `'dameng'` to `parameters.properties.db_type.enum` array
- Updated tool description to mention 达梦
- Added dameng default port (5236) to port validation

**test_connection.ts agent tool:**
- Added `'dameng'` to `parameters.properties.db_type.enum` array
- Added dmConnection fast-path check: `conn.dmConnection` branch after `conn.oracleConnection` check

## Deviations from Plan

### Rule 2 - Missing critical functionality: Pre-existing TypeScript errors

- Added `dmConnection: null` to PostgreSQL, Oracle, and MySQL connection blocks in `addConnection()`. The `DatabaseConnection` interface required `dmConnection` but existing non-dameng connection blocks omitted it, causing TypeScript errors in the new code path.

### Rule 2 - Auto-add missing critical functionality: Dameng default port

- Added `dameng: [5236]` to the `defaultPorts` map in `add_database.ts` so the port validation warning fires correctly for dameng instances.

## Threat Surface Scan

No new threat surface introduced. The threat model's STRIDE register (T-95-01 through T-95-05) correctly identifies all risk:

| Threat | File | Mitigation |
|--------|------|------------|
| T-95-01 Tampering | dmdb.execute() | Parameterized queries via `:name` bind syntax |
| T-95-02 Information Disclosure | dmdb.getConnection() | Credentials encrypted via existing encryptData |
| T-95-03 Denial of Service | dmdb.createPool() | Same queueRequests/queueTimeout pattern as MySQL/PG |
| T-95-04 Logic Error | getActiveSessions() split | Separate guard check per db_type |
| T-95-05 Logic Error | getCapacityInfo() split | Separate guard check per db_type |

## Commit History

| Hash | Type | Description |
|------|------|-------------|
| 634380b434b | feat | Install dmdb driver and migrate Dameng connection from oracledb to dmdb |
| 50b07f7b74d | feat | Migrate testConnection, add getSchemaObjects dameng branch, update metric registry and agent tools |
| a5a96442fc5 | fix | Add dmConnection: null to all non-dameng connection blocks |

## Self-Check: PASSED

- `import dmdb from 'dmdb'` present: YES (1 occurrence)
- `dmConnection:` in interface: YES (4 occurrences including interface + connection blocks)
- `dmdb.getConnection` call: YES (1 in addConnection)
- `getDamengActiveSessions` method: YES (definition + dispatch call)
- `getDamengCapacity` method: YES (definition + dispatch call)
- getActiveSessions() has separate 'oracle' and 'dameng' branches: YES (no shared `||`)
- getCapacityInfo() has separate 'oracle' and 'dameng' branches: YES (no shared `||`)
- Oracle methods unchanged: YES (all 6 Oracle-specific methods still use `oracleConnection`)
- metric-registry has 7 'dameng' in db_types: YES
- add_database.ts has 'dameng' in union + enum: YES
- test_connection.ts has 'dameng' in enum + dmConnection fast-path: YES
