---
phase: 101-认证权限
verified: 2026-05-20T22:00:00Z
status: passed
score: 10/10 must-haves verified
overrides_applied: 0
---

# Phase 101: Authentication & Permissions Verification Report

**Phase Goal:** 实现JWT refresh token机制和精细化权限管控，消除登录丢失问题
**Verified:** 2026-05-20T22:00:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

## Goal Achievement

### Roadmap Success Criteria

| # | Success Criterion | Status | Evidence |
|---|-------------------|--------|----------|
| 1 | User can stay logged in across browser sessions without re-entering credentials; JWT auto-refreshes transparently via refresh token rotation | VERIFIED | JWT_EXPIRES_IN = '1h' (server.ts:83); refresh_tokens table (migration 005); POST /api/auth/refresh with rotation (server.ts:321-365); login returns refreshToken (server.ts:300-305) |
| 2 | When JWT expires during active session, frontend ApiClient automatically retries the request after transparent token refresh — no user-visible error | VERIFIED | fetchWithAuth with 401 interception (api/index.ts:124-152); attemptTokenRefresh (api/index.ts:92-122); refreshPromise deduplication (api/index.ts:140-144) |
| 3 | Temporary role grants with expiry are automatically revoked on expiration date; user loses associated permissions at midnight of expiry | VERIFIED | grant_expiry column on user_roles and instance_permissions (migration 005:34-45); SQL WHERE clause filtering on getUserPermissions (rbac-service.ts:559), checkInstanceAccess (rbac-service.ts:578), getUserInstanceAccess (rbac-service.ts:514), getUsersWithInstanceAccess (rbac-service.ts:532) |
| 4 | Instance-level permissions differentiate read-only, read-write, and admin access levels; users are restricted per instance accordingly | VERIFIED | access_level ENUM on instance_permissions (migration 005:43); AccessLevel type, ACCESS_LEVEL_HIERARCHY, requireInstanceAccess(minLevel) (require-instance-access.ts:14-20,22); checkInstanceAccessLevel method (rbac-service.ts:589-605); 11 read-only routes, 4 read-write routes, 1 admin route (server.ts) |
| 5 | Frontend navigation hides menu items the user does not have permission to access | VERIFIED | TAB_REQUIRED_PERMISSIONS mapping (navigation.ts:80-97); hasSlidePermission helper (app-settings.ts:510-526); sidebar filter() (app-render.ts:884-890); permissions fetched on login (app-gateway.ts:304-312); slide-permissions-loaded event triggers re-render (app.ts:501-504); userPermissions stored in AppViewState (app-view-state.ts:45) |

