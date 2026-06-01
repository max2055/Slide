---
phase: 84-rbac-foundation
verified: 2026-05-09T23:07:00Z
status: passed
score: 12/12 must-haves verified
overrides_applied: 0
re_verification: true
previous_status: gaps_found
previous_score: 9/12
gaps_closed:
  - "CR-01: verifyToken not decorated on fastify instance — all 18 /api/v1/rbac/* routes were missing authentication"
  - "CR-02: server.ts still reads (user as any).role in 3 places (verifyToken, JWT signing, login response) — returns undefined after column drop"
  - "CR-03: requireInstanceAccess only checks instance_permissions table and ignores role-based wildcards — admin with '*' gets 403 on instance operations"
  - "WR-03: collector:view and collector:manage permission codes not seeded in migration SQL — non-admin users with dba role get 403 on collector routes"
gaps_remaining: []
regressions: []
deferred: []
---

# Phase 84: RBAC Foundation Verification Report (Re-verification)

**Phase Goal:** Admin can manage custom roles, permission points, user-role bindings, and instance-level access through backend APIs, with middleware enforcing access control on all protected routes

**Verified:** 2026-05-09T23:07:00Z

**Status:** passed

**Re-verification:** Yes -- after gap closure (Plan 84-04)

## Previous Verification Summary

**Previous status:** gaps_found (score: 9/12)
**3 critical gaps + 1 warning identified** on 2026-05-09T22:10:00Z

Plan 84-04 executed 3 tasks to close all 4 gaps. All gaps confirmed closed.

### Gap Closure Status

