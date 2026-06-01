---
phase: 99-db-connection-auto-recovery
plan: 01
status: completed
execution_date: 2026-05-19
commits:
  - 7e53fd39728 feat(phase-99): add MySQL keepalive, connection health check, reconnect, and auto-reconnect wrapper
  - 930d438527a feat(phase-99): wire public query methods with auto-reconnect, update sql-executor
---

# Plan 01 Summary — Database Connection Auto-Recovery

## Objective

database-service.ts 增加连接健康检测与自动重连机制，确保纳管数据库断开后，下次查询或采集时自动检测死连接并重建。

## Completed Tasks

### Task 1 — Add checkConnectionAlive, reconnect, _withAutoReconnect + MySQL keepalive

**Files modified:** `apps/db-ops-api/src/database-service.ts`

Changes:
1. **MySQL pool keepalive**: Added `enableKeepAlive: true, keepAliveInitialDelay: 10000` to mysql createPool options
2. **checkConnectionAlive(id)**: Executes probe query per DB type (mysql: pool.getConnection + ping, postgresql: pgClient.query('SELECT 1'), oracle: oracleConnection.execute('SELECT 1 FROM DUAL'), dameng: dmConnection.execute('SELECT 1 FROM DUAL')). Sets `conn.connected = false` on failure.
3. **reconnect(id)**: Tears down old connection via `removeConnection(id)`, then rebuilds via `addConnection(id, name, config)`
4. **_withAutoReconnect(id, fn, methodName)**: Private wrapper that auto-reconnects on dead connections before retrying queries. Handles both pre-query dead connection and mid-query connection errors.

### Task 2 — Wire all public query methods + update sql-executor

**Files modified:** `apps/db-ops-api/src/database-service.ts`, `apps/db-ops-api/src/sql-executor.ts`

Changes:
1. **8 public methods wrapped** with `_withAutoReconnect`:
   - `getRealtimeMetrics`, `getSlowQueries`, `checkHealth`, `getSchemaObjects`
   - `getQueryAnalytics`, `getExplainPlan`, `getActiveSessions`, `getCapacityInfo`
2. **checkHealth special handling**: Returns critical fallback (health_score: 0) when `_withAutoReconnect` returns null
3. **ensureConnectionAlive(id)**: Public method for external consumers — checks connection liveness and triggers reconnect if needed
4. **sql-executor.ts**: Replaced static `conn.connected` check with `databaseService.ensureConnectionAlive(instanceId)` call

## Verification

- TypeScript compilation: No errors in `database-service.ts` or `sql-executor.ts`
- All pre-existing compilation errors are from other unrelated files

## Threat Model Compliance

- T-99-01 (DoS): `_withAutoReconnect` limits reconnect to one attempt per query — no infinite retry loop
- T-99-02 (Tampering): Only added `enableKeepAlive`/`keepAliveInitialDelay` — no auth config modifications
- T-99-03 (Information Disclosure): Errors logged to console only, not exposed to users