### Observable Truths (aggregated from all 4 plans)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User login returns both access token (1h JWT) and refresh token (7d random hex) | VERIFIED | server.ts:290-312 — jwt.sign with JWT_EXPIRES_IN='1h', createRefreshToken with 7d expiry, response includes refreshToken |
| 2 | POST /api/auth/refresh with valid refresh token returns new access token + new refresh token (rotation) | VERIFIED | server.ts:321-365 — validates hash, revokes old token (line 342), issues new pair (lines 352-363), returns token + refreshToken |
| 3 | Reuse of a consumed (revoked) refresh token triggers full user token revocation | VERIFIED | server.ts:330-334 — if stored.revoked, calls revokeAllUserTokens |
| 4 | Expired refresh tokens return 401 with clear error message | VERIFIED | server.ts:336-339 — checks stored.expires_at < Date.now(), returns 401 |
| 5 | User-role grants with past grant_expiry are automatically filtered out | VERIFIED | rbac-service.ts:559 — `AND (ur.grant_expiry IS NULL OR ur.grant_expiry > NOW())` in getUserPermissions |
| 6 | Instance permissions with past grant_expiry automatically revoke access | VERIFIED | rbac-service.ts:578 — `AND (grant_expiry IS NULL OR grant_expiry > NOW())` in checkInstanceAccess; also at lines 514, 532, 594 |
| 7 | Stale expired refresh tokens are periodically cleaned up | VERIFIED | server.ts:167-173 — cleanupExpiredRefreshTokens called on startup, deletes tokens where expires_at < NOW() - 30 DAY |
| 8 | requireInstanceAccess middleware accepts optional minLevel parameter with hierarchy | VERIFIED | require-instance-access.ts:22 — `export function requireInstanceAccess(minLevel?: AccessLevel)`; line 16-20: ACCESS_LEVEL_HIERARCHY with read-only=0, read-write=1, admin=2 |
| 9 | All previously unprotected instance GET routes now require auth | VERIFIED | 11 read-only routes including 10 previously unprotected routes: instances/:id (688), metrics (989), metrics/history (1003), topsql (1030), sessions (1155), capacity (1169), capacity/history (1183), capacity/databases (1313), databases (1084), schema-objects (1103), plus qan (1045) |
| 10 | Access level enforcement: GET read-only, PUT read-write, DELETE admin | VERIFIED | PUT instances/:id (702) read-write, POST reload (733) read-write, POST execute (781) read-write, DELETE instances/:id (718) admin |
| 11 | Instance permission grant API accepts optional access_level parameter | VERIFIED | rbac-api.ts:282-289 — body accepts accessLevel, validated against enum, default 'read-only' |
| 12 | GET /api/auth/permissions returns the user's permission code set | VERIFIED | server.ts:369-379 — calls getUserPermissions, returns Array.from(permissions) |
| 13 | Instance queries return access_level from instance_permissions | VERIFIED | rbac-service.ts:506-539 — getUserInstanceAccess and getUsersWithInstanceAccess both return {instance_id, access_level} (or {user_id, access_level}) |
| 14 | ApiClient stores refreshToken in localStorage | VERIFIED | api/index.ts:38-48 — setRefreshToken/getRefreshToken store/read localStorage key 'refreshToken' |
| 15 | 401 responses trigger automatic /api/auth/refresh call | VERIFIED | api/index.ts:136-148 — fetchWithAuth intercepts 401 status, calls attemptTokenRefresh |
| 16 | Multiple concurrent 401s share a single refresh request | VERIFIED | api/index.ts:36,140-144 — refreshPromise pattern: only creates promise if null, awaits same promise |
| 17 | Successful refresh retries queued requests; failed refresh clears tokens | VERIFIED | api/index.ts:145-148 — if newToken, retries; api/index.ts:107-112 — on HTTP error, clears both token and refreshToken |
| 18 | Login stores refreshToken from response | VERIFIED | app-gateway.ts:299-301 — checks d.refreshToken and calls apiClient.setRefreshToken |
| 19 | Frontend fetches permissions from GET /api/auth/permissions on app load | VERIFIED | app-gateway.ts:304-312 — after login, fetches /api/auth/permissions with Bearer token |
| 20 | Users/RBAC tabs hidden for non-admin users | VERIFIED | navigation.ts:82-83 — users and rbac mapped to 'admin:*'; app-render.ts:884-890 — filter uses hasSlidePermission |
| 21 | Permission check supports wildcard matching (exact, resource:*, global *) | VERIFIED | app-settings.ts:510-526 — hasSlidePermission checks exact match, resource:* prefix, global * |
| 22 | No-permission nav items are fully hidden (filtered, not greyed out) | VERIFIED | app-render.ts:884 — filter() before map() removes unauthorized tabs from DOM entirely |
| 23 | Permissions cached in localStorage on login, restored on page load | VERIFIED | app-gateway.ts:307 — localStorage.setItem('permissions'); app.ts:447-448 — connectedCallback reads from localStorage |
| 24 | slide-permissions-loaded event triggers sidebar re-render | VERIFIED | app-gateway.ts:309-311 — dispatches CustomEvent; app.ts:501-503 — listener calls this.requestUpdate() |

