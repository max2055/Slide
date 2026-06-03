---
phase: 84-rbac-foundation
reviewed: 2026-05-09T16:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql
  - apps/db-ops-api/src/auth-database-service.ts
  - apps/db-ops-api/src/auth-middleware.ts
  - apps/db-ops-api/src/auth/migration.test.ts
  - apps/db-ops-api/src/auth/rbac-api.ts
  - apps/db-ops-api/src/auth/rbac-service.test.ts
  - apps/db-ops-api/src/auth/rbac-service.ts
  - apps/db-ops-api/src/auth/require-instance-access.test.ts
  - apps/db-ops-api/src/auth/require-instance-access.ts
  - apps/db-ops-api/src/auth/require-permission.test.ts
  - apps/db-ops-api/src/auth/require-permission.ts
findings:
  critical: 3
  warning: 7
  info: 2
  total: 12
status: issues_found
---

# Phase 84: RBAC Foundation — Code Review Report

**Reviewed:** 2026-05-09T16:00:00Z
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

Reviewed 12 files for the RBAC foundation (migration SQL, service layer, middleware, API routes, unit tests, server.ts integration). The RBAC implementation itself is structurally sound. However, 3 critical security vulnerabilities exist: two unauthenticated routes expose sensitive data (database instance details and LLM API keys), and the migration script's transaction wrapping is ineffective due to MySQL DDL implicit commit semantics, risking data loss on migration failure. Several seeding gaps and behavioral regressions were also found.

---

## Critical Issues

### CR-01: Migration Transaction Wrapping is Ineffective — MySQL DDL Implicit Commits Risk Data Loss

**File:** `apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql:11-254`
**Issue:** The entire migration is wrapped in `START TRANSACTION ... COMMIT` (lines 11, 254), but every DDL statement (`CREATE TABLE`, `ALTER TABLE`) in MySQL causes an **implicit commit** both before and after its execution. The first `CREATE TABLE IF NOT EXISTS` at line 18 commits the transaction immediately. Every subsequent statement runs outside any transaction, with `autocommit` re-enabled.

This means:
- `ALTER TABLE users ADD COLUMN role_backup ...` at line 235 runs and commits (DDL auto-commit).
- `UPDATE users SET role_backup = role` at line 236 runs outside any transaction — if the server crashes mid-update, `role_backup` is incomplete.
- `INSERT INTO user_roles` at lines 239-245 runs outside any transaction.
- `ALTER TABLE users DROP COLUMN role` at line 252 runs and commits (DDL auto-commit).

**Data-loss scenario:** If the server crashes after `DROP COLUMN role` (which auto-commits) but before or during the preceding `INSERT INTO user_roles`, the old `role` ENUM column is permanently gone, `user_roles` table may be empty or incomplete, and `role_backup` may have partial data. The `COMMIT` at line 254 is a no-op on an already-committed transaction.

**Fix:** Restructure the migration into two separately deployable steps:

Step 1 — `002a_add_rbac_tables.sql` (safe to re-run):
```sql
-- DDL auto-commits individually, but CREATE IF NOT EXISTS + IGNORE makes it safe
CREATE TABLE IF NOT EXISTS `roles` (...);
CREATE TABLE IF NOT EXISTS `permissions` (...);
CREATE TABLE IF NOT EXISTS `role_permissions` (...);
CREATE TABLE IF NOT EXISTS `user_roles` (...);
CREATE TABLE IF NOT EXISTS `instance_permissions` (...);
INSERT IGNORE INTO `roles` VALUES (...);
INSERT IGNORE INTO `permissions` VALUES (...);
INSERT IGNORE INTO `role_permissions` SELECT ...;
INSERT IGNORE INTO `user_roles` SELECT ...;
ALTER TABLE users ADD COLUMN role_backup VARCHAR(20) DEFAULT NULL AFTER role;
UPDATE users SET role_backup = role WHERE role_backup IS NULL;
```

Step 2 — `002b_drop_role_column.sql` (run separately after verification):
```sql
ALTER TABLE users DROP COLUMN role;
```

### CR-02: `GET /api/database/instances` Has No Authentication Middleware

