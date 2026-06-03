---
phase: 101-认证权限
plan: 02
type: execute
subsystem: auth
tags: [rbac, access-level, permissions, instance-access]
requires: [101-01]
provides: [access-level-hierarchy, permissions-endpoint, route-hardening]
affects: [server-routes, rbac-api-contract]
tech-stack:
  added: []
  patterns: [AccessLevel enum, ACCESS_LEVEL_HIERARCHY, minLevel middleware pattern]
key-files:
  created: []
  modified:
    - apps/db-ops-api/src/auth/require-instance-access.ts
    - apps/db-ops-api/src/auth/rbac-service.ts
    - apps/db-ops-api/src/auth/rbac-api.ts
    - apps/db-ops-api/server.ts
    - apps/db-ops-api/src/auth/require-instance-access.test.ts
    - apps/db-ops-api/src/auth/rbac-service.test.ts
decisions:
  - "checkInstanceAccessLevel replaces checkInstanceAccess in middleware to avoid redundant queries"
  - "Wildcard (* / instance:*) bypasses both existence and level checks"
  - "grantInstanceAccess uses SELECT+INSERT/UPDATE pattern for access_level (ON DUPLICATE KEY not feasible without unique constraint)"
metrics:
  duration: "~15 min"
  completed: "2026-05-20"
---

# Phase 101 Plan 02: 实例访问级别与权限 API 端点 — Summary

## Objective

实现三级实例访问级别控制（read-only / read-write / admin），添加用户权限查询 API，加固所有实例路由安全。

## Key Changes

### 1. 实例访问级别中间件 (`require-instance-access.ts`)

- Added `AccessLevel` type (`'read-only' | 'read-write' | 'admin'`)
- Added `ACCESS_LEVEL_HIERARCHY` numeric mapping for comparison
- `requireInstanceAccess()` now accepts optional `minLevel?: AccessLevel` parameter
- Middleware calls `checkInstanceAccessLevel()` instead of `checkInstanceAccess()` to avoid redundant queries
- When `minLevel` is set, compares user's level against hierarchy and returns 403 if insufficient
- Wildcard (`*` / `instance:*`) bypasses all level checks as before

### 2. 服务层扩展 (`rbac-service.ts`)

- Added `checkInstanceAccessLevel(userId, instanceId): Promise<string | null>` with grant_expiry-aware query
- `grantInstanceAccess()` now accepts optional `accessLevel` parameter (defaults to `'read-only'`)
  - Uses SELECT-then-INSERT-or-UPDATE pattern for idempotent grants
- `getUserInstanceAccess()` return type changed from `number[]` to `Array<{instance_id, access_level}>`
- `getUsersWithInstanceAccess()` return type changed from `number[]` to `Array<{user_id, access_level}>`

### 3. 路由安全加固 (`server.ts`)

- **10 previously unprotected GET routes** now have `{ preHandler: [verifyToken, requireInstanceAccess('read-only')] }`:
  - `/api/database/instances/:id`
  - `/api/database/instances/:id/metrics`
  - `/api/database/instances/:id/metrics/history`
  - `/api/database/instances/:id/topsql`
  - `/api/database/instances/:id/sessions`
  - `/api/database/instances/:id/capacity`
  - `/api/database/instances/:id/capacity/history`
  - `/api/database/instances/:id/capacity/databases`
  - `/api/database/instances/:id/databases`
  - `/api/database/instances/:id/schema-objects`
- **6 existing routes** updated with level-specific parameters:
  - QAN: `requireInstanceAccess('read-only')`
  - PUT /instances/:id: `requireInstanceAccess('read-write')`
  - POST /reload: `requireInstanceAccess('read-write')`
  - POST /execute: `requireInstanceAccess('read-write')`
  - DELETE /instances/:id: `requireInstanceAccess('admin')`
  - POST /capacity/collect: `requireInstanceAccess('read-write')`
- Added `GET /api/auth/permissions` endpoint returning current user's permission code set

### 4. RBAC 管理 API 扩展 (`rbac-api.ts`)

- `POST /api/v1/rbac/users/:userId/instances` accepts `accessLevel` body param (validated, defaults to `'read-only'`)
- `GET /api/v1/rbac/users/:userId/instances` now returns `access_level` alongside `instance_id`

## Threat Compliance

| Threat ID | Category | Status |
|-----------|----------|--------|
| T-101-06 | Elevation of Privilege | Mitigated - level hierarchy check on every request |
| T-101-07 | Elevation of Privilege | Mitigated - all 10 unprotected routes now have auth |
| T-101-08 | Information Disclosure | Mitigated - permissions endpoint is user-scoped via verifyToken |
| T-101-09 | Elevation of Privilege | Mitigated - access_level validated as enum before query |

## Deviations from Plan

- **Test update (Rule 2):** Updated `require-instance-access.test.ts` and `rbac-service.test.ts` to match changed return types and middleware behavior. The existing tests expected old `number[]` return types and `checkInstanceAccess` calls, which would fail after the API changes.
- **Wildcard bypass unchanged:** Plan implied middleware checks wildcards same as before. Confirmed that wildcard bypass remains before instance query, which is correct.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check

- [x] All 3 tasks executed and committed
- [x] Each task committed individually with proper format
- [x] Test updates committed separately
- [x] No deploy items deferred
- [x] SUMMARY.md created

## Commits

```
24035d19f0c feat(101-02): extend requireInstanceAccess with level hierarchy and add checkInstanceAccessLevel
591889b4df0 feat(101-02): add requireInstanceAccess level to all instance routes in server.ts
6468885bda2 feat(101-02): add GET /api/auth/permissions endpoint and extend rbac with access_level
159c1fdbb86 test(101-02): update tests for access_level changes and add level hierarchy tests
```
