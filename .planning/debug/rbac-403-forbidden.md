---
status: investigated
trigger: "Diagnose why RBAC management API is returning 403 Forbidden"
created: "2026-05-12T00:00:00Z"
updated: "2026-05-12T00:00:00Z"
---

## Current Focus

hypothesis: "RBAC migration (002_add_rbac_tables.sql) was never applied to MySQL database, so getUserPermissions returns empty Set, causing requirePermission('admin:*') to fail"
test: "CONFIRMED — no migration runner code exists, tables don't exist in DB"
expecting: "Apply migration to fix the issue"
next_action: "Present root cause diagnosis"

## Symptoms

expected: "GET /api/v1/rbac/roles should return role list"
actual: "GET /api/v1/rbac/roles → 403 Forbidden, frontend shows '无权限访问此页面，需要 admin 角色'"
errors: "403 Forbidden - 权限不足 (from backend) → displayed as '无权限访问 RBAC 管理功能。需要 admin 角色。' in frontend"
reproduction: "Open RBAC or users-management admin page"
started: "After Phase 84 RBAC implementation"

## Eliminated

- "VerifyToken decoration ordering": fastify.decorate before fastify.register — correct
- "authDatabaseService.getUserById failing due to dropped role column": query doesn't reference role column
- "Vite proxy not forwarding": '/api' proxy covers '/api/v1/rbac/'
- "JWT missing userId": token payload includes userId
- "Frontend generating its own error": backend actually returns 403, frontend renders it

## Evidence

1. server.ts: `verifyToken` + `rbacApiRoutes` correctly ordered (lines 135-139)
2. rbac-api.ts: routes registered at prefix /api/v1/rbac, all using requirePermission('admin:*')
3. require-permission.ts: catches DB error silently, returns empty Set → 403
4. rbac-service.ts getUserPermissions: catches all SQL errors, logs, returns empty Set
5. server.ts startup: NO automatic migration execution code
6. run-migration.ts: DELETED (git shows D), only ever ran migration 001
7. No migration runner was created for 002_add_rbac_tables.sql
8. authDatabaseService.getUserById: no role column reference — works fine
9. Vite proxy: '/api' → localhost:3000 — correct

## Resolution

root_cause: "SQL migration 002_add_rbac_tables.sql was never applied. The RBAC tables (roles, permissions, role_permissions, user_roles, instance_permissions) don't exist. When requirePermission calls rbacService.getUserPermissions(), the JOIN query fails (table not found), caught exception returns empty Set. hasPermission(Set(), 'admin:*') = false → 403."
fix: "Execute sql/migrations/002_add_rbac_tables.sql against the db_ops_ai MySQL database, then the admin user will have user_roles linkage + * wildcard permission."
verification: ""
files_changed: []