**File:** `apps/db-ops-api/server.ts:275`
**Issue:** The `GET /api/database/instances` route at line 275 has no `preHandler` array — no `verifyToken`, no `requirePermission`. Any unauthenticated caller can enumerate all database instances, exposing host, port, username, and database names. Every other instance CRUD route (create, update, delete, reload, execute, query) correctly requires `verifyToken` + a `requirePermission('instance:*')` check, making this gap glaring.

**Fix:**
```typescript
fastify.get('/api/database/instances', {
  preHandler: [verifyToken, requirePermission('instance:view')],
}, async (request, reply) => {
```

### CR-03: LLM Config GET Routes Have No Authentication — API Key Exposure

**Files:**
- `apps/db-ops-api/server.ts:287` — `GET /api/llm/configs`
- `apps/db-ops-api/server.ts:297` — `GET /api/llm/configs/:id`

**Issue:** Both LLM provider configuration read routes have no `preHandler` array — no `verifyToken`, no `requirePermission`. LLM configs typically contain API keys for Anthropic, OpenAI, and other providers. Any unauthenticated caller can read all LLM configurations. The write routes (POST, PUT, DELETE at lines 309, 320, 332, 345, 356, 372) correctly require `verifyToken` + `requirePermission('llm:manage')`, but the read routes are completely open.

**Fix:**
```typescript
// List
fastify.get('/api/llm/configs', {
  preHandler: [verifyToken, requirePermission('llm:view')],
}, async (request, reply) => { ... });

// Single
fastify.get('/api/llm/configs/:id', {
  preHandler: [verifyToken, requirePermission('llm:view')],
}, async (request, reply) => { ... });
```

---

## Warnings

### WR-01: `ai:manage` Permission Used in Route But Not Seeded

**File:** `apps/db-ops-api/server.ts:1354`
**Issue:** The `POST /api/ai/analysis` route requires `requirePermission('ai:manage')`, but the migration seed SQL does not include any `ai:*` or `ai:manage` permission. The only built-in way to satisfy this check is the super-admin `*` wildcard (admin role). Non-admin users with the DBA or developer role will always receive 403 for AI analysis, even if the UI intends to allow them to trigger AI analysis.

The `ai:manage` permission code would pass the API validation regex `/^[a-z_]+:[a-z_]+$/` at rbac-api.ts:136, so it CAN be created manually, but it should be in the seed defaults for discoverability and to match the server.ts route definitions.

**Fix:** Add to the seed SQL:
```sql
('ai:manage', '管理 AI 分析', '提交 AI 分析并查看结果', 'ai', 'manage'),
('ai:view',   '查看 AI 分析', '查看已有的 AI 分析结果', 'ai', 'view'),
```
And assign to appropriate roles (at minimum DBA/developer).

### WR-02: Role_Permission and User_Roles Seed INSERTs Are Not Idempotent

**File:** `apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql:153-227`
**Issue:** All `INSERT INTO role_permissions` statements (lines 153, 158, 178, 194, 207, 217) and `INSERT INTO user_roles` (line 239) use plain `INSERT INTO` without `IGNORE`. The `roles` and `permissions` seed tables correctly use `INSERT IGNORE INTO`, but the junction table inserts will fail with duplicate key violations (`uk_role_permission` / `uk_user_role`) on re-run.

**Fix:** Change all to `INSERT IGNORE INTO`:
```sql
INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT ...;
INSERT IGNORE INTO user_roles (user_id, role_id) SELECT ...;
```

### WR-03: New Users Created Without Default Role Assignment

**File:** `apps/db-ops-api/server.ts:198-216`
**Issue:** Before this migration, the `users.role` ENUM column had `DEFAULT 'viewer'`. After migration, new users created via `POST /api/users` get zero roles assigned — they cannot access any resources until an admin explicitly calls `POST /api/v1/rbac/users/:userId/roles`. This is a silent behavioral regression.

**Fix:** Either:
1. Auto-assign the `viewer` role after user creation in `createUser`, or
2. Document this as a breaking change and update the API response/UI to guide admin to assign roles.

