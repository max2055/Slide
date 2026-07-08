---
phase: 124-server-registration
reviewed: 2026-07-08T16:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/sql/migrations/019_add_servers_table.sql
  - apps/db-ops-api/src/server-database-service.ts
  - frontend/src/app/i18n/locales/en.ts
  - frontend/src/app/i18n/locales/zh-CN.ts
  - frontend/src/app/ui/app-render.ts
  - frontend/src/app/ui/navigation.ts
  - frontend/src/app/ui/views/servers-page.ts
  - package.json
findings:
  critical: 1
  warning: 6
  info: 4
  total: 11
status: issues_found
---

# Phase 124: Code Review Report — Server Registration & Credential Management

**Reviewed:** 2026-07-08T16:00:00Z  
**Depth:** standard  
**Files Reviewed:** 9  
**Status:** issues_found  

## Summary

This review covers Phase 124 (Server Registration & Credential Management), which adds SSH server CRUD operations, encrypted credential storage, SSH connection testing, and key rotation. The implementation follows the existing `instance-database-service.ts` pattern closely, but contains one critical data corruption bug (credential username being silently overwritten to empty on edit), several security/robustness concerns, and minor code quality issues.

## Critical Issues

### CR-01: Credential username silently overwritten to empty string on server edit

**File:** `apps/db-ops-api/src/server-database-service.ts:264-279`  
**File:** `frontend/src/app/ui/views/servers-page.ts:333-341`

**Issue:** When a user edits any field on an existing server (e.g., changing the label) and submits the form **without touching the credential fields**, the stored credential username gets silently wiped to empty string. This breaks SSH connectivity for the affected server.

**Root cause chain:**

1. **Frontend** (`servers-page.ts:333-341`) — The edit dialog initializes `credential_username: ""` and `credential_value: ""`. The form never pre-fills the username because the backend strips all credential data from the GET response for security.

2. **Frontend** (`servers-page.ts:373-376`) — `_handleSubmit` only deletes `credential_value` from the body when empty:
   ```typescript
   if (isEdit && !body.credential_value) {
     delete body.credential_value;
   }
   ```
   It does **not** delete `credential_username`, so the body always includes `credential_username: ""` on edit.

3. **Backend** (`server-database-service.ts:264-270`) — `updateServer` enters the re-encryption block when `data.credential_username !== undefined` (true — it is `""`):
   ```typescript
   username: data.credential_username !== undefined ? data.credential_username : decrypted.username,
   ```
   Since `data.credential_username` is `""` (not undefined), the new credential payload stores `username: ""`.

4. The re-encrypted credential with empty username overwrites the previously valid credential. Any subsequent SSH connection to this server using `decryptedCredentials()` will fail.

**Contrast with instance-database-service.ts:268-271** — The instance service uses a safer pattern:
```typescript
if (data.password !== undefined && data.password !== '') {
  updates.push('password_encrypted = ?');
  values.push(encryptData(data.password));
}
```
It checks for non-empty string before re-encrypting.

**Fix:** Apply both frontend and backend changes for defense in depth:

**Frontend fix** — In `_handleSubmit`, also delete `credential_username` when empty on edit:
```typescript
if (isEdit) {
  if (!body.credential_value) delete body.credential_value;
  if (!body.credential_username) delete body.credential_username;
}
```

**Backend fix** (`server-database-service.ts`) — Change the re-encryption guard to require non-empty credential_value, matching the instance-database-service pattern:
```typescript
// Only re-encrypt when credential_value is explicitly provided and non-empty
if (data.credential_value !== undefined && data.credential_value !== '') {
  // re-encryption logic...
}
```
Alternatively, add an empty-string check around the username and require both fields:
```typescript
if ((data.credential_username !== undefined && data.credential_username !== '')
    || (data.credential_value !== undefined && data.credential_value !== '')) {
```

## Warnings

### WR-01: SSH host key verification permanently bypassed in testConnection

**File:** `apps/db-ops-api/src/server-database-service.ts:357`

