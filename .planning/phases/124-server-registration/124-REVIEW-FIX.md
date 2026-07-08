---
phase: 124-server-registration
fixed_at: '2026-07-08T16:00:00Z'
review_path: .planning/phases/124-server-registration/124-REVIEW.md
iteration: 1
findings_in_scope: 11
fixed: 10
skipped: 1
status: all_fixed
---

# Phase 124: Code Review Fix Report

**Fixed at:** 2026-07-08T16:00:00Z
**Source review:** .planning/phases/124-server-registration/124-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 11
- Fixed: 10
- Skipped: 1

## Fixed Issues

### CR-01: Credential username silently overwritten to empty string on server edit

**Files modified:** `frontend/src/app/ui/views/servers-page.ts`, `apps/db-ops-api/src/server-database-service.ts`
**Commit:** 254ec3b
**Applied fix:** Frontend now deletes `credential_username` from body when empty on edit (alongside existing `credential_value` deletion). Backend guard condition changed from `data.credential_username !== undefined || data.credential_value !== undefined` to `(data.credential_username !== undefined && data.credential_username !== '') || (data.credential_value !== undefined && data.credential_value !== '')`, with corresponding empty-string check on the username assignment. This prevents empty string from silently overwriting stored credentials.

### WR-01: SSH host key verification bypass -- add TODO comment

**File:** `apps/db-ops-api/src/server-database-service.ts`
**Commit:** 6cb3d6d
**Applied fix:** Added comment above `hostVerifier: () => true` documenting that this is acceptable for test-connection only and production SSH connections must use stored host_key_fingerprint.

### WR-02: credential_type parity bug in updateServer

**File:** `apps/db-ops-api/src/server-database-service.ts`
**Commit:** 97e4042
**Applied fix:** Restructured credential merger to first check whether `credential_value` is provided and non-empty. When it is, the correct key (`password` or `privateKey`) is chosen based on `(data.credential_type || existing.credential_type)`. When credential_value is absent, existing decrypted fields are preserved individually, avoiding the bug where changing credential_type caused access to the wrong decrypted field.

### WR-03: Missing UNIQUE(host, port) constraint

**File:** `apps/db-ops-api/sql/migrations/019_add_servers_table.sql`
**Commit:** c96f26f
**Applied fix:** Added `UNIQUE INDEX uq_host_port (host, port)` inline in the CREATE TABLE statement, preventing duplicate host+port entries at the database level.

### WR-04: SSH client cleanup on connection error

**File:** `apps/db-ops-api/src/server-database-service.ts`
**Commit:** d974918
**Applied fix:** Added `client.end()` call in the `'error'` event handler to match the cleanup that already exists in the `'ready'` handler, preventing resource leaks on connection failure.

### WR-05: Missing server-detail icon in iconForTab

**File:** `frontend/src/app/ui/navigation.ts`
**Commit:** 169d0c4
**Applied fix:** Added `case "server-detail": return "server";` to the `iconForTab` function alongside the existing `servers` case, so server-detail pages show the correct server icon instead of the default folder icon.

### WR-06: (state as any).serverId type cast

**Files modified:** `frontend/src/app/ui/app-view-state.ts`, `frontend/src/app/ui/app-render.ts`
**Commit:** c73f917
**Applied fix:** Added `serverId?: number;` to the `AppViewState` type definition in `app-view-state.ts`, then changed `(state as any).serverId` to `state.serverId` in `app-render.ts`. This removes the unsafe type cast and lets the type system verify the property.

### IN-02: Extra fields sent to test-connection

**File:** `frontend/src/app/ui/views/servers-page.ts`
**Commit:** 087980f
**Applied fix:** Changed `body: JSON.stringify(this._form)` to construct a body with only the required fields (`host`, `port`, `credential_type`, `credential_username`, `credential_value`), reducing unnecessary data sent to the test-connection endpoint.

### IN-03: Double semicolons in server.ts

**File:** `apps/db-ops-api/server.ts`
**Commit:** 7644e77
**Applied fix:** Removed the extra semicolon from three `warnUnknown()` calls (lines 641, 1163, 1194), and added missing semicolons to the preceding `createInstance`/`updateInstance` calls on lines 1162 and 1193.

### IN-04: Redundant custom element guard comment

**File:** `frontend/src/app/ui/views/servers-page.ts`
**Commit:** 6962877
**Applied fix:** Added `// Guard against duplicate registration during HMR` comment above the `customElements.get("servers-page")` guard at the end of the file, clarifying the purpose of the otherwise-redundant check.

## Skipped Issues

### IN-01: MySQL migration transaction not atomic for DDL

**File:** `apps/db-ops-api/sql/migrations/019_add_servers_table.sql:10-56`
**Reason:** No code change needed -- this is the standard MySQL migration pattern across the codebase. MySQL implicitly commits before and after DDL statements, which is a well-known limitation. The same pattern exists in all other migrations and is considered acceptable.
**Original issue:** MySQL wraps migration in `START TRANSACTION`/`COMMIT` but DDL statements (`CREATE TABLE`) cause implicit commits, breaking transaction atomicity.

---

_Fixed: 2026-07-08T16:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