### WR-04: `requirePermission` Uses OR Semantics for Multiple Permission Codes

**File:** `apps/db-ops-api/src/auth/require-permission.ts:29`
**Issue:** The function uses `requiredCodes.some(code => hasPermission(...))`, so if ever called with multiple permission codes, the user needs only **one** to match (OR). Most RBAC systems require **all** listed permissions (AND). The test at `require-permission.test.ts:80` explicitly tests and validates this OR behavior, creating a latent issue: a developer adding a second permission expecting AND would write a security bypass. Currently all callers pass exactly one code, so this is latent.

**Fix:** Change `some()` to `every()` for AND semantics, or rename to `requireAnyPermission` to make OR explicit:
```typescript
// Option A: AND (more intuitive)
const hasAccess = requiredCodes.every(code => hasPermission(userPermissions, code));

// Option B: Rename for clarity
export function requireAnyPermission(...requiredCodes: string[]) { ... }
```

### WR-05: `updateRole` Route Does Not Validate `name` Field Length

**File:** `apps/db-ops-api/src/auth/rbac-api.ts:73-87`
**Issue:** The `PUT /roles/:id` route accepts `name` without length validation. The `createRole` route (line 43) validates `name` as 1-50 characters matching the `VARCHAR(50)` schema, but update does not. An empty or overlong name would hit a MySQL error or silent truncation.

**Fix:** Add validation:
```typescript
if (name !== undefined && (typeof name !== 'string' || name.length < 1 || name.length > 50)) {
  return reply.code(400).send({ error: '角色名称长度 1-50 字符' });
}
```

### WR-06: `notification:manage` Permission Seeded But Never Used

**File:** `apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql:109`
**Issue:** The seed creates `notification:manage`, but all notification channel management routes (POST create at line 1207, PUT update at line 1242, DELETE at line 1275, POST test at line 1293) use `requirePermission('admin:*')` instead. A DBA role holding `notification:manage` would get 403 on these routes. Either the routes should use `notification:manage` or the seed should not include it.

**Fix:** Change route permissions from `admin:*` to `notification:manage`:
```typescript
preHandler: [verifyToken, requirePermission('notification:manage')],
```
Or remove `notification:manage` from the seed if notification CRUD is intentionally admin-only.

### WR-07: `isConnected()` Method is Dead Code in Both Services

**Files:**
- `apps/db-ops-api/src/auth/rbac-service.ts:18-20`
- `apps/db-ops-api/src/auth-database-service.ts:53-55`

**Issue:** Both classes define `isConnected()` methods that are never called. The public API is `getPool()` which returns `null` when unavailable, and all callers handle null via early-return. The dead methods add maintenance overhead.

**Fix:** Remove both `isConnected()` methods.

---

## Info

### IN-01: SQL String Interpolation in Migration Test

**File:** `apps/db-ops-api/src/auth/migration.test.ts:175`
**Issue:** The test uses template literal interpolation in a SQL query:
```typescript
const [rows] = await pool!.execute(`SHOW TABLES LIKE '${table}'`);
```
The `table` value comes from a hardcoded array (`['roles', 'permissions', 'role_permissions', 'user_roles', 'instance_permissions']`), so there is no injection risk. MySQL `SHOW TABLES LIKE` does not support parameterized placeholders, making the interpolation technically necessary. Worth noting as informational.

### IN-02: Role and Permission Queries Omit `updated_at` Column

**File:** `apps/db-ops-api/src/auth/rbac-service.ts:52,74,96`
**Issue:** The `roles` table has `updated_at DATETIME ... ON UPDATE CURRENT_TIMESTAMP`, but `getRole`, `getRoleByName`, and `listRoles` SELECT queries omit this column. Similarly, `getPermission` and `getPermissionByCode` queries omit `updated_at` from the `permissions` table. Callers cannot determine when records were last modified.

**Fix:** Add `updated_at` to the SELECT clauses:
```typescript
'SELECT id, name, description, is_system, created_at, updated_at FROM roles ...'
'SELECT id, code, name, description, resource, action, created_at, updated_at FROM permissions ...'
```

---

_Reviewed: 2026-05-09T16:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
