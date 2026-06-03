---
phase: 99-db-connection-auto-recovery
reviewed: 2026-05-19T23:15:00Z
depth: deep
files_reviewed: 3
files_reviewed_list:
  - apps/db-ops-api/src/database-service.ts
  - apps/db-ops-api/src/sql-executor.ts
  - apps/db-ops-api/src/monitor-collector.ts
findings:
  critical: 0
  warning: 1
  info: 3
status: clean
total: 4
---

# Code Review: Phase 99 — db-connection-auto-recovery

## Previously Fixed (verified resolved)

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| CR-01 | ~~critical~~ | Connection leak in checkConnectionAlive: pool.getConnection() not released on ping() failure | **Fixed** — try/finally added at line 2949-2952 |
| WR-03 | ~~warning~~ | Duplicate reconnect call in monitor-collector (both _withAutoReconnect and explicit reconnect) | **Resolved** — tryReconnect helper consolidates both paths |
| - | ~~bug~~ | reconnect(id) returned false when no connection entry exists (startup-fail instances never recovered) | **Fixed** — fallbackName+fallbackConfig params added |
| - | ~~bug~~ | Dameng [6071] 消息加密失败 | **Fixed** — loginEncrypt: false |

## Current Findings

### WR-01: _withAutoReconnect step-1 reconnect outside error boundary

**File:** database-service.ts, line 3015-3019
**Severity:** Warning

The pre-query reconnect at line 3017 (`await this.reconnect(id)`) sits outside the try/catch block (line 3023). If `reconnect` throws — due to `removeConnection` failures in pool.end()/pgClient.end() — the error propagates unhandled through the 8 public methods to their callers.

```typescript
if (!conn.connected) {
  await this.reconnect(id);  // ← if this throws, error propagates unhandled
  ...
}

try {  // ← this only catches fn() errors, not reconnect errors
  return await fn(conn);
} catch (error) { ... }
```

**Mitigation:** Callers (monitor-collector, server routes) have their own try/catch. Pool end failures are rare in practice. This is a defense-in-depth gap, not a crash bug.

**Recommendation:** Wrap the step-1 reconnect in the existing try/catch or add a separate try/catch around it. Low urgency.

---

### IN-01: monitor-collector `instance: any` type erases compile-time safety

**File:** monitor-collector.ts, lines 182, 248
**Severity:** Info

`collectInstanceMetrics(instance: any)` and `tryReconnect(instance: any)` use `any` for the instance parameter. If the instance shape changes (e.g., `host` renamed to `db_host`), `instance.host` silently becomes `undefined` in the DatabaseConfig, and addConnection fails with an opaque error.

```typescript
const config = {
  host: instance.host,       // undefined if API shape changes
  port: instance.port,       // undefined if API shape changes
  user: instance.username,   // undefined if field renamed
  // ...
};
```

**Recommendation:** Define a minimal `InstanceInfo` interface with the fields used (id, name, host, port, username, database_name, db_type). Zero runtime cost, pure type safety.

---

### IN-02: tryReconnect double-calls reconnect when entry exists but is dead

**File:** monitor-collector.ts, line 250
**Severity:** Info

```typescript
let reconnected = await databaseService.reconnect(instance.id);  // pass 1
if (reconnected) return true;
// ...build config...
return databaseService.reconnect(instance.id, instance.name, config);  // pass 2
```

When a connection entry exists but is dead, pass 1 calls `removeConnection(id)` then `addConnection(id, name, config)`. If `addConnection` fails (DB still down), the entry is removed from the map. Pass 2 then has no oldConn and calls `addConnection` from scratch — a second attempt with the same result.

This is harmless (2 attempts instead of 1) but wastes an `addConnection` call when the DB is down. The first attempt already tried and failed.

**Recommendation:** Low priority. The extra attempt is a minor overhead on a 30s tick interval. Only affects the rare "entry exists but DB is down" scenario.

---

### IN-03: console.error may log connection strings with host:port in error messages

**File:** database-service.ts, multiple locations
**Severity:** Info

Error messages include instance id and name via `console.error`. The logged error object may contain connection details in the stack trace. This is the existing logging pattern throughout the codebase — Phase 99 doesn't introduce new risks.

**Recommendation:** Documented in threat model T-99-03 (accepted risk: local logs only). No action needed.

---

## Security Review

| Threat | Status |
|--------|--------|
| DoS: infinite reconnect loop | **Mitigated** — max 2 attempts per tick (standard + fallback), 30s tick interval |
| DoS: pool exhaustion (CR-01) | **Fixed** — connection.release() in finally block |
| Info disclosure: password in logs | **Not found** — password never passed to console.log |
| Tampering: config modification | **Mitigated** — only enableKeepAlive/keepAliveInitialDelay added |

## Summary

Phase 99 code is production-ready. 1 warning (pre-existing pattern, low impact), 3 informational notes. All previously identified critical and warning issues have been fixed and verified.
