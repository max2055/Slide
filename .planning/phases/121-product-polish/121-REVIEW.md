---
phase: 121-product-polish
reviewed: 2026-06-25T08:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - apps/db-ops-api/src/consistency-checker.ts
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/src/consistency-checker.test.ts
  - frontend/src/app/ui/views/health-center.ts
  - frontend/src/app/ui/views/settings-shell.ts
  - frontend/src/app/ui/views/rbac-page.ts
  - frontend/src/app/ui/views/users-management.ts
  - frontend/src/app/ui/views/cron-jobs-settings.ts
findings:
  critical: 0
  warning: 5
  info: 5
  total: 10
status: issues_found
---

# Phase 121: Code Review Report

**Reviewed:** 2026-06-25T08:00:00Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Reviewed 8 source files (3 backend, 5 frontend) covering the consistency checker system, server API routes, health-center page, settings shell navigation, RBAC page, users management, and cron jobs settings. Found 5 warnings and 5 info items. No critical/blocker issues found. The code is generally well-structured and follows the project conventions, but several bugs related to state cleanup, partial data loss risk, and dead code were identified.

---

## Warnings

### WR-01: Cron jobs polling interval never cleaned up on disconnect

**File:** `frontend/src/app/ui/views/cron-jobs-settings.ts:362-383`
**Issue:** The `pollJobStatus()` method starts a `setInterval` but the component does not implement `disconnectedCallback()` to clear it. If the user navigates away while polling is active, the interval keeps running indefinitely (up to 30 seconds). The interval callback updates component state (`this.loadCronJobs()`, `this.pollingJobIds`) on a disconnected component, and the interval ID is not stored on `this` so it cannot be cleaned up externally. This is a memory/resource leak.
**Fix:** Store the interval reference and implement `disconnectedCallback`:
```typescript
private _pollInterval: ReturnType<typeof setInterval> | null = null;

override disconnectedCallback() {
  super.disconnectedCallback();
  if (this._pollInterval) {
    clearInterval(this._pollInterval);
    this._pollInterval = null;
  }
}

private pollJobStatus(jobId: number) {
  if (this.pollingJobIds.has(jobId)) return;
  this.pollingJobIds = new Set(this.pollingJobIds).add(jobId);
  let attempts = 0;
  const maxAttempts = 10;
  this._pollInterval = setInterval(async () => {
    // ... existing logic ...
    if (attempts >= maxAttempts) {
      clearInterval(this._pollInterval!);
      this._pollInterval = null;
      // ...
    }
  }, 3000);
}
```

### WR-02: Role sync ordering can leave user with zero roles on partial failure

**File:** `frontend/src/app/ui/views/users-management.ts:451-477`
**Issue:** `_syncUserRole` first deletes ALL current roles, then adds the new role. If the addition step fails (network error, API error, 500), the user is left with no role assignments at all. The error is surfaced to the user, but the deletion was already committed. The operation should either add before removing (preferred) or use a transactional approach.
**Fix:** Reverse the order: add the new role first, then remove old roles. This way if the addition fails, the user retains their existing roles:
```typescript
// Add new role first
if (newRoleId !== null) {
  const res = await apiClient.post(`/v1/rbac/users/${userId}/roles`, { roleId: newRoleId });
  if (!res || (res as any).success === false) {
    throw new Error(`添加角色失败: ${(res as any)?.error || '未知错误'}`);
  }
}
// Then remove old roles (skip the one we just added if present)
for (const r of currentRoles) {
  if (r.role_id === newRoleId) continue;
  const res = await apiClient.delete(`/v1/rbac/users/${userId}/roles/${r.role_id}`);
  if (!res || (res as any).success === false) {
    throw new Error(`移除角色失败: ${(res as any)?.error || '未知错误'}`);
  }
}
```

### WR-03: JWT secret fallback invalidates all tokens on server restart

**File:** `apps/db-ops-api/server.ts:82`
**Issue:** `JWT_SECRET` falls back to `randomBytes(32).toString('hex')` when `JWT_SECRET_KEY` is not set in the environment. This generates a new random key on every server start, which invalidates all existing JWT tokens immediately. Users are forced to re-login after any restart. The `.env.example` shows this should be configured, but the silent fallback masks a serious operational issue.
**Fix:** Throw a startup error if `JWT_SECRET_KEY` is not set instead of silently generating an ephemeral key:
```typescript
const JWT_SECRET = process.env.JWT_SECRET_KEY;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET_KEY must be set in environment (min 32 chars)');
  process.exit(1);
}
```

### WR-04: Server listens on 0.0.0.0 exposing API to all network interfaces

