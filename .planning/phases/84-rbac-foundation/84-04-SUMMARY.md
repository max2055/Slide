---
phase: 84-rbac-foundation
plan: 04
subsystem: auth
tags: rbac, gap-closure, verifyToken, wildcard, collector-permissions
requires:
  - phase: 84-01
    provides: RbacService, SQL migration (user_roles table)
  - phase: 84-02
    provides: requirePermission/requireInstanceAccess middleware, rbac-api plugin
  - phase: 84-03
    provides: verifyToken not yet decorated for rbac-api.ts
provides:
  - fastify.decorate('verifyToken') fixes 18 RBAC management route auth
  - Server.ts no longer references dropped users.role column (3 locations fixed)
  - requireInstanceAccess checks wildcard permissions before instance_permissions query
  - collector:view and collector:manage permission codes seeded + assigned to dba role
affects: Phase 85 (RBAC Frontend), collector routes in server.ts
tech-stack:
  added: []
  patterns:
    - "fastify.decorate('verifyToken', verifyToken) before plugin registration"
    - "requireInstanceAccess short-circuits via getUserPermissions wildcard check"
key-files:
  created: []
  modified:
    - apps/db-ops-api/server.ts
    - apps/db-ops-api/src/auth/require-instance-access.ts
    - apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql
key-decisions:
  - "verifyToken.user.role is vestigial after RBAC migration — removing role spread is safe since all authorization uses requirePermission backed by RbacService"
  - "Only dba role gets collector permissions, matching pre-RBAC access pattern (developer/analyst/viewer/auditor do not)"
requirements-completed:
  - RBAC-01
  - RBAC-02
  - RBAC-03
  - RBAC-04
  - RBAC-05
  - RBAC-07
  - RBAC-08
duration: 10min
completed: 2026-05-09
---

# Phase 84 Plan 04: Gap Closure Summary

**Three critical gaps (CR-01, CR-02, CR-03) and one warning (WR-03) closed — verifyToken decorated, dropped column references removed, wildcard check added, collector permissions seeded**

## Performance

- **Duration:** 10 min
- **Started:** 2026-05-09T22:05:00Z
- **Completed:** 2026-05-09T22:15:00Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- **CR-01 fixed**: `fastify.decorate('verifyToken', verifyToken)` added before `fastify.register(rbacApiRoutes)` — all 18 `/api/v1/rbac/*` routes now have working authentication
- **CR-02 fixed**: All 3 references to the dropped `users.role` column removed from server.ts:
  - verifyToken middleware no longer overwrites `request.user` with undefined role
  - JWT signing payload no longer includes role
  - Login response no longer includes role
- **CR-03 fixed**: `requireInstanceAccess` middleware checks `getUserPermissions` for `'*'` and `'instance:*'` wildcards before querying `checkInstanceAccess` — admin users pass all instance operations without explicit `instance_permissions` rows
- **WR-03 fixed**: `collector:view` and `collector:manage` permission codes seeded in migration SQL and assigned to dba role — non-admin dba users can now access collector routes

## Verification Results

```
=== server.ts ===
decorate.*verifyToken:     1 ✓
role: (user as any).role:  0 ✓ (all 3 references removed)
(request as any).user = {  0 ✓ (old overwrite pattern removed)

=== require-instance-access.ts ===
getUserPermissions:         1 ✓
has('*'):                   1 ✓
has('instance:*'):          1 ✓
checkInstanceAccess:        1 ✓ (preserved)

=== migration SQL ===
collector:view  (INSERT):  1 ✓
collector:manage (INSERT): 1 ✓
collector dba assignment:  1 ✓ (lines 174)

=== TypeScript ===
apps/db-ops-api:           0 errors ✓
```

## Gaps Closed vs. Verification Report

| Gap | Status | Component | Symptom |
|-----|--------|-----------|---------|
| CR-01 | CLOSED | server.ts | verifyToken not decorated for RBAC API routes |
| CR-02 | CLOSED | server.ts | role references return undefined from dropped column |
| CR-03 | CLOSED | require-instance-access.ts | Admin gets 403 on instance operations |
| WR-03 | CLOSED | migration SQL | Non-admin collectors get 403 despite dba role |

## Task Commits

Each task was committed atomically:

1. **Task 1: CR-01 + CR-02 — decorate verifyToken, remove role column references** - `3fc43a3c46` (fix)
2. **Task 2: CR-03 — add wildcard check to requireInstanceAccess** - `4743f1ed25` (fix)
3. **Task 3: WR-03 — seed collector permission codes in migration** - `061e764caf` (fix)

## Files Modified

- **`apps/db-ops-api/server.ts`** - 7 insertions, 4 deletions: added `fastify.decorate('verifyToken', verifyToken)` before rbacApiRoutes registration; removed role from verifyToken assignment, JWT signing payload, and login response
- **`apps/db-ops-api/src/auth/require-instance-access.ts`** - 7 insertions: added getUserPermissions wildcard check ('*' and 'instance:*') before checkInstanceAccess query
- **`apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql`** - 5 insertions, 1 deletion: seeded collector:view and collector:manage permissions; assigned to dba role

## Decisions Made

- verifyToken.user.role is vestigial after RBAC migration — removing the role spread is safe because all authorization now uses `requirePermission` middleware which calls `RbacService.getUserPermissions`
- Only dba role gets collector permissions, matching the pre-RBAC access pattern where dba had collector access. Other roles (developer, analyst, viewer, auditor) do not get collector permissions

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

No issues encountered. All three files were straightforward modifications with clear acceptance criteria.

## Phase Goal Assessment

After these 4 fixes, Phase 84 goal is achievable:
- RBAC management API has working authentication (CR-01)
- Login flow no longer breaks from dropped column (CR-02)
- Admin users can access all instance operations without explicit rows (CR-03)
- Non-admin dba users can access collector routes (WR-03)

---
*Phase: 84-rbac-foundation Plan 04*
*Completed: 2026-05-09*
