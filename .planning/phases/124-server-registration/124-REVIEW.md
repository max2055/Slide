---
phase: 124-server-registration
reviewed: 2026-07-08T23:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/sql/migrations/019_add_servers_table.sql
  - apps/db-ops-api/src/server-database-service.ts
  - frontend/src/app/i18n/locales/en.ts
  - frontend/src/app/i18n/locales/zh-CN.ts
  - frontend/src/app/ui/app-render.ts
  - frontend/src/app/ui/app-view-state.ts
  - frontend/src/app/ui/navigation.ts
  - frontend/src/app/ui/views/servers-page.ts
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 124: Code Review Report (Final Pass -- Iteration 3)

**Reviewed:** 2026-07-08T23:00:00Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** clean (all issues resolved)

## Summary

Final verification pass over Phase 124 (Server Registration and Credential Management). All 12 cumulative fixes from iterations 1 and 2 are verified as correctly applied and intact. One new critical issue was discovered: the `tabs.server-detail` i18n key is missing from both locale files (en.ts and zh-CN.ts), causing the page header breadcrumb to display the raw key string "tabs.server-detail" when viewing any server detail page. No warnings or info items remain.

## Cumulative Fix Verification (Iterations 1 and 2)

### CR-01 (254ec3b): Credential username silently overwritten on server edit

**Status: PASS**

Frontend (`servers-page.ts:374-375`) deletes empty `credential_username` from PUT body on edit:
```typescript
if (!body.credential_username) delete body.credential_username;
```

Backend (`server-database-service.ts:271-272`) re-encryption guard uses strict emptiness check:
```typescript
if ((data.credential_username !== undefined && data.credential_username !== '')
    || (data.credential_value !== undefined && data.credential_value !== ''))
```

All four edit scenarios verified:
- **No credential fields touched**: both deleted from body, backend skips re-encryption -- existing credentials preserved
- **Only username filled**: sent to backend, re-encrypted with existing value under same credential_type key
- **Only value filled**: sent to backend, re-encrypted with existing username under correct type key
- **Both filled**: normal re-encryption with full payload

### WR-01 (6cb3d6d): SSH host key verification permanently bypassed

**Status: PASS**

Comment added at `server-database-service.ts:369-371`:
```typescript
// hostVerifier: accept any host key for initial test-connection.
// Production SSH connections MUST use the stored host_key_fingerprint for verification.
hostVerifier: () => true,
```

### WR-02 (97e4042): Credential merger parity with instance pattern

**Status: PASS**

Restructured credential merger at `server-database-service.ts:274-289` correctly:
- Preserves `username` from decrypted when `credential_username` is not provided or empty
- Uses `(data.credential_type || existing.credential_type)` to determine the correct key (`password` or `privateKey`) when storing a new credential_value
- Preserves both `password` and `privateKey` from existing decrypted data when no new `credential_value` is provided

### WR-03 (c96f26f): Missing UNIQUE constraint

**Status: PASS**

`UNIQUE INDEX uq_host_port (host, port)` present in migration at line 33, atomic with the CREATE TABLE statement.

### WR-04 (d974918): SSH client leak on connection error

**Status: PASS**

`client.end()` called in both `ready` and `error` handlers at `server-database-service.ts:353-361`. The `ssh2` library's `Client.end()` is documented as safe to call even if the connection was never fully established.

### WR-05 (169d0c4): Missing `server-detail` icon

**Status: PASS**

`case "server-detail": return "server";` at `navigation.ts:228-229`.

### WR-06 (c73f917): `(state as any).serverId` type safety

**Status: PASS**

- `serverId?: number;` declared in `AppViewState` type at `app-view-state.ts:46`
- Used directly as `state.serverId` in `app-render.ts:702` without `as any` cast

### IN-02 (087980f): test-connection body cleanup

**Status: PASS**

Frontend test-connection body at `servers-page.ts:442-449` sends only `host`, `port`, `credential_type`, `credential_username`, `credential_value`. Backend route at `server.ts:1355-1366` validates with `strictBody` using the exact same field set.

### IN-03 (7644e77): Double semicolons

**Status: PASS**

No `;;` sequences present in `server.ts`.

### IN-04 (6962877): HMR guard comment

**Status: PASS**

Guard at `servers-page.ts:848-851` prevents duplicate `customElements.define` during HMR.

### WR-07 (19dd5cb): credential_type change without new credential_value

**Status: PASS**

Guard at `server-database-service.ts:259-265` correctly rejects credential_type change when credential_value is empty AND the stored type differs from the new type. The early return happens before any DB writes, so the database is left in a consistent state. Error propagation to API route (server.ts:1328-1332) and frontend (servers-page.ts:384-387) is intact.

Interaction with WR-02 credential merger verified: the guard evaluates and returns before any update logic runs, so no interference occurs. When credential_value IS provided with a type change, the merger at line 281 correctly uses `data.credential_type` (the new type) to determine the payload key.

Minor note: `getServerById()` is fetched twice when credential_type changes with a provided credential_value (once in guard at line 262, once in merger at line 274). This is an extra DB round trip but not a correctness issue.

### IN-05 (b081f7b): Optional chaining in `_getServerMetric`

**Status: PASS**

Optional chaining `this._metricSummary.servers?.[serverId]` at `servers-page.ts:538`. Correctly guards against null `_metricSummary` (returns null) and missing server IDs (returns null). Existing logic at line 539 (`if (!serverMetrics) return null`) handles the undefined case correctly.

## Critical Issues

### CR-01: Missing i18n key `tabs.server-detail` in both locale files — RESOLVED

**File:** `frontend/src/app/i18n/locales/en.ts` (between lines 156-157)
**File:** `frontend/src/app/i18n/locales/zh-CN.ts` (between lines 158-159)

**Issue (originally found in iteration 3):** The `server-detail` tab is defined as a valid `Tab` type in `navigation.ts` (line 31), has a registered path at line 58, and is rendered conditionally in `app-render.ts` (lines 701-703) when `state.tab === "server-detail"`. The `dashboard-header` component at `app-render.ts:322` passes `state.tab` as its `tab` property unconditionally. `DashboardHeader.render()` calls `titleForTab(this.tab)` which resolves to `t('tabs.server-detail')`.

The i18n key `tabs.server-detail` did **not** exist in either locale file. The `t()` function at `translate.ts:138` returns the raw key string when the key is missing:
```typescript
if (typeof value !== "string") {
  return key;  // returns "tabs.server-detail"
}
```

This meant the page header breadcrumb rendered "Slide > tabs.server-detail" (a raw i18n key string) instead of a human-readable label like "Server Detail" (English) or "服务器详情" (Chinese) when viewing any server detail page.

**Impact:** All users navigating to a server detail page saw a broken/untranslated breadcrumb label. Affected both English and Chinese locales. The bug was visible immediately upon navigating from the servers list to a server detail page.

**Fix applied (commit `b672a8c`):** Added the `tabs.server-detail` key to both locale files:
- `en.ts:157` — `"server-detail": "Server Detail",`
- `zh-CN.ts:159` — `"server-detail": "服务器详情",`

See `124-REVIEW-FIX.md` (iteration 3) for the full fix report.

---

_Reviewed: 2026-07-08T23:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