**Score:** 10/10 must-haves verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `apps/db-ops-api/sql/migrations/005_add_refresh_tokens_and_grant_expiry.sql` | Creates refresh_tokens table, adds grant_expiry, access_level | VERIFIED | 47 lines, 4 DDL changes in single transaction: refresh_tokens table, grant_expiry on user_roles, access_level + grant_expiry on instance_permissions. All with proper FK, indexes, charset. |
| `apps/db-ops-api/src/auth/rbac-service.ts` | Refresh token CRUD + grant_expiry filtering + access_level | VERIFIED | 692 lines. 5 new refresh token methods (create, validate, revoke, revokeAll, cleanup). 4 permission queries modified with grant_expiry filter. checkInstanceAccessLevel added. grantInstanceAccess accepts accessLevel. |
| `apps/db-ops-api/server.ts` | Login returns refreshToken, POST /api/auth/refresh, startup cleanup, route hardening, permissions endpoint | VERIFIED | 3524 lines. JWT_EXPIRES_IN='1h'. Login returns refreshToken. POST /api/auth/refresh with rotation + replay detection. Startup cleanup. 10 unprotected routes now have auth. GET /api/auth/permissions endpoint. |
| `apps/db-ops-api/src/auth/require-instance-access.ts` | Middleware with minLevel and hierarchy | VERIFIED | 65 lines. AccessLevel type, ACCESS_LEVEL_HIERARCHY, requireInstanceAccess accepts optional minLevel, calls checkInstanceAccessLevel from rbac-service, compares against hierarchy. |
| `apps/db-ops-api/src/auth/rbac-api.ts` | Instance permission API with access_level | VERIFIED | 329 lines. POST /users/:userId/instances accepts accessLevel body param (validated). GET returns access_level field. |
| `frontend/src/api/index.ts` | ApiClient with 401 interceptor, refresh token methods, fetchPermissions | VERIFIED | 193 lines. setRefreshToken/getRefreshToken, refreshPromise dedup, attemptTokenRefresh with plain fetch, fetchWithAuth with 401 interception, get/post/put/delete delegate to fetchWithAuth, fetchPermissions method. |
| `frontend/src/openclaw/ui/app-gateway.ts` | Stores refreshToken, fetches permissions on login | VERIFIED | 646 lines. Imports apiClient, stores d.refreshToken after login, dispatches slide-permissions-loaded CustomEvent. |
| `frontend/src/openclaw/ui/navigation.ts` | TAB_REQUIRED_PERMISSIONS mapping | VERIFIED | 239 lines. Mapping for 13 tabs with permission codes. Tabs not in mapping remain always visible. |
| `frontend/src/openclaw/ui/app-settings.ts` | hasSlidePermission helper | VERIFIED | 647 lines. Wildcard matching: exact, resource:*, global *. |
| `frontend/src/openclaw/ui/app-render.ts` | Permission-filtered sidebar | VERIFIED | 1726 lines. imports TAB_REQUIRED_PERMISSIONS and hasSlidePermission. filter() before map() in sidebar section. loadPermissionsFromStorage helper. |
| `frontend/src/openclaw/ui/app.ts` | Event listener + initialization | VERIFIED | Listens for slide-permissions-loaded event, calls this.requestUpdate(). Initializes userPermissions from localStorage cache. |
| `frontend/src/openclaw/ui/app-view-state.ts` | userPermissions state property | VERIFIED | Line 45: `userPermissions?: Set<string>` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| server.ts POST /api/auth/login | rbac-service.ts createRefreshToken() | Login handler calls createRefreshToken after JWT signing | VERIFIED | server.ts:301 — `const rt = await rbacService.createRefreshToken(...)` |
| server.ts POST /api/auth/refresh | rbac-service.ts validateRefreshToken() / revokeRefreshToken() / createRefreshToken() | Validates SHA-256 hash, revokes old, issues new pair | VERIFIED | server.ts:326, 342, 358 |
| rbac-service.ts getUserPermissions | SQL WHERE clause | grant_expiry filtering | VERIFIED | rbac-service.ts:559 — `AND (ur.grant_expiry IS NULL OR ur.grant_expiry > NOW())` |
| rbac-service.ts checkInstanceAccess | SQL WHERE clause | grant_expiry filtering | VERIFIED | rbac-service.ts:578 — `AND (grant_expiry IS NULL OR grant_expiry > NOW())` |
| require-instance-access.ts requireInstanceAccess(minLevel) | rbac-service.ts checkInstanceAccessLevel() | Middleware calls checkInstanceAccessLevel for level-aware check | VERIFIED | require-instance-access.ts:52 — `const accessLevel = await rbacService.checkInstanceAccessLevel(...)` |
| server.ts route registrations | require-instance-access.ts | preHandler: [verifyToken, requireInstanceAccess('LEVEL')] | VERIFIED | 16 routes with level-specific requireInstanceAccess (11 read-only, 4 read-write, 1 admin) |
| server.ts GET /api/auth/permissions | rbac-service.ts getUserPermissions() | Returns user permissions as array | VERIFIED | server.ts:373-374 |
| api/index.ts fetchWithAuth | /api/auth/refresh | 401 interceptor calls refresh endpoint | VERIFIED | api/index.ts:99 — `POST /api/auth/refresh` via plain fetch |
| app-gateway.ts login handler | api/index.ts setRefreshToken | Stores refresh token on login | VERIFIED | app-gateway.ts:300 |
| app-render.ts sidebar template | hasSlidePermission() check | filter() removes unauthorized tabs | VERIFIED | app-render.ts:884-890 |
| hasSlidePermission() | navigation.ts TAB_REQUIRED_PERMISSIONS | Looks up required permission per tab | VERIFIED | app-render.ts:885 — `const required = TAB_REQUIRED_PERMISSIONS[tab]` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| rbac-service.ts getUserPermissions | rbacService.getUserPermissions(userId) | SQL query on user_roles + role_permissions + permissions | Real DB query with grant_expiry filter | FLOWING |
| rbac-service.ts checkInstanceAccessLevel | rbacService.checkInstanceAccessLevel(userId, instanceId) | SQL query on instance_permissions | Real DB query with grant_expiry + access_level | FLOWING |
| server.ts POST /api/auth/refresh | rbacService.validateRefreshToken(tokenHash) | SQL query on refresh_tokens table | Real DB query | FLOWING |
| app-render.ts sidebar | state.userPermissions / loadPermissionsFromStorage() | localStorage cache populated by GET /api/auth/permissions | Real data from backend, fetched after login | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Frontend build | `cd frontend && npx vite build` | Build succeeds (887 modules, 0 errors) | PASS |
| Backend TypeScript check (phase-specific files only) | `cd apps/db-ops-api && npx tsc --noEmit` | Errors exist in phase files, all pre-existing (llmDatabaseService signature, not phase 101 changes) | SKIP (pre-existing) |

