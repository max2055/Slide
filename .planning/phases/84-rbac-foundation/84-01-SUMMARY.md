---
phase: 84-rbac-foundation
plan: 01
type: execute
subsystem: auth/rbac
tags:
  - rbac
  - database
  - migration
  - service-layer
  - testing
dependency_graph:
  requires: []
  provides:
    - SQL migration (002_add_rbac_tables.sql)
    - RbacService class
    - Unit tests for RbacService
    - Migration integration test
  affects:
    - apps/db-ops-api/src/auth-database-service.ts (removes role field dependency)
    - Phase 84-02 (middleware + API layer)
    - Phase 84-03 (integration + cleanup)
tech-stack:
  added:
    - MySQL 5 new tables with parameterized queries
  patterns:
    - mysql2/promise pool.execute() pattern
    - Service class with private getPool()
    - Try/catch error handling returning {success, error}
key-files:
  created:
    - apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql
    - apps/db-ops-api/src/auth/rbac-service.ts
    - apps/db-ops-api/src/auth/rbac-service.test.ts
    - apps/db-ops-api/src/auth/migration.test.ts
  modified: []
metrics:
  duration: "6 minutes"
  completed: "2026-05-09T21:22:00Z"
---

# Phase 84 Plan 01: RBAC Data Layer Summary

Create the RBAC data layer: 5 MySQL tables for many-to-many role-permission system, seed data for 6 default roles and 33 permission codes in `resource:action` format, migration script for existing `users.role` ENUM, and RbacService class with 24 CRUD + permission lookup methods.

## Tasks Executed

| # | Name | Type | Commit | Status |
|---|------|------|--------|--------|
| 1 | Create SQL migration (002_add_rbac_tables.sql) | auto | `25d359e966` | Complete |
| 2 | Implement RbacService with full CRUD + permission lookup | auto | `e547373f85` | Complete |
| 3 | Create unit tests for RbacService | auto | `ab8f532b30` | Complete |
| 4 | Create migration test for RBAC-08 | auto | `b73fded42a` | Complete |

## Artifacts

### 1. `apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql`
- 5 RBAC tables: `roles`, `permissions`, `role_permissions`, `user_roles`, `instance_permissions`
- 6 default system roles seeded (admin, dba, developer, analyst, viewer, auditor)
- 33 permission codes in `resource:action` format
- Admin role assigned `'*'` wildcard permission via `role_permissions`
- Role-permission mappings derived from existing `DEFAULT_ROLE_POLICIES`
- User migration: copies `users.role` ENUM to `user_roles` via JOIN with `roles.name`
- Backup column `role_backup` preserved for one deployment cycle (per RESEARCH.md)
- Single transaction (`START TRANSACTION` / `COMMIT`)

### 2. `apps/db-ops-api/src/auth/rbac-service.ts`
- 24 async methods covering all 5 RBAC entities:
  - **Roles (6):** createRole, getRole, getRoleByName, listRoles, updateRole, deleteRole
  - **Permissions (6):** createPermission, getPermission, getPermissionByCode, listPermissions, deletePermission
  - **Role-Permission (4):** assign, revoke, getRolePermissions, getRolePermissionCodes
  - **User-Role (4):** assign, revoke, getUserRoles, getUserRoleIds
  - **Instance (4):** grant, revoke, getUserInstanceAccess, getUsersWithInstanceAccess
  - **Lookup (2):** getUserPermissions (3-table JOIN), checkInstanceAccess
- Follows `auth-database-service.ts` pattern: `private getPool()`, `pool.execute()` with parameterized queries
- Named export `export class RbacService`

### 3. `apps/db-ops-api/src/auth/rbac-service.test.ts`
- 32 test cases across 6 describe blocks
- Mocked `dbConnection.getPool()` and `pool.execute()`
- Tests all CRUD methods and edge cases (system role rejection, referenced permission rejection)

### 4. `apps/db-ops-api/src/auth/migration.test.ts`
- Integration test validating migration against a real MySQL test database
- Creates isolated test schema `db_ops_ai_rbac_test` with pre-migration users table
- 10 assertions: 5 tables exist, 6 roles seeded, wildcard seeded, admin permissions, user migration, column dropped, backup column preserved
- Gracefully skips when MySQL is unavailable

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None found.

## Threat Flags

None found.

## Self-Check: PASSED

- [x] SQL file exists with all 5 CREATE TABLE statements
- [x] RbacService exports class with all 24 required methods
- [x] Unit tests pass: 32/32 tests
- [x] Migration test exists and runs
- [x] All methods use parameterized queries
- [x] Each task committed individually
