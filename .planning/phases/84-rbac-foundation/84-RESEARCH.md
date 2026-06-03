# Phase 84: RBAC Foundation - Research

**Researched:** 2026-05-09
**Domain:** Backend RBAC — MySQL schema design, Fastify middleware composition, permission model, data migration
**Confidence:** HIGH

## Summary

This phase builds a multi-to-many RBAC system on top of the existing single-ENUM `users.role` architecture. The codebase is a monolithic Fastify v4 server (139 route registrations in `server.ts`) with MySQL persistence (mysql2/promise, no ORM) and JWT auth (jsonwebtoken). The current auth pattern is `verifyToken` (sets `request.user`) optionally followed by `requireRole('admin')` for a handful of admin-only routes.

**Key reality check:** CONTEXT.md claims "115 requireRole usages" — the actual codebase has 9 (five user-management routes + four notification-channel routes). Most routes (113) use `verifyToken` only, enforcing authentication but no role granularity. Twenty-six routes have no auth at all. The planning must account for 139 route audits, not 115.

The phase delivers: 5 new MySQL tables, RbacService (CRUD), `requirePermission()` and `requireInstanceAccess()` Fastify preHandler middlewares, migration script for existing users, and new RBAC management API at `/api/v1/rbac/*`.

**Primary recommendation:** Build a lightweight custom RBAC (not Casbin — already ruled out in REQUIREMENTS.md). Bootstrap permission codes from the existing `DEFAULT_ROLE_POLICIES` matrix. Cache user permissions in-memory with 60-second TTL (no Redis dependency, sub-ms lookups at current scale).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Permission code namespace = `resource:action` format (e.g., `instance:view`, `alert:manage`, `user:create`)
- **D-02:** Two-tier granularity + wildcard support. Operation-level (`instance:query`) + module-level (`instance:*`), middleware matching: `instance:query` can be covered by `instance:*`
- **D-03:** Direct replacement. Migrate all users from `users.role` ENUM to `user_roles` table in one go, delete old `role` column after migration
- **D-04:** Full replacement. New `requirePermission` + `requireInstanceAccess` replace old `requireRole`, delete old middleware code. 115 route registrations all updated (actual: 139)
- **D-05:** New RBAC management API at `/api/v1/rbac/*`. Old `/api/users` path preserved, removed after Phase 85

### Claude's Discretion
- Initial permission codes list (infer from existing `role-permissions.ts` resource categories)
- `requirePermission` middleware caching strategy
- Migration script transaction boundary and rollback plan
- Wildcard matching implementation (string matching vs regex vs set operations)

### Deferred Ideas (OUT OF SCOPE)
- None — discussion stayed within phase scope
- Scheduled tasks configuration — infrastructure improvement, not RBAC
- Auto AI analysis invisibility — AI analysis display issue, not RBAC
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RBAC-01 | Admin can create custom roles with name and description | RbacService CRUD API, `roles` table, `/api/v1/rbac/roles` endpoints |
| RBAC-02 | Admin can define permission codes following `resource:action` namespace convention | `permissions` table, permission code bootstrap from DEFAULT_ROLE_POLICIES |
| RBAC-03 | Admin can assign multiple permissions to a role (many-to-many) | `role_permissions` junction table, RbacService assign/revoke methods |
| RBAC-04 | Admin can assign multiple roles to a user (many-to-many), replacing single ENUM role | `user_roles` junction table, migration script for existing `users.role` |
| RBAC-05 | Admin can grant user access to specific instances (instance-level resource control) | `instance_permissions` table, RbacService grant/revoke instance access |
| RBAC-06 | `requirePermission` middleware checks role-based permissions before route handlers execute | Fastify preHandler pattern, permission lookup via user_roles -> role_permissions -> permissions |
| RBAC-07 | `requireInstanceAccess` middleware checks user-instance binding on all instance-scoped routes | Fastify preHandler extracting instanceId from params, checking instance_permissions table |
| RBAC-08 | Existing users are migrated from `users.role` ENUM to `user_roles` table without permission loss | SQL migration script mapping old roles to new permission sets, transaction with rollback |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Role/User/Permission CRUD | API / Backend | Database | All RBAC data is stored in MySQL, managed via RbacService. Frontend (Phase 85) is a separate concern. |
| Permission checking (requirePermission) | API / Backend | — | Fastify preHandler middleware runs server-side before route handler. Browser has no role in enforcement. |
| Instance access checking (requireInstanceAccess) | API / Backend | — | Instance IDs come from route params, checked against DB. Middleware runs server-side. |
| User identity (JWT) | API / Backend | Browser | JWT issued by backend on login, stored in browser localStorage. verifyToken middleware decodes on each request. |
| User-to-role migration | API / Backend (startup script) | Database | One-shot startup migration script reading users.role and inserting into user_roles + roles tables. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Fastify | ^4.24.3 | HTTP server, route registration, preHandler middleware | Existing; verified in package.json |
| mysql2 | ^3.20.0 | MySQL connection pool, raw SQL queries | Existing; no ORM pattern established |
| jsonwebtoken | ^9.0.2 | JWT token creation and verification | Existing; verifyToken middleware already relies on it |
| vitest | ^4.1.5 | Test framework | Existing; config at `apps/db-ops-api/vitest.config.ts` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| bcrypt | ^6.0.0 | Password hashing | Existing; already used in auth-database-service |

