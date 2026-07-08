---
phase: 125-ssh-metrics
reviewed: 2026-07-08T23:00:00Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - apps/db-ops-api/package.json
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/sql/migrations/020_add_server_metrics_table.sql
  - apps/db-ops-api/src/monitor-collector.ts
  - apps/db-ops-api/src/server-collector.ts
  - apps/db-ops-api/src/server-database-service.ts
  - apps/db-ops-api/src/server-metric-provider.ts
  - apps/db-ops-api/src/ssh-session-pool.ts
  - frontend/src/app/ui/app-render.ts
  - frontend/src/app/ui/views/server-detail.ts
  - frontend/src/app/ui/views/servers-page.ts
findings:
  critical: 2
  warning: 6
  info: 4
  total: 12
status: issues_found
---

# Phase 125: Code Review Report — SSH Metrics

**Reviewed:** 2026-07-08T23:00:00Z
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

This phase adds SSH-collected OS-level server metrics (CPU, memory, disk, load, uptime) with encrypted credential storage, a session pool for SSH connections, a cron-based collector loop, a KV-style server_metrics table, and frontend UI for listing, viewing, and managing servers.

The architecture is well-structured overall. However, there are critical security defects (SSH host key verification is completely disabled in production connections), functional regressions (disk usage dashboard metric is always empty because the collector skips it), memory leaks (event listeners accumulate on view re-creation), and several robustness issues in the SSH session pool and credential update logic.

---

## Critical Issues

### CR-01: SSH Host Key Verification Disabled in Production Connections

**File:** `apps/db-ops-api/src/ssh-session-pool.ts:247`
**Issue:** The `_connect` method passes `hostVerifier: () => true`, which accepts any SSH host key without verification. This makes all production SSH connections vulnerable to man-in-the-middle attacks. Any attacker who can intercept network traffic between the application server and a monitored host can inject arbitrary commands and steal credentials.

The inline comment on line 248 states "Phase 125 doesn't fix host key — deferred to security phase", but this is a production code path used for every live collection tick, not a test-only path.

**Fix:** Implement SSH host key verification using `known_hosts`-style storage. At minimum:
1. Store `host_key_fingerprint` when the server is first added (the table already has a `host_key_fingerprint` column).
2. Use a `hostVerifier` callback that compares the received host key hash against the stored fingerprint.
3. On first connection, prompt verification and store the fingerprint.
4. On subsequent connections, reject mismatches.
5. For the test-connection endpoint (server-database-service.ts:389), a permissive verifier is acceptable since it is stateless — but production connections in the pool must verify.

### CR-02: Credential Type Mismatch Risk in Server Update Re-Encryption

**File:** `apps/db-ops-api/src/server-database-service.ts:299-301`
**Issue:** When re-encrypting credentials during a partial update, the code determines the credential key name like this:

```typescript
const key = (data.credential_type || existing.credential_type) === 'password' ? 'password' : 'privateKey';
credPayload[key] = data.credential_value;
```

If `data.credential_type` is not provided in the update, it falls back to `existing.credential_type` from the database. However, if the credential_type was changed in a previous update (without also providing a new credential_value at that time), `existing.credential_type` may be stale and inconsistent with the actual stored credential structure. This can cause a SSH private key to be stored under the `password` key (or vice versa), which the collector then sends with the wrong authentication parameter, causing hard-to-diagnose connection failures.

**Fix:** When `credential_value` is provided but `credential_type` is not, read the credential type from the existing credentials by inspecting the decrypted payload (check if `password` vs `privateKey` key exists), rather than relying on the potentially-stale `credential_type` column. Alternatively, require `credential_type` whenever `credential_value` is provided.

---

## Warnings

### WR-01: Disk Usage Dashboard Metric Always Empty

**File:** `apps/db-ops-api/src/server-collector.ts:166-169`
**File:** `frontend/src/app/ui/views/servers-page.ts:593`

**Issue:** The collector explicitly filters out the `disk_usage` metric command at server-collector.ts:168:

```typescript
const metricsToCollect = definitions.filter(
  (def) => def.name !== 'disk_usage'
);
```

It stores per-mount `disk_usage_<mount>` values from `disk_detail` only. But the frontend's servers-page.ts:593 and server-detail.ts:400 both look for a metric named `disk_usage`:

```typescript
const diskMetric = this._getServerMetric(srv.id, "disk_usage");
```

Since no row with `metric_name = 'disk_usage'` is ever inserted, the disk usage badge always shows `--`. This is a functional regression — the disk column on the server list and the disk summary card on the detail page are permanently empty.

**Fix:** Either:
- Option A: Store the aggregate `disk_usage` alongside per-mount entries by calculating a sum of all mount usage percentages weighted by mount size, or store the aggregate `df -P` output as a separate metric row.
- Option B: Have the frontend compute aggregate disk usage from the per-mount `disk_usage_*` metric values.

### WR-02: Event Listener Leak on View Re-Creation

**File:** `frontend/src/app/ui/views/server-detail.ts:153-162`

**Issue:** The `firstUpdated()` lifecycle hook registers a `slide-navigate` event listener on `window`, but never removes it. Because this is a LitElement that can be re-created (e.g., navigating away and back to the server detail view), every navigation to the server-detail tab adds a new listener. After N navigations, N duplicate API calls fire per navigation event.

**Fix:** Store the listener reference and remove it in `disconnectedCallback`:

```typescript
private _navHandler: ((e: any) => void) | null = null;

override firstUpdated() {
  this._navHandler = (e: any) => { ... };
  window.addEventListener("slide-navigate", this._navHandler);
  this.loadFromUrl();
}

override disconnectedCallback() {
  super.disconnectedCallback();
  if (this._navHandler) {
    window.removeEventListener("slide-navigate", this._navHandler);
  }
}
```