**Issue:** The `testConnection` method sets `hostVerifier: () => true`, which unconditionally accepts any SSH host key. This disables MITM protection for SSH connections during the test flow. While the default ssh2 behavior (when no hostVerifier is provided) also auto-accepts (see `kex.js:1194-1198`), the explicit bypass should at minimum be documented with a TODO to add host key verification in production collection flows.

**Fix:** Add a comment explaining why this is acceptable for test-connection (no session is established, host key not yet stored) and note that production connections (via `server-collector`) should implement proper `hostKeyFingerprint` verification:
```typescript
// hostVerifier: accept any host key for initial test-connection.
// Production SSH connections MUST use the stored host_key_fingerprint for verification.
hostVerifier: () => true,
```

### WR-02: `updateServer` credential_type parity bug when changing auth type

**File:** `apps/db-ops-api/src/server-database-service.ts:272-276`

**Issue:** When `updateServer` re-encrypts credentials **and** the credential_type is being changed (e.g., from `'password'` to `'key'`), line 272 makes an incorrect assumption about the existing decrypted payload:

```typescript
if (data.credential_type === 'password' || (!data.credential_type && existing.credential_type === 'password')) {
  credPayload.password = ...;
} else {
  credPayload.privateKey = ...;
}
```

If `data.credential_type` is `'key'` (new value) but the existing credentials were of type `'password'`, the `else` branch accesses `decrypted.privateKey`, which is `undefined`. The `|| ''` fallback at line 275 then stores an empty private key, corrupting credentials.

This only triggers when the user explicitly changes credential_type AND provides a new credential_username but NOT a new credential_value — an unlikely but possible edge case.

**Fix:** Restructure the credential merger to always try both fields from decrypted data and explicitly handle absent fields:
```typescript
// Build credential payload from existing decrypted + overrides
const credPayload: Record<string, string> = {};
credPayload.username = data.credential_username !== undefined && data.credential_username !== ''
  ? data.credential_username
  : decrypted.username;

if (data.credential_value !== undefined && data.credential_value !== '') {
  credPayload[data.credential_type || existing.credential_type === 'password' ? 'password' : 'privateKey'] = data.credential_value;
} else {
  // Preserve existing credentials as-is (for non-password fields, keep both)
  if (decrypted.password !== undefined) credPayload.password = decrypted.password;
  if (decrypted.privateKey !== undefined) credPayload.privateKey = decrypted.privateKey;
}
```

### WR-03: Race condition on duplicate host+port check (no DB-level UNIQUE constraint)

**File:** `apps/db-ops-api/sql/migrations/019_add_servers_table.sql:15-33`  
**File:** `apps/db-ops-api/src/server-database-service.ts:178-186`

**Issue:** The `createServer` method performs an application-level duplicate check for host+port before inserting (lines 178-186), but there is no corresponding `UNIQUE(host, port)` constraint on the `servers` table. Two concurrent `createServer` requests could both pass the check and insert duplicate host+port entries. The same pattern exists in `instance-database-service.ts` (pre-existing), but new tables should correct this.

**Fix:** Add a UNIQUE constraint on `(host, port)` in the migration:
```sql
ALTER TABLE `servers` ADD UNIQUE INDEX `uq_host_port` (`host`, `port`);
```
Or add it inline in the CREATE TABLE statement:
```sql
UNIQUE INDEX `uq_host_port` (`host`, `port`),
```

### WR-04: Unhandled SSH client cleanup on connection error

**File:** `apps/db-ops-api/src/server-database-service.ts:348-350`

**Issue:** The `testConnection` method's `'error'` event handler resolves the promise but never calls `client.end()` or `client.destroy()`. If a connection error occurs after partially establishing resources (e.g., socket opened but authentication failed), the client event loop may retain references, leading to a resource leak. The `'ready'` handler calls `client.end()` (line 344), but the error path does not.

**Fix:** Add cleanup in the error handler:
```typescript
client.on('error', (err: Error) => {
  client.end();  // or client.destroy()
  resolve({ success: false, message: `连接失败：${err.message}` });
});
```

