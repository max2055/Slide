# Plan 02 SUMMARY: monitor-collector connection recovery

## Task Completed

**File modified:** `apps/db-ops-api/src/monitor-collector.ts`

### Changes

**`collectInstanceMetrics` method** — added connection recovery logic:

1. **`getRealtimeMetrics` returns null (metrics is null):**
   - Calls `databaseService.reconnect(instance.id)` for active reconnect
   - On success: updates health status to `(100, 'healthy')` immediately, retries metrics collection
   - On failure: logs error, falls through to `updateHealthStatusFromCheck`

2. **`getRealtimeMetrics` throws exception:**
   - Calls `databaseService.checkConnectionAlive(instance.id)` to check connection health
   - If not alive: tries `databaseService.reconnect(instance.id)` then marks `(100, 'healthy')` on success
   - If alive (not a connection issue): marks recovery as succeeded (no status change)
   - Only marks `(0, 'critical')` when all recovery attempts fail

3. **Unchanged behavior:** `updateHealthStatusFromCheck` still called at end of try block; catch recovery errors are caught internally.

### Acceptance Criteria Verification

| # | Criterion | Status |
|---|-----------|--------|
| 1 | metrics null → try reconnect | ✓ |
| 2 | reconnect success → updateHealthStatus(100, 'healthy') | ✓ |
| 3 | reconnect success → retry metrics collection | ✓ |
| 4 | exception → try checkConnectionAlive + reconnect | ✓ |
| 5 | catch block only marks critical when recovery fails | ✓ |
| 6 | normal collection unchanged | ✓ |
| 7 | updateHealthStatusFromCheck always called after try block | ✓ |
| 8 | TypeScript no new errors | ✓ |

### Edge Cases

- **Instance deleted during reconnect:** `databaseService.reconnect()` returns `false` (connection entry no longer exists), recovery path logs error, no health status update
- **Reconnect succeeds but retry collection fails:** Health is already restored to healthy; metrics will be collected on next tick
- **Connection alive but collection fails (e.g. query error):** `checkConnectionAlive` returns true, `recoverySucceeded` set to true, status not marked critical