### No Additional Libraries Needed

The entire RBAC system uses only existing dependencies. Fastify preHandler composition, raw SQL queries via mysql2, and JWT for user identity are all already in place.

**Installation:**
```bash
# No new packages needed. All dependencies already in package.json.
```

**Version verification:**
```
fastify@5.8.5 (npm registry) — package.json pins ^4.24.3, stay with ^4.x for compatibility
mysql2@3.22.3 (npm registry) — package.json pins ^3.20.0, compatible
vitest@4.1.5 (npm registry) — package.json pins ^4.1.4, up to date
```

## Architecture Patterns

### System Architecture Diagram

```
                         ┌─────────────────────────────────────┐
                         │         HTTP Request (139 routes)    │
                         └────────────┬────────────────────────┘
                                      │
                         ┌────────────▼────────────────────────┐
                         │        Fastify preHandler chain      │
                         │                                      │
                         │  ┌──────────────────────────────┐   │
                         │  │ verifyToken (JWT decode)      │   │
                         │  │ → request.user = { id, name } │   │
                         │  └──────────────┬───────────────┘   │
                         │                 │                    │
                         │  ┌──────────────▼───────────────┐   │
                         │  │ requirePermission(code)       │   │
                         │  │ → load user roles             │   │
                         │  │ → load role permissions       │   │
                         │  │ → wildcard match              │   │
                         │  │ → 403 if not found            │   │
                         │  └──────────────┬───────────────┘   │
                         │                 │                    │
                         │  ┌──────────────▼───────────────┐   │
                         │  │ requireInstanceAccess()       │   │
                         │  │ (instance-scoped routes only) │   │
                         │  │ → extract instanceId from     │   │
                         │  │   request.params              │   │
                         │  │ → check instance_permissions  │   │
                         │  │ → 403 if no access            │   │
                         │  └──────────────┬───────────────┘   │
                         └─────────────────┼───────────────────┘
                                           │ pass
                         ┌─────────────────▼───────────────────┐
                         │         Route Handler               │
                         │    (business logic, DB queries)      │
                         └─────────────────┬───────────────────┘
                                           │
                         ┌─────────────────▼───────────────────┐
                         │         MySQL (db_ops_ai)            │
                         │                                      │
                         │  users | user_roles | roles |        │
                         │  permissions | role_permissions |    │
                         │  instance_permissions                 │
                         └──────────────────────────────────────┘
```

### Recommended Project Structure

```
apps/db-ops-api/
├── server.ts                                  # Existing: all route registrations (+ migrate imports)
├── src/
│   ├── auth-middleware.ts                     # EXISTING: requireRole() — DELETE this phase
│   ├── auth/
│   │   ├── rbac-service.ts                   # NEW: Role/permission/instance CRUD + lookup
│   │   ├── require-permission.ts              # NEW: requirePermission middleware factory
│   │   └── require-instance-access.ts         # NEW: requireInstanceAccess middleware factory
│   ├── auth-database-service.ts               # EXISTING: user CRUD, login — MODIFY (drop role field)
│   └── ...
├── sql/
│   └── migrations/
│       └── 002_add_rbac_tables.sql            # NEW: 5 RBAC tables + seed data + migration
└── ...
```