### WR-03: Empty Catch Suppresses All Refresh Errors

**File:** `frontend/src/app/ui/views/server-detail.ts:264`

**Issue:** The `refreshCurrentTab()` method wraps both API calls and header updates in a bare `catch { /* ignore refresh errors */ }` block. Any network failure, server error, or JSON parse error during refresh is silently swallowed. The user pressing the refresh button never receives feedback if the refresh fails.

**Fix:** Log the error and optionally show a toast:

```typescript
} catch (err: any) {
  console.warn('[server-detail] refresh failed:', err);
  showToast(err.message || '刷新失败', 'error');
} finally {
  this.isRefreshing = false;
}
```

### WR-04: Internal SSH2 Property Access

**File:** `apps/db-ops-api/src/ssh-session-pool.ts:197-198`

**Issue:** The `_isConnected()` method accesses `(client as any)._sock?.writable`, reaching into the internal/private `_sock` property of the ssh2 Client object. This is fragile — a library update could rename or restructure this internal property without notice, causing all pool connections to be considered disconnected or leaking connections.

**Fix:** Use a more robust health check, such as sending a keepalive `ping` or checking `client.state` (if exposed by the library API). Alternatively, remove the stale-connection check from `getConnection` and rely solely on the `close` event handler and on-demand reconnection on command failure.

### WR-05: Potential Resource Leak on SSH Command Timeout

**File:** `apps/db-ops-api/src/ssh-session-pool.ts:281-283`

**Issue:** When an SSH command times out, the `setTimeout` reject fires but the SSH channel is never explicitly closed via `channel.close()`. The channel stream remains open and its event listeners (`data`, `close`, `error`) remain attached. For a single timeout the leak is negligible, but in a collection loop that runs every 5 minutes on many servers, accumulated leaked channels consume file descriptors and memory.

**Fix:** When the timeout fires, reject the promise AND close the channel:

```typescript
const timeout = setTimeout(() => {
  try { channel?.close(); } catch { /* ignore */ }
  reject(new Error(`SSH command timed out after ${this.config.commandTimeoutMs}ms: ${command.substring(0, 80)}`));
}, this.config.commandTimeoutMs);
```

### WR-06: Missing Credential Value Validation on Create

**File:** `apps/db-ops-api/src/server-database-service.ts:207-213`
**File:** `frontend/src/app/ui/views/servers-page.ts:416-421`

**Issue:** The frontend form in `servers-page.ts` only validates `host` and `credential_username` before submit (line 418), but the `credential_value` field (the actual SSH password or private key) is not validated as required. On the backend, `createServer` stores whatever value is passed — an empty string would result in an encrypted credential payload with an empty password/key. The collector would then attempt SSH authentication with empty credentials, get an authentication failure, transition the server to `unreachable`, and the user receives no specific feedback about why.

**Fix:** Add a frontend validation for `credential_value` when creating a new server (not on edit, where empty means "don't change"). Add backend validation as a defense-in-depth layer:

```typescript
if (!data.credential_value || data.credential_value.trim() === '') {
  return { success: false, error: 'SSH密码或私钥不能为空' };
}
```

---

## Info

### IN-01: Duplicate Failure Count Clearing

**File:** `apps/db-ops-api/src/server-collector.ts:113-114`
**File:** `apps/db-ops-api/src/server-collector.ts:237-238`

**Issue:** The failure count for a server is cleared twice on successful collection — once inside `_collectOneServer` (line 238) and once in the caller `_tick` (line 113). The duplication is harmless but is a code smell indicating unclear ownership of failure-count management.

**Fix:** Remove the `this.failureCounts.delete(server.id)` from `_tick` (line 113), keeping it only in `_collectOneServer` where the actual success is determined.

### IN-02: Browser alert() Used Instead of Toast

**File:** `frontend/src/app/ui/views/servers-page.ts:343`

**Issue:** When the auth endpoint returns 401, the code calls `alert("请先登录")` which triggers a browser-native dialog. The rest of the application uses `showToast()` for user notifications. This is inconsistent UX.

**Fix:** Replace `alert("请先登录")` with `showToast("请先登录", "warning")`.

### IN-03: Dynamic Import Pattern Repeated in Request Handlers

**File:** `apps/db-ops-api/server.ts` (multiple locations)

**Issue:** Several API route handlers use a dynamic import pattern to get the database connection pool:

```typescript
const pool = (await import('./src/db-connection.js')).dbConnection.getPool();
```

This is repeated in the server metrics routes (lines 1399, 1436, 1480) and elsewhere. `dbConnection` is already imported at the top of the file (line 27), so `dbConnection.getPool()` is available directly without dynamic imports. The dynamic import adds unnecessary overhead and makes the code harder to follow. In the user update route (line 516), it is used inside a `catch` block where no top-level import exists — that case is acceptable.

**Fix:** Use the already-imported `dbConnection`:

```typescript
const pool = dbConnection.getPool();
```

### IN-04: TOCTOU Race Condition in Server Duplicate Check

**File:** `apps/db-ops-api/src/server-database-service.ts:196-204`

**Issue:** The `createServer()` method checks for duplicate host+port with a SELECT before INSERT. Under concurrent requests, two creates for the same host+port could both pass the SELECT check and both insert. The `servers` table has no UNIQUE constraint on `(host, port)`.

**Fix:** Add a unique constraint on `(host, port)` to the servers table, making the conflict detection atomic.

---

_Reviewed: 2026-07-08T23:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