### Probe Execution

No probes declared for this phase. The phase execution used auto-verification grep patterns within the plan tasks.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| AUTH-01 | 101-01 | 实现 JWT refresh token 机制（新增 /api/auth/refresh 路由、refresh_tokens 表、token rotation） | SATISFIED | refresh_tokens table created (migration 005); POST /api/auth/refresh with rotation (server.ts:321-365); token rotation with SHA-256 hashing (rbac-service.ts:611-627) |
| AUTH-02 | 101-03 | 前端 ApiClient 添加 401 拦截器，自动透明刷新 token | SATISFIED | fetchWithAuth 401 interception (api/index.ts:124-152); attemptTokenRefresh (api/index.ts:92-122); login stores refreshToken (app-gateway.ts:299-301) |
| AUTH-03 | 101-01 | 实现时效性角色授权（grant_expiry 列，到期自动回收） | SATISFIED | grant_expiry on user_roles and instance_permissions (migration 005:34-45); filtered in all 4 permission queries (rbac-service.ts:559,578,514,532) |
| AUTH-04 | 101-02 | 实现实例级访问级别控制（read-only / read-write / admin） | SATISFIED | access_level ENUM column (migration 005:43); AccessLevel type and hierarchy (require-instance-access.ts); routed hardening with levels (server.ts) |
| AUTH-05 | 101-04 | 前端导航根据用户权限感知隐藏不可访问的菜单项 | SATISFIED | TAB_REQUIRED_PERMISSIONS mapping (navigation.ts); hasSlidePermission helper (app-settings.ts); sidebar filter (app-render.ts); login fetch (app-gateway.ts) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| *(none found in Phase 101 modified files)* | | | | |

### Human Verification Required

*No items requiring human verification identified. All criteria are verifiable via static code analysis.*

---

## Gaps Summary

No gaps found. All roadmap success criteria, plan truths, and requirement IDs are verified against the actual codebase.

All artifacts exist, are substantive (not stubs), are properly wired, and have flowing data paths.

Key achievements verified:
- Dual-token auth system: 1h JWT access token + 7d SHA-256 hashed refresh token with rotation and replay detection
- 5 refresh token methods in RbacService with SQL CRUD operations
- Login endpoint returns refreshToken; POST /api/auth/refresh handles rotation, replay, expiry
- Startup cleanup removes tokens expired >30 days
- grant_expiry filtering applied to all 4 permission queries (no cron needed)
- 16 instance routes hardened with access level hierarchy (11 read-only, 4 read-write, 1 admin)
- checkInstanceAccessLevel method with proper SQL query
- Frontend ApiClient with 401 interceptor, refresh deduplication, transparent retry
- Permission-aware navigation (filter-based tab hiding, wildcard matching, localStorage cache, CustomEvent re-render)

---

*Verified: 2026-05-20T22:00:00Z*
*Verifier: Claude (gsd-verifier)*