### Pattern 1: PreHandler Middleware Composition

**What:** Fastify preHandler array pattern. Each check either passes (calls `return undefined`) or sends an error response (`reply.code(403).send(...)`).

**When:** All protected routes (139 total). Current pattern: `[verifyToken]` (auth-only) or `[verifyToken, requireRole('admin')]`. New pattern: `[verifyToken, requirePermission('instance:query')]` with optional `requireInstanceAccess()`.

**Example:**
```typescript
// Source: apps/db-ops-api/src/auth-middleware.ts (existing pattern)
// Extended: Fastify preHandler route option pattern, verified from codebase server.ts

// Role-based permission check (for all protected routes)
fastify.get('/api/users', {
  preHandler: [verifyToken, requirePermission('user:view')]
}, async (request, reply) => { ... });

// Instance-scoped route (requires both permission + instance access)
fastify.get('/api/database/instances/:id', {
  preHandler: [
    verifyToken,
    requirePermission('instance:view'),
    requireInstanceAccess()
  ]
}, async (request, reply) => { ... });
```

### Pattern 2: Service Class with Pool Access

**What:** Each domain module exports a class with `private getPool()` wrapping `dbConnection.getPool()`.

**When:** All database-accessing services, consistent with existing code.

**Example:**
```typescript
// Source: apps/db-ops-api/src/auth-database-service.ts (existing pattern)

export class RbacService {
  private getPool() { return dbConnection.getPool(); }

  async getUserPermissions(userId: number): Promise<Set<string>> {
    const pool = this.getPool();
    const [rows] = await pool.execute(`
      SELECT DISTINCT p.code
      FROM user_roles ur
      JOIN role_permissions rp ON ur.role_id = rp.role_id
      JOIN permissions p ON rp.permission_id = p.id
      WHERE ur.user_id = ?
    `, [userId]);
    return new Set((rows as any[]).map(r => r.code));
  }
}
```

### Pattern 3: Permission Code Wildcard Matching

**What:** Wildcard support where `instance:*` matches `instance:view`, `instance:query`, etc. Evaluate by checking the granted set against the required code using prefix match on the wildcard segment.

**When:** `requirePermission()` middleware after loading user's permission set.

**Example:**
```typescript
function hasPermission(userPermissions: Set<string>, requiredCode: string): boolean {
  // Direct match first
  if (userPermissions.has(requiredCode)) return true;
  if (userPermissions.has('*')) return true; // super admin

  // Wildcard: resource:*
  const colonIdx = requiredCode.indexOf(':');
  if (colonIdx !== -1) {
    const resourcePrefix = requiredCode.substring(0, colonIdx) + ':*';
    if (userPermissions.has(resourcePrefix)) return true;
  }

  // Wildcard: *:action
  if (colonIdx !== -1) {
    const actionSuffix = '*:' + requiredCode.substring(colonIdx + 1);
    if (userPermissions.has(actionSuffix)) return true;
  }

  return false;
}
```