**File:** `apps/db-ops-api/server.ts:4295`
**Issue:** `fastify.listen({ port: Number(port), host: '0.0.0.0' })` binds the API server to all network interfaces. While CORS is restricted to localhost origins, the server is still reachable from other hosts on the network, which could be exploited if the network is not trusted. The default should be `127.0.0.1` (localhost-only), with `0.0.0.0` configurable via an environment variable for production reverse proxy setups.
**Fix:** Use `127.0.0.1` by default, or make the host configurable:
```typescript
const bindHost = process.env.BIND_HOST || '127.0.0.1';
await fastify.listen({ port: Number(port), host: bindHost });
```

### WR-05: `formSaving` state not reset in `closeFormDialog`

**File:** `frontend/src/app/ui/views/cron-jobs-settings.ts:285-291`
**Issue:** After a successful save, `formSaving` remains `true` because it is only reset in the `catch` branch (line 309) and in `openCreateDialog`/`openEditDialog`. The `closeFormDialog()` method does not reset `this.formSaving = false`. While the dialog is closed immediately on success (so the button is not rendered), any code path where the dialog attempts to remain open after saving would have a permanently disabled "保存" button showing "保存中...". This is a latent fragility.
**Fix:** Add `this.formSaving = false;` to `closeFormDialog()`:
```typescript
private closeFormDialog() {
  this.showCreateDialog = false;
  this.editingJob = null;
  this.formName = "";
  this.formTaskDescription = "";
  this.formError = null;
  this.formSaving = false; // ADD THIS
}
```

---

## Info

### IN-01: Dead import `ReportType` in server.ts

**File:** `apps/db-ops-api/server.ts:33`
**Issue:** `ReportType` is imported from `./src/report-database-service.js` but never referenced anywhere in server.ts. This is dead code that adds unnecessary module loading and increases cognitive load.
**Fix:** Remove the unused import:
```typescript
// Remove: import { ReportType } from './src/report-database-service.js';
// Keep only what's used:
import { reportDatabaseService } from './src/report-database-service.js';
```

### IN-02: Dead code `_openCreateInActiveTab` in rbac-page.ts

**File:** `frontend/src/app/ui/views/rbac-page.ts:151-158`
**Issue:** The method `_openCreateInActiveTab()` is defined on `RbacAdminPage` but never called from any template or lifecycle hook. The create buttons are rendered inside the sub-tab components (`role-management-tab` line 409, `permission-management-tab` line 666), not in the parent page header. This leaves dead code that will confuse future maintainers.
**Fix:** Remove the method and its associated event dispatching logic.

### IN-03: `cron-jobs` tab included in type but missing from navigation and render

**File:** `frontend/src/app/ui/views/settings-shell.ts:9-29,114-134`
**Issue:** The `SettingsSubTab` type includes `"cron-jobs"` (line 13), but the `SUB_TABS` array does not contain a cron-jobs entry, and `_renderTabContent()` has no `case "cron-jobs"`. The type and implementation are inconsistent. A developer adding cron-jobs to the nav would compile successfully but the page would not render.
**Fix:** Either add the cron-jobs tab to `SUB_TABS` and `_renderTabContent()`, or remove `"cron-jobs"` from the `SettingsSubTab` union type.

### IN-04: Inconsistent error response format across routes

**File:** `apps/db-ops-api/server.ts` (multiple locations)
**Issue:** Most error responses use `{ error: 'message' }` format, but some routes (e.g., lines 2509-2512, 757-758) use `{ success: false, error: 'message' }`. The frontend may need to handle both formats. This inconsistency also makes API client code fragile (e.g., users-management.ts line 466 checks `(res as any).success === false`, which would be `undefined` if the backend uses the `{ error }` format).
**Fix:** Standardize on a single error response format across all routes (either `{ error }` or `{ success: false, error }`). The `{ error }` format is the dominant pattern in this codebase and should be the standard.

### IN-05: Import extension inconsistency (.ts vs .js) in frontend files

**Files:**
- `frontend/src/app/ui/views/health-center.ts:7` — uses `.js`: `import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";`
- `frontend/src/app/ui/views/rbac-page.ts:2` — uses `.ts`: `import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";`
- `frontend/src/app/ui/views/users-management.ts:2` — uses `.ts`
- `frontend/src/app/ui/views/cron-jobs-settings.ts:6` — uses `.ts`
**Issue:** The codebase inconsistently uses `.ts` and `.js` extensions for importing TypeScript source files. Both work in Vite, but this inconsistency is confusing and makes it harder to audit import paths.
**Fix:** Normalize to the project-standard convention. Vite recommends `.js` extension in source imports for TypeScript files (as they will be compiled to `.js`).

---

_Reviewed: 2026-06-25T08:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
