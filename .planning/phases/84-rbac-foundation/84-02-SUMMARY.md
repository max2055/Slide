---
phase: 84-rbac-foundation
plan: 02
subsystem: auth/rbac
tags:
  - fastify
  - middleware
  - rbac
  - api
  - testing
dependency_graph:
  requires:
    - phase: 84-01
      provides: "RbacService class with 24 CRUD + permission lookup methods"
  provides:
    - requirePermission middleware factory with wildcard matching
    - requireInstanceAccess middleware factory
    - RBAC management API at /api/v1/rbac/*
    - Unit tests for both middleware factories
  affects:
    - Phase 84-03 (integration - register rbacApiRoutes in server.ts)
    - Phase 85 (frontend RBAC management console consumes /api/v1/rbac/* endpoints)
tech-stack:
  added: []
  patterns:
    - Fastify preHandler middleware factory pattern (matching existing requireRole signature)
    - Permission wildcard matching (direct, resource:*, *:action, super-admin *)
    - per-request permission lookup with no caching
key-files:
  created:
    - apps/db-ops-api/src/auth/require-permission.ts
    - apps/db-ops-api/src/auth/require-instance-access.ts
    - apps/db-ops-api/src/auth/rbac-api.ts
    - apps/db-ops-api/src/auth/require-permission.test.ts
    - apps/db-ops-api/src/auth/require-instance-access.test.ts
  modified: []
key-decisions:
  - "verifyToken passed as decorator on fastify instance in rbacApiRoutes (Plan 03 will wire it from server.ts)"
  - "No permission caching per RESEARCH.md recommendation — SQL JOIN with indexes is <5ms per request"
patterns-established:
  - "Wildcard matching: direct → resource:* → *:action → super-admin '*'"
  - "Instance access check reads instanceId from request.params.id (canonical rule for all instance-scoped routes)"
requirements-completed:
  - RBAC-01
  - RBAC-02
  - RBAC-03
  - RBAC-04
  - RBAC-05
  - RBAC-06
  - RBAC-07
metrics:
  duration: "10 minutes"
  completed: "2026-05-09"
---

# Phase 84 Plan 02: Middleware + API Summary

**requirePermission and requireInstanceAccess Fastify middleware factories with wildcard matching, RBAC management REST API at /api/v1/rbac/*, and 11 unit tests**

## Performance

- **Duration:** 10 minutes
- **Started:** 2026-05-09T21:27:00Z
- **Completed:** 2026-05-09T21:32:00Z
- **Tasks:** 3
- **Files created:** 5

## Accomplishments
- requirePermission middleware with 4-tier wildcard matching (direct, resource:*, *:action, super-admin *)
- requireInstanceAccess middleware reading instanceId from URL params with body-spoofing warning
- RBAC management API at /api/v1/rbac/* with 15 CRUD endpoints for roles, permissions, user-roles, instance-access
- 11 unit tests covering all middleware scenarios (7 for requirePermission, 4 for requireInstanceAccess)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create requirePermission and requireInstanceAccess middleware factories** - `18412de41f` (feat)
2. **Task 2: Create RBAC management API routes at /api/v1/rbac/*** - `f804065afa` (feat)
3. **Task 3: Create unit tests for requirePermission and requireInstanceAccess middleware** - `cd8cf4930d` (test)

## Files Created/Modified
- `apps/db-ops-api/src/auth/require-permission.ts` - requirePermission middleware factory with hasPermission wildcard matching function
- `apps/db-ops-api/src/auth/require-instance-access.ts` - requireInstanceAccess middleware factory reading from request.params.id
- `apps/db-ops-api/src/auth/rbac-api.ts` - Fastify plugin exporting rbacApiRoutes with 15 endpoints at /api/v1/rbac/*
- `apps/db-ops-api/src/auth/require-permission.test.ts` - 7 test cases for all wildcard patterns
- `apps/db-ops-api/src/auth/require-instance-access.test.ts` - 4 test cases (no-auth, missing id, denied, granted)

## Decisions Made
- verifyToken is accessed via fastify instance decorator in rbacApiRoutes (Plan 03 will wire it from server.ts at registration time)
- Tests follow the existing project pattern: mock dbConnection.getPool() and control mockExecute return values, rather than mocking RbacService directly
- Per-request permission lookup with no caching per RESEARCH.md recommendation

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Vitest 4.x `vi.mock` constructor compatibility: `vi.fn().mockImplementation(() => ({}))` with arrow functions fails because arrow functions cannot be constructors. Resolved by following the existing project test pattern (mock `dbConnection` instead of `RbacService`), which avoids the constructor mock issue entirely.

## Known Stubs

None found.

## Threat Flags

None found.

## Next Phase Readiness
- Middleware factories and RBAC API ready for integration
- Plan 84-03 needs to: register rbacApiRoutes in server.ts, pass verifyToken as decorator, audit 139 routes, delete old requireRole, update auth-database-service

## Self-Check: PASSED

- [x] `apps/db-ops-api/src/auth/require-permission.ts` exists
- [x] `apps/db-ops-api/src/auth/require-instance-access.ts` exists
- [x] `apps/db-ops-api/src/auth/rbac-api.ts` exists
- [x] `apps/db-ops-api/src/auth/require-permission.test.ts` exists
- [x] `apps/db-ops-api/src/auth/require-instance-access.test.ts` exists
- [x] Task 1 committed: `18412de41f`
- [x] Task 2 committed: `f804065afa`
- [x] Task 3 committed: `cd8cf4930d`
- [x] All 11 tests pass

---
*Phase: 84-rbac-foundation*
*Completed: 2026-05-09*