### Anti-Patterns to Avoid
- **Permission code in JWT:** Permissions change (role reassignment) without token refresh. Query DB on each request (with short cache). [VERIFIED: ARCHITECTURE.md]
- **Instance check in route handler:** Duplicated code, easy to forget. Use `requireInstanceAccess()` middleware consistently. [VERIFIED: ARCHITECTURE.md]
- **Wrong middleware order:** `requireInstanceAccess()` before `requirePermission()` causes noise in audit logs. Order: verifyToken -> requirePermission -> requireInstanceAccess. [CITED: PITFALLS.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Policy engine | Custom RBAC with Casbin-like rule engine | Simple SQL JOINs + Set-based permission check | Casbin is overkill for <100 roles (ruled out in REQUIREMENTS.md). Current architecture uses raw SQL. |
| Permission code JWT cache | Embedding permission codes in JWT token | In-memory cache with 60s TTL or no cache | JWT permission cache has staleness issues. MySQL lookup with proper indexes is <5ms. [CITED: ARCHITECTURE.md] |

## Common Pitfalls

### Pitfall 1: Count Mismatch Between CONTEXT.md and Actual Code

**What goes wrong:** CONTEXT.md claims "115 route registrations with requireRole" but actual server.ts has 139 total routes, 9 with requireRole('admin'), 113 with verifyToken-only, 26 unauthenticated.

**Why it happens:** CONTEXT.md was written during planning estimation, not code audit.

**How to avoid:** Before planning, audit server.ts precisely. The actual migration workload: 9 routes replace requireRole with requirePermission, 113 auth-only routes add granular permission checks, 26 unprotected routes evaluate for auth necessity. Plus 19 instance-scoped routes need requireInstanceAccess.

### Pitfall 2: Migration Without Rollback

**What goes wrong:** Migration script runs, deletes `users.role` column, copies to `user_roles`. If something breaks, the old column is gone. Users lose all permissions.

**Why it happens:** D-03 mandates direct replacement with no fallback.

**How to avoid:** Wrap migration in a TRANSACTION. Use a temporary column for safety. Script: (1) CREATE temporary column `role_backup` populated from `role`, (2) INSERT into `user_roles` + `roles`, (3) verify through test query, (4) DROP `role` column, (5) DROP `role_backup` only after Phase 85 is verified. This contradicts D-03 slightly but is safer.

### Pitfall 3: Permission Cache Staleness

**What goes wrong:** Admin grants a permission but user still gets 403 for up to 60 seconds (or until token refresh).

**Why it happens:** In-memory permission cache or JWT-embedded permissions don't reflect DB changes.

**How to avoid:** No cache for permission lookups — the SQL join is fast with proper indexes (<5ms per request at current scale). If cache is desired, use 30-second TTL.

### Pitfall 4: Instance-Level Access Bypass via Body Parameters

**What goes wrong:** Route handler reads `instanceId` from `request.body`, but requireInstanceAccess middleware reads from `request.params.id`. Mismatch means wrong instance is checked.

**Why it happens:** Inconsistent param naming across routes.

**How to avoid:** Canonical rule: instanceId MUST be in URL params for all instance-scoped routes. The middleware should log a warning if `request.body` contains a different instanceId. [CITED: PITFALLS.md]

### Pitfall 5: Route Audit Missing New or Obscure Routes

**What goes wrong:** After adding middleware to all known routes, a newly added route (or a conditional route registered at runtime) is missed.

**Why it happens:** Manual audit is error-prone.

**How to avoid:** Write an audit script that scans `server.ts` for `fastify.(get|post|put|delete)` and verifies each route has appropriate middleware. Run this as part of CI.

## Code Examples

Verified patterns from the existing codebase:

### requirePermission Middleware Factory

```typescript
// Source: apps/db-ops-api/src/auth-middleware.ts (existing requireRole pattern)
// Adapted for new requirePermission middleware

import { RbacService } from './auth/rbac-service.js';

const rbacService = new RbacService();

// In-memory permission cache (60s TTL)
const permissionCache = new Map<number, { permissions: Set<string>; expiresAt: number }>();

export function requirePermission(...requiredCodes: string[]) {
  return async (request: any, reply: any) => {
    const user = request.user;
    if (!user) {
      return reply.code(401).send({ error: '请先登录' });
    }

    let permissions: Set<string>;
    const cached = permissionCache.get(user.userId);
    if (cached && cached.expiresAt > Date.now()) {
      permissions = cached.permissions;
    } else {
      permissions = await rbacService.getUserPermissions(user.userId);
      permissionCache.set(user.userId, { permissions, expiresAt: Date.now() + 60000 });
    }

    const hasAccess = requiredCodes.some(code => matchPermission(permissions, code));
    if (!hasAccess) {
      return reply.code(403).send({ error: '权限不足' });
    }
  };
}
```

### requireInstanceAccess Middleware Factory

```typescript
// New pattern following same middleware factory signature

export function requireInstanceAccess() {
  return async (request: any, reply: any) => {
    const user = request.user;
    if (!user) {
      return reply.code(401).send({ error: '请先登录' });
    }

    // Extract instanceId from route params
    const instanceId = request.params?.id;
    if (!instanceId) {
      return reply.code(400).send({ error: '缺少实例 ID' });
    }

    const hasAccess = await rbacService.checkInstanceAccess(user.userId, Number(instanceId));
    if (!hasAccess) {
      return reply.code(403).send({ error: '无权访问该实例' });
    }
  };
}
```

### Migration Script (Transaction-Protected)

```sql
-- Source: apps/db-ops-api/sql/migrations/001_add_parent_id_to_chat_messages.sql (existing migration pattern)

START TRANSACTION;

-- 1. Create backup column for safety
ALTER TABLE users ADD COLUMN role_backup VARCHAR(20) DEFAULT NULL;
UPDATE users SET role_backup = role;

-- 2. Bootstrap default roles from code (permission codes inserted separately)
INSERT IGNORE INTO roles (name, description, is_system)
VALUES
  ('admin', '超级管理员', TRUE),
  ('dba', '数据库管理员', TRUE),
  ('developer', '开发人员', TRUE),
  ('analyst', '分析师', TRUE),
  ('viewer', '访客', TRUE),
  ('auditor', '审计员', TRUE);

-- 3. Map existing users to user_roles
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON u.role = r.name;

-- 4. Verify migration
SELECT COUNT(*) = 0 AS has_unmigrated_users
FROM users u
LEFT JOIN user_roles ur ON u.id = ur.user_id
WHERE ur.user_id IS NULL;

-- 5. Drop old column (after verification)
ALTER TABLE users DROP COLUMN role;
ALTER TABLE users DROP COLUMN role_backup;

COMMIT;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single ENUM `users.role` with 6 fixed values | Multi-to-many user_roles + roles tables with custom permission sets | Phase 84 | Enables custom roles without code changes, enables multi-role assignment |
| `requireRole('admin')` checking a single string | `requirePermission('user:manage')` checking permission codes | Phase 84 | Granular, composable permission checks. "What you can do" not "who you are" |
| No instance-level access control | `requireInstanceAccess()` middleware checking `instance_permissions` table | Phase 84 | Prevents users from accessing instances they shouldn't see |
| `RolePermissionRegistry` in-memory (hardcoded policies) | DB-backed permissions with optional cache | Phase 84 | Admin can change roles/permissions at runtime without code deploy |

**Deprecated/outdated:**
- `requireRole()` function in `apps/db-ops-api/src/auth-middleware.ts` — to be deleted in Phase 84
- `users.role` ENUM column — to be dropped after migration
- `RolePermissionRegistry` class in `apps/db-ops-api/src/auth/role-permissions.ts` — still useful for tool-level approval checks but superseded by RBAC for route-level access

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | 26 unauthenticated routes in server.ts are either health/login (safe) or should remain unauthenticated | Route Audit | If some unprotected routes SHOULD have auth, they'd be exposed |
| A2 | User migration: existing admin role maps to full set of permissions that matches current admin behavior | Migration Strategy | If admin gets restricted perm set, existing admin users lose capability |
| A3 | The existing DEFAULT_ROLE_POLICIES allow/deny lists map cleanly to `resource:action` permission codes | Permission Codes | Mismatch would give users different permissions after migration than before |

## Open Questions (RESOLVED)

1. **What to do with 26 unauthenticated routes?**
   - RESOLVED: Keep all current unauthenticated routes as-is. This phase only ADDS middleware to routes that were already protected. Any route that had no auth before remains unprotected until a dedicated audit phase.

2. **Exact permission codes for each route?**
   - RESOLVED: Group routes by resource category (instance, alert, user, approval, report, etc.) and assign permissions at category level. Accept that Phase 84 is a "good enough" mapping, refined later.

3. **Migration rollback plan?**
   - RESOLVED: Keep backup column for one deployment cycle. Drop it at Phase 85 completion. Safer than D-03 suggests. Admin role gets `'*'` wildcard permission via `role_permissions` to ensure `getUserPermissions` returns `Set(['*'])`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | 20.x+ | — | — |
| MySQL | Database | Available (local) | — | — |
| tsx | Dev runner | ✓ | — | — |
| pnpm | Package manager | ✓ | — | — |

**Missing dependencies with no fallback:** None — all tooling is already in place.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.5 |
| Config file | `apps/db-ops-api/vitest.config.ts` |
| Quick run command | `pnpm -C apps/db-ops-api vitest run --reporter verbose` |
| Full suite command | `pnpm -C apps/db-ops-api test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RBAC-01 | Create/edit/delete roles via RbacService | unit | `vitest run src/auth/rbac-service.test.ts` | Wave 0 |
| RBAC-02 | Permission code namespace validation | unit | `vitest run src/auth/rbac-service.test.ts` | Wave 0 |
| RBAC-03 | Assign/revoke permissions to/from role | unit | `vitest run src/auth/rbac-service.test.ts` | Wave 0 |
| RBAC-04 | Assign/revoke roles to/from user | unit | `vitest run src/auth/rbac-service.test.ts` | Wave 0 |
| RBAC-05 | Grant/revoke instance access to user | unit | `vitest run src/auth/rbac-service.test.ts` | Wave 0 |
| RBAC-06 | requirePermission returns 403 for unauthorized | integration | `vitest run src/auth/require-permission.test.ts` | Wave 0 |
| RBAC-07 | requireInstanceAccess returns 403 for unauthorized | integration | `vitest run src/auth/require-instance-access.test.ts` | Wave 0 |
| RBAC-08 | Migration script maps existing roles correctly | migration | `vitest run src/auth/migration.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm -C apps/db-ops-api vitest run --reporter verbose`
- **Per wave merge:** `pnpm -C apps/db-ops-api test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/auth/rbac-service.test.ts` — covers RBAC-01 through RBAC-05
- [ ] `src/auth/require-permission.test.ts` — covers RBAC-06
- [ ] `src/auth/require-instance-access.test.ts` — covers RBAC-07
- [ ] `src/auth/migration.test.ts` — covers RBAC-08
- [ ] `src/auth/conftest.ts` — shared test fixtures (mock DB, mock user, permission fixtures)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | JWT verifyToken (existing) |
| V3 Session Management | yes | JWT 24h expiry, token refresh on login |
| V4 Access Control | **yes** | requirePermission + requireInstanceAccess (NEW — this is the core of Phase 84) |
| V5 Input Validation | yes | zod / manual validation in route handlers |
| V6 Cryptography | yes | bcrypt for passwords (existing), JWT signing |

### Known Threat Patterns for Fastify + MySQL

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Permission escalation via direct API call | Elevation of Privilege | Middleware checks before every protected route. Never trust request body for permission decisions. |
| Instance ID tampering | Tampering | Treat `request.params.id` as untrusted input. requireInstanceAccess() validates against DB on every request. |
| SQL injection in RBAC queries | Tampering | Use parameterized queries (mysql2 `pool.execute()` with `?` placeholders) consistently. |
| Role reassignment without session invalidation | Repudiation | verifyToken re-reads user role from DB on each request (already implemented in existing middleware). |

## Sources

### Primary (HIGH confidence)
- `apps/db-ops-api/server.ts` — all 139 route registrations, verifyToken middleware, requireRole usage pattern [VERIFIED]
- `apps/db-ops-api/src/auth-middleware.ts` — existing requireRole middleware factory [VERIFIED]
- `apps/db-ops-api/src/auth-database-service.ts` — user CRUD, User type with role field, login flow [VERIFIED]
- `apps/db-ops-api/src/auth/role-permissions.ts` — RolePermissionRegistry, DEFAULT_ROLE_POLICIES, SystemRole types [VERIFIED]
- `apps/db-ops-api/sql/schema.sql` — current users table with role ENUM [VERIFIED]
- `apps/db-ops-api/package.json` — fastify ^4.24.3, mysql2 ^3.20.0, jsonwebtoken ^9.0.2 [VERIFIED]
- `apps/db-ops-api/vitest.config.ts` — test configuration [VERIFIED]

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` — pre-research architecture patterns by earlier phase [CITED]
- `.planning/research/PITFALLS.md` — pre-research pitfalls by earlier phase [CITED]
- `apps/db-ops-api/sql/migrations/001_add_parent_id_to_chat_messages.sql` — migration script pattern [VERIFIED]

### Tertiary (LOW confidence — needs validation)
- Claim "19 instance-scoped routes" — counted from grep of `/api/database/instances/:id` pattern in server.ts, manual count needs verification against actual route handlers
- Permission code mapping from DEFAULT_ROLE_POLICIES to resource:action codes — requires code review of each policy's allow/deny lists

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages and versions verified from package.json
- Architecture: HIGH — all patterns verified from existing codebase
- Pitfalls: HIGH — verified by comparing CONTEXT.md claims against actual codebase state; discrepancy found and documented

**Research date:** 2026-05-09
**Valid until:** 2026-06-09 (30 days — stable dependencies, existing codebase unlikely to change before Phase 84 starts)
