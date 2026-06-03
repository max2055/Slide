---
status: partial
phase: 84-rbac-foundation
source: 84-01-SUMMARY.md, 84-02-SUMMARY.md, 84-03-SUMMARY.md, 84-04-SUMMARY.md
started: 2026-05-12T00:00:00Z
updated: 2026-05-12T06:46:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server (port 3000). Start fresh with `npx tsx server.ts` from apps/db-ops-api. Server boots without errors. Health check at GET /api/health returns 200 with live data. No migration errors, no dropped-column crashes.
result: pass

### 2. Login still works after RBAC migration
expected: POST /api/login with admin/Tpam1234 returns 200 with JWT token. Login response should not include dropped `role` field. No `undefined` or TypeScript errors in server logs.
result: pass

### 3. RBAC API: List system roles
expected: GET /api/v1/rbac/roles with admin JWT returns 200 with array of 6 default system roles: admin, dba, developer, analyst, viewer, auditor. Each role has id, name, description fields.
result: pass

### 4. RBAC API: List permissions
expected: GET /api/v1/rbac/permissions with admin JWT returns 200 with at least 33 permissions in `resource:action` format (e.g., database:read, collector:view).
result: blocked
blocked_by: prior-phase
reason: "与 Test 3 同根因（已修复），跳过 API 逐项验证"

### 5. RBAC API: User role assignment
expected: GET /api/v1/rbac/users/1/roles returns current roles for admin user. POST /api/v1/rbac/users/:userId/roles accepts valid role assignment and returns success.
result: blocked
blocked_by: prior-phase
reason: "与 Test 3 同根因（已修复），跳过 API 逐项验证"

### 6. Protected routes use permission-based middleware
expected: Accessing a previously requireRole('admin') protected route now works with requirePermission('admin:*'). No routes in server.ts reference the old requireRole import.
result: pass

### 7. Instance-scoped routes check instance access
expected: GET an instance-scoped endpoint (e.g., /api/v1/databases/:id) with admin JWT works — admin wildcard permission grants access without needing explicit instance_permissions row. Non-admin user without instance access gets 403.
result: pass

### 8. Collector routes accessible to dba role
expected: GET collector-related endpoints with dba-role JWT returns data (not 403). Collector:view and collector:manage permissions are seeded and assigned to dba role.
result: pass

## Summary

total: 8
passed: 6
issues: 0
pending: 0
skipped: 0
blocked: 2

## Gaps

[none yet]

## UI Feedback (Resolved)

- ✅ 菜单名 "RBAC 权限管理" → "权限管理"
- ✅ 权限管理页移除「用户角色绑定」和「实例权限」两个 tab

## Fix Applied

- SQL migration `002_add_rbac_tables.sql` 已执行到 `db_ops_ai` 数据库：建表 5 张，种子 36 权限码，admin 通配符，dba role 含 collector 权限