| Gap | Priority | Previous Status | Current Status | Fix Evidence |
| --- | -------- | --------------- | -------------- | ------------ |
| CR-01: verifyToken not decorated | CRITICAL | FAILED | CLOSED | `fastify.decorate('verifyToken', verifyToken)` at server.ts line 135, before `fastify.register(rbacApiRoutes)` at line 138 |
| CR-02: server.ts reads users.role in 3 places | CRITICAL | FAILED | CLOSED | verifyToken line 97: `(request as any).user = decoded` (no role spread). JWT signing line 163: no role. Login response line 176: no role. Only comments remain. |
| CR-03: requireInstanceAccess ignores wildcards | CRITICAL | FAILED | CLOSED | require-instance-access.ts lines 25-26: `getUserPermissions` called, `'*'` and `'instance:*'` wildcards checked before `checkInstanceAccess` |
| WR-03: collector permissions not seeded | WARNING | FAILED | CLOSED | `collector:view` and `collector:manage` seeded in permissions INSERT, assigned to dba role in role_permissions INSERT |

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 5 RBAC tables (roles, permissions, role_permissions, user_roles, instance_permissions) exist in MySQL schema | VERIFIED | apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql has 5 CREATE TABLE statements -- one for each table |
| 2 | Default roles (admin, dba, developer, analyst, viewer, auditor) are seeded with appropriate permission codes | VERIFIED | 6 roles seeded via `INSERT IGNORE INTO roles`. 33+ permission codes seeded. Role-permission assignments via INSERT INTO role_permissions for each role |
| 3 | Admin role has '*' permission code assigned via role_permissions so getUserPermissions returns Set(['*']) for admin users | VERIFIED | Migration has `INSERT INTO role_permissions ... WHERE r.name = 'admin' AND p.code = '*'`. Test confirms `Set(['*'])` behavior |
| 4 | Existing users migrated from users.role to user_roles, old column dropped after migration | VERIFIED | Migration SQL: INSERT INTO user_roles with JOIN on roles.name, DROP COLUMN role. server.ts no longer references user.role in verifyToken, JWT signing, or login response (CR-02 fixed) |
| 5 | RbacService provides CRUD methods for all 5 entities and permission lookup queries | VERIFIED | 574-line service with 25 async methods: 6 role CRUD, 6 permission CRUD, 4 role-permission, 4 user-role, 4 instance, 2 lookup. Uses parameterized queries |
| 6 | Permission codes follow resource:action namespace convention (D-01) | VERIFIED | All 33+ codes use format (instance:view, alert:manage, user:create, etc.). '*' is special-case wildcard per D-02 |
| 7 | requirePermission middleware returns 403 for unauthorized, passes when authorized | VERIFIED | 61-line middleware with 4-tier wildcard matching (direct, resource:*, *:action, super-admin *). 7 unit tests pass |
| 8 | requireInstanceAccess returns 403 when user lacks access, passes when granted | VERIFIED | Middleware now checks role-based wildcards ('*' and 'instance:*') before instance_permissions query (CR-03 fixed). 4 unit tests pass |
| 9 | RBAC management API at /api/v1/rbac/* provides CRUD for roles, permissions, user-roles, instance-access | VERIFIED | 326-line plugin with 18 route definitions. All use preHandler: [verifyToken, requirePermission('admin:*')]. verifyToken decorated via fastify.decorate (CR-01 fixed) |
| 10 | All route registrations have appropriate preHandler middleware | VERIFIED | 114 requirePermission, 20 requireInstanceAccess (19 routes + 1 import), 0 requireRole in server.ts. 139 total route registrations audited |
| 11 | Old requireRole middleware deleted from auth-middleware.ts | VERIFIED | File is a 6-line deprecation stub with `export {};`. No imports remain in server.ts |
| 12 | auth-database-service no longer references users.role column or ENUM values | VERIFIED | User interface, SELECT queries, and updateUser all have zero role references. grep returns no matches |

**Score:** 12/12 truths verified

### Roadmap Success Criteria Status

| # | Success Criterion | Status | Evidence |
|---|-------------------|--------|----------|
| SC1 | Admin can create, edit, and delete custom roles with name and description via API | VERIFIED | /api/v1/rbac/roles routes defined with GET/POST/PUT/DELETE. RbacService.createRole/getRole/listRoles/updateRole/deleteRole implemented. verifyToken decorated (CR-01 fixed) |
| SC2 | Admin can define permission codes following `resource:action` namespace convention and assign them to roles | VERIFIED | /api/v1/rbac/permissions routes defined with GET/POST/DELETE. /api/v1/rbac/roles/:roleId/permissions routes for assignment |
| SC3 | Admin can assign multiple roles to a user (many-to-many) and grant instance-level access | VERIFIED | /api/v1/rbac/users/:userId/roles and /api/v1/rbac/users/:userId/instances routes defined |
| SC4 | Middleware enforces access on all protected routes, returning 403 | VERIFIED | 114 requirePermission + 20 requireInstanceAccess usages. 0 requireRole. Wildcard matching handles admin access (CR-03 fixed) |
| SC5 | Existing users migrated without permission loss | VERIFIED | Migration SQL migrates all existing users via JOIN. server.ts no longer references dropped column (CR-02 fixed) |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql` | 5 RBAC tables + seed + migration | VERIFIED | 5 CREATE TABLE statements, 6 roles seeded, 33+ permission codes, user migration, DROP COLUMN role, single transaction |
| `apps/db-ops-api/src/auth/rbac-service.ts` | RbacService CRUD + lookup | VERIFIED | 574 lines, 25 async methods, named export, parameterized queries |
| `apps/db-ops-api/src/auth/rbac-service.test.ts` | Unit tests for RbacService | VERIFIED | 334 lines, 6 describe blocks, 32 tests, all passed |
| `apps/db-ops-api/src/auth/migration.test.ts` | Migration integration test | VERIFIED | 247 lines, validates 5 tables + seeds + migration, graceful skip when MySQL unavailable |
| `apps/db-ops-api/src/auth/require-permission.ts` | requirePermission middleware | VERIFIED | 61 lines, 4-tier wildcard matching, exported function |
| `apps/db-ops-api/src/auth/require-instance-access.ts` | requireInstanceAccess middleware | VERIFIED | 49 lines, CR-03 wildcard check added, preserves checkInstanceAccess |
| `apps/db-ops-api/src/auth/rbac-api.ts` | RBAC management API routes | VERIFIED | 326 lines, 18 route definitions at /api/v1/rbac/*, uses verifyToken decorator |
| `apps/db-ops-api/src/auth/require-permission.test.ts` | requirePermission tests | VERIFIED | 103 lines, 7 test cases, all passed |
| `apps/db-ops-api/src/auth/require-instance-access.test.ts` | requireInstanceAccess tests | VERIFIED | 75 lines, 4 test cases, all passed |
| `apps/db-ops-api/server.ts` | Updated route registrations | VERIFIED | 2941 lines, 114 requirePermission, 20 requireInstanceAccess, 0 requireRole, rbacApiRoutes registered with verifyToken decorator |
| `apps/db-ops-api/src/auth-middleware.ts` | Deprecated requireRole | VERIFIED | 6-line deprecation stub with migration note |
| `apps/db-ops-api/src/auth/auth-database-service.ts` | Cleaned up (role removed) | VERIFIED | Zero role references in User interface, SELECT queries, or updateUser |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| rbac-service.ts | db-connection.getPool() | private getPool() | WIRED | Line 12: `private getPool() { return dbConnection.getPool(); }` |
| 002_add_rbac_tables.sql | users.role column | ALTER TABLE users DROP COLUMN role | WIRED | Line 378: `ALTER TABLE users DROP COLUMN role` |
| require-permission.ts | RbacService.getUserPermissions | rbacService.getUserPermissions(userId) | WIRED | Line 27: calls getUserPermissions, then wildcard matching |
| require-instance-access.ts | RbacService.checkInstanceAccess | rbacService.checkInstanceAccess(userId, instanceId) | WIRED | Line 44: calls checkInstanceAccess. CR-03 wildcard check added before (lines 25-26) |
| require-instance-access.ts | RbacService.getUserPermissions | rbacService.getUserPermissions(userId) | WIRED | Line 25: calls getUserPermissions for wildcard check |
| rbac-api.ts | RbacService methods | API handlers call rbacService.* | WIRED | 15+ references to rbacService methods across all route handlers |
| rbac-api.ts | requirePermission | requirePermission('admin:*') in preHandler | WIRED | All 18 routes use requirePermission('admin:*') |
| server.ts | require-permission.js | import | WIRED | Line 21: `import { requirePermission }` |
| server.ts | require-instance-access.js | import | WIRED | Line 22: `import { requireInstanceAccess }` |
| server.ts | rbac-api.js | fastify.register(rbacApiRoutes) | WIRED | Line 23: import, Line 138: register with verifyToken decorator at line 135 |
| server.ts | requirePermission | preHandler arrays | WIRED | 114 occurrences across route registrations |
| server.ts | verifyToken decorator | fastify.decorate('verifyToken', verifyToken) | WIRED | Line 135: `fastify.decorate('verifyToken', verifyToken)` before register(rbacApiRoutes) -- CR-01 fixed |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| require-permission.ts | userPermissions | rbacService.getUserPermissions(userId) via 3-table JOIN | Yes (parameterized SQL query) | FLOWING |
| require-instance-access.ts | userPermissions | rbacService.getUserPermissions(userId) via 3-table JOIN | Yes (parameterized SQL query) | FLOWING -- wildcard check added (CR-03) |
| require-instance-access.ts | hasAccess | rbacService.checkInstanceAccess(userId, instanceId) via COUNT(*) | Yes (parameterized SQL query) | FLOWING |
| rbac-api.ts | rbacService.* | Service methods with pool.execute() | Yes (parameterized queries) | FLOWING -- verifyToken decorated (CR-01) |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| ----------- | ------------ | ----------- | ------ | -------- |
| RBAC-01 | 84-01, 84-02 | Admin can create custom roles with name and description | SATISFIED | /api/v1/rbac/roles routes (GET/POST/PUT/DELETE). RbacService CRUD. verifyToken decorated (CR-01 fixed) |
| RBAC-02 | 84-01, 84-02 | Admin can define permission codes following resource:action convention | SATISFIED | /api/v1/rbac/permissions routes (GET/POST/DELETE). Validation ensures code matches `resource:action` format |
| RBAC-03 | 84-01, 84-02 | Admin can assign multiple permissions to a role (many-to-many) | SATISFIED | /api/v1/rbac/roles/:roleId/permissions routes (GET/POST/DELETE). role_permissions junction table |
| RBAC-04 | 84-01, 84-02, 84-03 | Admin can assign multiple roles to a user (many-to-many), replacing single ENUM role | SATISFIED | /api/v1/rbac/users/:userId/roles routes (GET/POST/DELETE). user_roles junction table. Migration script |
| RBAC-05 | 84-01, 84-02 | Admin can grant user access to specific instances (instance-level resource control) | SATISFIED | /api/v1/rbac/users/:userId/instances routes. instance_permissions table. RbacService grant/revoke |
| RBAC-06 | 84-02, 84-03 | requirePermission middleware checks role-based permissions before route handlers execute | SATISFIED | 61-line middleware with 4-tier wildcard matching. 114 usages in server.ts. 7 unit tests pass |
| RBAC-07 | 84-02, 84-03 | requireInstanceAccess middleware checks user-instance binding on all instance-scoped routes | SATISFIED | 49-line middleware. 19 instance-scoped routes. CR-03 wildcard check added. 4 unit tests pass |
| RBAC-08 | 84-01, 84-03, 84-04 | Existing users migrated from users.role ENUM to user_roles table without permission loss | SATISFIED | Migration SQL migrates all users via JOIN. server.ts no longer references dropped column (CR-02 fixed). Backward compatibility maintained |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| RbacService unit tests pass | npx vitest run src/auth/rbac-service.test.ts | 32/32 passed | PASS |
| requirePermission tests pass | npx vitest run src/auth/require-permission.test.ts | 7/7 passed | PASS |
| requireInstanceAccess tests pass | npx vitest run src/auth/require-instance-access.test.ts | 4/4 passed | PASS |
| requireRole fully removed from server.ts | grep -c "requireRole" server.ts | 0 matches | PASS |
| auth-database-service has no role references | grep "role" auth-database-service.ts | Exit code 2 (no matches) | PASS |
| Migration SQL has DROP COLUMN role | grep "DROP COLUMN role" migration SQL | 1 match | PASS |
| verifyToken decorated on fastify | grep "fastify.decorate.*verifyToken" server.ts | 1 match | PASS |
| requireInstanceAccess calls getUserPermissions | grep "getUserPermissions" require-instance-access.ts | 1 match (wildcard check) | PASS |
| Middleware references in server.ts | grep requirePermission server.ts + grep requireInstanceAccess server.ts | 114 requirePermission + 20 requireInstanceAccess | PASS |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| require-instance-access.test.ts | 44 | getUserPermissions error logged to stderr when testing missing instanceId | INFO | Test passes correctly. The middleware calls getUserPermissions before checking params.id. Mock returns undefined DB result, caught gracefully by RbacService returning empty Set. Only cosmetic stderr noise. |

### Gaps Summary

**All 4 verification gaps closed.** The Phase 84 RBAC Foundation goal is fully achieved.

The 3 critical bugs (CR-01, CR-02, CR-03) and 1 warning (WR-03) from the initial verification were integration/wiring issues between independently functional components:

1. **CR-01** (verifyToken not decorated): A single-line addition (`fastify.decorate('verifyToken', verifyToken)`) at server.ts line 135 now ensures rbac-api.ts can access the verifyToken function via Fastify's decoration pattern.

2. **CR-02** (server.ts references dropped users.role column): All 3 references removed. The login flow no longer includes `role` in JWT signing payload or login response. The verifyToken middleware no longer overwrites request.user.role with undefined. All authorization relies on `requirePermission` backed by `RbacService.getUserPermissions`.

3. **CR-03** (requireInstanceAccess ignores role-based wildcards): A 6-line addition checks role-based permissions (`*` and `instance:*` wildcards) before querying the `instance_permissions` table. Admin users with wildcard access no longer receive 403 on instance operations.

4. **WR-03** (collector permissions not seeded): Two permission codes (`collector:view`, `collector:manage`) added to the migration SQL seed data, assigned to the dba role.

All unit tests pass (32 + 7 + 4 = 43 tests). No Phase 84-related TypeScript compilation errors. All component files exist, are substantive, wired, and have real data flow.

---

_Verified: 2026-05-09T23:07:00Z_
_Re-verification: Yes -- all gaps closed_
_Verifier: Claude (gsd-verifier)_