### WR-05: Missing `server-detail` icon entry in navigation.ts `iconForTab`

**File:** `frontend/src/app/ui/navigation.ts:206-261`

**Issue:** The `iconForTab` function defines cases for 22 tab names but does not include `'server-detail'`. This causes it to fall through to the `default` branch at line 258, returning the generic `"folder"` icon. By comparison, `'instance-detail'` has a dedicated case at line 254-255 returning `"database"`. The `servers` tab (line 227) correctly returns `"server"`.

**Fix:** Add a case for `'server-detail'`:
```typescript
case "server-detail":
  return "server";
```

### WR-06: `(state as any).serverId` type cast masks missing property

**File:** `frontend/src/app/ui/app-render.ts:702`

**Issue:** Line 702 passes `(state as any).serverId` to the `<server-detail>` component:
```typescript
${state.tab === "server-detail"
  ? html`<server-detail .serverId=${(state as any).serverId}></server-detail>`
```
The `as any` cast silences a TypeScript error because `serverId` is not a declared property on `AppViewState`. This means the type system cannot catch misspellings or refactoring that renames the property. If the state shape changes, this binding silently becomes `undefined`.

**Fix:** Add `serverId` to the `AppViewState` interface (or the relevant type) so the cast is unnecessary:
```typescript
// In AppViewState type definition:
serverId?: number;
```
Then use `state.serverId` directly without casting.

## Info

### IN-01: MySQL migration transaction not atomic for DDL

**File:** `apps/db-ops-api/sql/migrations/019_add_servers_table.sql:10-56`

**Issue:** The migration wraps everything in `START TRANSACTION` / `COMMIT`, but MySQL performs an implicit COMMIT before and after DDL statements (like `CREATE TABLE`). The `CREATE TABLE` on line 15 effectively breaks the transaction: if the subsequent INSERT statements fail, the table creation is not rolled back. This is a well-known MySQL limitation and the same pattern exists in other migrations, but it means the migration is not fully atomic.

**Fix:** No code change needed — this is the standard MySQL migration pattern across the codebase. Document the limitation if not already understood.

### IN-02: Extra fields sent to test-connection endpoint

**File:** `frontend/src/app/ui/views/servers-page.ts:441-442`

**Issue:** The `_handleTestConnection` method sends the entire `_form` object (including `label`, `os_type`, `os_type`, etc.) to the test-connection endpoint:
```typescript
body: JSON.stringify(this._form),
```
The backend validates only required fields via `strictBody`, so extra fields are silently ignored. This is not a bug, but sending unnecessary data is slightly wasteful.

**Fix:** Construct the body with only the required fields:
```typescript
body: JSON.stringify({
  host: this._form.host,
  port: this._form.port,
  credential_type: this._form.credential_type,
  credential_username: this._form.credential_username,
  credential_value: this._form.credential_value,
}),
```

### IN-03: Double semicolons after `warnUnknown` calls in server.ts

**File:** `apps/db-ops-api/server.ts:641, 1163, 1194`

**Issue:** Several `warnUnknown()` calls end with `;;` — two consecutive semicolons. While syntactically valid JavaScript (the second `;` is a no-op), this is likely a copy-paste artifact and may trigger lint warnings.

**Fix:** Remove the extra semicolons at lines 641, 1163, and 1194.

### IN-04: Redundant custom element guard in `servers-page.ts`

**File:** `frontend/src/app/ui/views/servers-page.ts:841-843`

**Issue:** The `@customElement("servers-page")` decorator (line 56) already registers the element via `customElements.define()`. The manual guard at lines 841-843 is redundant. This may be intentional for HMR support (to avoid duplicate registration errors during hot reload), but it should have a comment explaining that.

**Fix:** Either remove the guard or add a comment:
```typescript
// Guard against duplicate registration during HMR
```

---

_Reviewed: 2026-07-08T16:00:00Z_  
_Reviewer: Claude (gsd-code-reviewer)_  
_Depth: standard_
