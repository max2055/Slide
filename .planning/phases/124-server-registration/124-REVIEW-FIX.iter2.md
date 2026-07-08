---
phase: 124-server-registration
fixed_at: 2026-07-08T17:00:00Z
review_path: .planning/phases/124-server-registration/124-REVIEW.md
iteration: 2
findings_in_scope: 2
fixed: 2
skipped: 0
status: all_fixed
---

# Phase 124: Code Review Fix Report

**Fixed at:** 2026-07-08T17:00:00Z
**Source review:** .planning/phases/124-server-registration/124-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 2
- Fixed: 2
- Skipped: 0

## Fixed Issues

### WR-07: credential_type change without credential_value causes payload/DB mismatch

**File:** `apps/db-ops-api/src/server-database-service.ts`
**Commit:** `19dd5cb`
**Applied fix:** Added a guard at the start of the `credential_type` update block in `updateServer`. When `credential_type` is provided and no `credential_value` is given, the fix fetches the existing server record and compares the old and new `credential_type`. If they differ, the function returns `{ success: false, error: '更换认证方式时必须提供新的凭据值' }` before any SQL updates are applied. This prevents the DB column from being updated to a new type while the encrypted payload retains the old structure.

### IN-05: _getServerMetric accesses servers property without optional chaining

**File:** `frontend/src/app/ui/views/servers-page.ts`
**Commit:** `b081f7b`
**Applied fix:** Changed `this._metricSummary.servers[serverId]` to `this._metricSummary.servers?.[serverId]` in the `_getServerMetric` method. This guards against the `servers` property being undefined at runtime (e.g., during version mismatch between frontend and backend), preventing a potential TypeError.

---

_Fixed: 2026-07-08T17:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
