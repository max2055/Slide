---
phase: 101-认证权限
reviewed: 2026-05-20T13:00:00Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/sql/migrations/005_add_refresh_tokens_and_grant_expiry.sql
  - apps/db-ops-api/src/auth/rbac-api.ts
  - apps/db-ops-api/src/auth/rbac-service.test.ts
  - apps/db-ops-api/src/auth/rbac-service.ts
  - apps/db-ops-api/src/auth/require-instance-access.test.ts
  - apps/db-ops-api/src/auth/require-instance-access.ts
  - frontend/src/api/index.ts
  - frontend/src/openclaw/ui/app-gateway.ts
  - frontend/src/openclaw/ui/app-render.ts
  - frontend/src/openclaw/ui/app-settings.ts
  - frontend/src/openclaw/ui/app-view-state.ts
  - frontend/src/openclaw/ui/app.ts
  - frontend/src/openclaw/ui/navigation.ts
findings:
  critical: 5
  warning: 8
  info: 2
  total: 15
status: issues_found
---

# Phase 101: Code Review Report

**Reviewed:** 2026-05-20
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

This review covers authentication (JWT, refresh tokens), authorization (RBAC service, middleware), and frontend permission-aware navigation. Several critical security issues were found: three database schema endpoints completely lack authentication, the login endpoint does not check user lockout status, JWT verification degrades to bypass on DB failures, and refresh tokens can be returned un-persisted. Additionally, the frontend has a fall-through bug in the slash command handler and type inconsistencies in navigation config.

---

## Critical Issues

### CR-01: Tables / Describe / Indexes endpoints missing authentication

**File:** `apps/db-ops-api/server.ts:2435-2530`
**Issue:** Three database introspection endpoints are registered without any `preHandler: [verifyToken]` authentication:

- `GET /api/database/instances/:id/tables` (line 2435)
- `GET /api/database/instances/:id/tables/:tableName/describe` (line 2466)
- `GET /api/database/instances/:id/tables/:tableName/indexes` (line 2499)

These execute arbitrary SQL introspection queries (`SHOW TABLES`, `SELECT * FROM information_schema.COLUMNS`, `SELECT * FROM information_schema.STATISTICS`) on any database instance. An unauthenticated attacker who knows the instance ID can enumerate all tables, columns, and indexes across all databases.

**Fix:** Add the same auth chain as all other instance-scoped endpoints:

```typescript
fastify.get('/api/database/instances/:id/tables', {
  preHandler: [verifyToken, requireInstanceAccess('read-only')]
}, async (request, reply) => { ... });
```

Apply the same pattern to the `/describe` and `/indexes` endpoints.

---

### CR-02: verifyToken degrades to allow-all on DB failure

**File:** `apps/db-ops-api/server.ts:105-108`
**Issue:** When `authDatabaseService.getUserById(decoded.userId)` throws (DB connection error, timeout, etc.), the catch block silently grants access:

```typescript
} catch {
  console.warn('[auth] 用户状态查询失败，使用 JWT 缓存角色');
  (request as any).user = decoded;
}
```

This means if the database becomes temporarily unavailable, every valid JWT (including those for deleted or locked users) is accepted without status verification. An administrator who locks a malicious user's account cannot rely on the lock taking effect until the DB query succeeds.

Additionally, even when the DB query succeeds, the code only checks `if (!currentUser)` (null/undefined check) but never verifies the user's `status` field. The comment at line 100 claims it handles "inactive/locked" but the code does not:

```typescript
const currentUser = await authDatabaseService.getUserById(decoded.userId);
if (!currentUser) {
  return reply.code(401).send({ error: '用户已失效，请重新登录' });
}
// No status check!
(request as any).user = decoded;
```

A user with `status = 'locked'` or `status = 'inactive'` who still exists in the database can use their JWT uninterrupted for the full 1-hour expiry.

**Fix:** Check the user's status field explicitly, and on DB failure, reject (deny) rather than allow (fail closed):

```typescript
const currentUser = await authDatabaseService.getUserById(decoded.userId);
if (!currentUser || currentUser.status !== 'active') {
  return reply.code(401).send({ error: '用户已失效，请重新登录' });
}
(request as any).user = decoded;
```

Remove the catch bypass entirely — a failed auth check should fail closed, not open.

---

### CR-03: Login does not check user lockout status

**File:** `apps/db-ops-api/server.ts:270-317`
**Issue:** The `POST /api/auth/login` handler authenticates by username and password but never verifies the user's `status` field. A user whose account is `locked` or `inactive` can still obtain valid JWT and refresh tokens. The admin's lock action is ineffective until the JWT naturally expires (1 hour for active tokens, but immediate for newly issued ones via login).

```typescript
const user = await authDatabaseService.getUserByUsername(username);
if (!user) return ...;  // Only checks existence
const passwordValid = await authDatabaseService.verifyPassword(username, password);
if (!passwordValid) return ...;
// No status check
const token = jwt.sign({ userId: user.id, username }, JWT_SECRET, { expiresIn: '1h' });
```

**Fix:** Add status verification after credential validation:

```typescript
const user = await authDatabaseService.getUserByUsername(username);
if (!user) return ...;
if (user.status !== 'active') {
  return reply.code(403).send({ error: '账户已锁定或已停用' });
}
```

---

### CR-04: createRefreshToken returns un-persisted token on DB failure

**File:** `apps/db-ops-api/src/auth/rbac-service.ts:611-628`
**Issue:** `createRefreshToken` creates the token and hash, then attempts the DB INSERT inside a try/catch that silently logs errors. Regardless of whether the INSERT succeeds, the return value includes the raw token — the caller treats it as a successfully persisted token:

```typescript
async createRefreshToken(userId, expiresAt): Promise<{ token: string; hash: string }> {
  const token = randomBytes(48).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  if (pool) {
    try {
      await pool.execute('INSERT INTO refresh_tokens ...');
    } catch (error) {
      console.error('创建 refresh token 失败:', error);
      // Token is still returned even though INSERT failed!
    }
  }
  return { token, hash };
}
```

If the INSERT fails (connection error, constraint violation, etc.), the client receives a refresh token with no corresponding DB record. On the next refresh request, `validateRefreshToken` finds nothing and returns `null`, forcing the user to re-login. This creates an unreliable auth experience with no indication of failure.

**Fix:** Either make the method return success/failure so the caller can respond with a 5xx error, or let the exception propagate:

```typescript
async createRefreshToken(userId, expiresAt): Promise<{ success: boolean; token?: string; error?: string }> {
  const token = randomBytes(48).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const pool = this.getPool();
  if (!pool) return { success: false, error: '数据库未连接' };
  try {
    await pool.execute('INSERT INTO refresh_tokens ...');
    return { success: true, token };
  } catch (error) {
    console.error('创建 refresh token 失败:', error);
    return { success: false, error: error.message };
  }
}
```

---

### CR-05: LLM config GET endpoints expose provider details without auth

**File:** `apps/db-ops-api/server.ts:483-502`
**Issue:** The two GET endpoints for LLM provider configuration have no authentication preHandler:

```typescript
fastify.get('/api/llm/configs', async (request, reply) => { ... });   // line 483
fastify.get('/api/llm/configs/:id', async (request, reply) => { ... }); // line 493
```

These return provider configurations including `api_base_url`, `default_model`, and whether `api_key_encrypted` is true. While the actual API key is not returned directly, the provider metadata is still sensitive (it reveals infrastructure choices and which services are configured).

All other LLM endpoints (`POST`, `PUT`, `DELETE`, `/toggle`, `/default`, `/sync`) properly use `[verifyToken, requirePermission('llm:manage')]`.

**Fix:** Add at minimum `verifyToken` protection:

```typescript
fastify.get('/api/llm/configs', {
  preHandler: [verifyToken, requirePermission('llm:view')]
}, async (request, reply) => { ... });
```

---

## Warnings

### WR-01: Missing break in onSlashAction switch case

**File:** `frontend/src/openclaw/ui/app.ts:433-438`
**Issue:** The `case "export"` in `onSlashAction` lacks a `break` or `return`, causing unintended fall-through to `case "refresh-tools-effective"`:

```typescript
case "export":
  exportChatMarkdown(this.chatMessages, this.assistantName);
  // Falls through!
case "refresh-tools-effective": {
  void refreshVisibleToolsEffectiveForCurrentSessionInternal(this);
  break;
}
```

Triggering the "export" slash command will also fire a tools-effective refresh network request. While the side effect is benign, it is unintended and misleads future maintainers.

**Fix:** Add `break` after `exportChatMarkdown`:

```typescript
case "export":
  exportChatMarkdown(this.chatMessages, this.assistantName);
  break;
```

---

### WR-02: grantInstanceAccess TOCTOU race condition

**File:** `apps/db-ops-api/src/auth/rbac-service.ts:466-480`
**Issue:** `grantInstanceAccess` uses a SELECT-then-INSERT/UPDATE pattern without a transaction or UNIQUE constraint. Two concurrent requests can both see no existing row and both INSERT, creating duplicate entries:

```typescript
// Request A and B both execute this concurrently
const [existing] = await pool.execute(
  'SELECT id FROM instance_permissions WHERE user_id = ? AND instance_id = ?',
  [userId, instanceId]
);
if (Array.isArray(existing) && existing.length > 0) {
  // UPDATE
} else {
  // INSERT — both requests may reach here
}
```

The migration `005_add_refresh_tokens_and_grant_expiry.sql` does not add a UNIQUE(user_id, instance_id) constraint, so duplicates would not cause an error.

**Fix:** Add a UNIQUE constraint on `(user_id, instance_id)` in `instance_permissions`:

```sql
ALTER TABLE instance_permissions ADD UNIQUE INDEX `uq_user_instance` (`user_id`, `instance_id`);
```

Then use `INSERT ... ON DUPLICATE KEY UPDATE` to eliminate the race condition entirely.

---

### WR-03: Dashboard endpoints missing authentication

**File:** `apps/db-ops-api/server.ts:1196,1275`
**Issue:** Two dashboard data endpoints lack authentication:

- `GET /api/dashboard/capacity-trend` (line 1196) — returns cross-instance capacity aggregation including `total_size_gb`, trend data, and instance counts.
- `GET /api/dashboard/ai-stats` (line 1275) — returns AI analysis counts by type for the current day.

These are internal operational metrics that should not be publicly accessible.

**Fix:** Add auth preHandler to both:

```typescript
fastify.get('/api/dashboard/capacity-trend', {
  preHandler: [verifyToken, requirePermission('dashboard:view')]
}, async (request, reply) => { ... });
```

---

### WR-04: GET escalation / maintenance / silence endpoints missing auth

**File:** `apps/db-ops-api/server.ts:2857,2921,2969`
**Issue:** Read-only GET endpoints for escalation rules, maintenance windows, and silences are unprotected:

- `GET /api/alerts/escalation/rules` (line 2857)
- `GET /api/maintenance-windows` (line 2921)
- `GET /api/silence` (line 2969)

While their POST/PUT/DELETE counterparts have proper `requirePermission` guards, the read endpoints reveal operational schedules and alert suppression rules without authentication.

**Fix:** Add `verifyToken` and appropriate `requirePermission` (e.g., `alert:view`) to each.

---

### WR-05: Navigation Tab type missing "appearance" but TAB_PATHS references it

**File:** `frontend/src/openclaw/ui/navigation.ts:20-43,64-65`
**Issue:** The `Tab` type union (lines 20-43) does not include `"appearance"`, yet `TAB_PATHS: Record<Tab, string>` at line 45 includes `appearance: "/appearance"` at line 64. This is a TypeScript type error — assigning an invalid key to `Record<Tab, string>` should fail compilation.

The `TAB_GROUPS` (line 15) also references `"appearance"` under the `"settings"` label, and `app-render.ts` line 1639 checks `state.tab === "appearance"`.

This indicates the `Tab` type and `TAB_PATHS` have drifted out of sync. If TypeScript strict mode is not catching this, the project's type safety is weaker than intended.

**Fix:** Add `"appearance"` to the `Tab` union type:

```typescript
export type Tab =
  | "agents"
  | "ai-settings"
  | "appearance"
  // ... rest of tabs
```

---

### WR-06: Silently swallowed errors on login and permissions fetch

**File:** `frontend/src/openclaw/ui/app-gateway.ts:290-315`
**Issue:** Both the Slide REST API login attempt and the subsequent permissions fetch use `.catch(() => {})` which silently swallows all errors:

```typescript
fetch('/api/auth/login', { ... })
  .then(r => r.json()).then((d: any) => { ... })
  .catch(() => {});

fetch('/api/auth/permissions', { ... })
  .then(r => r.json()).then((perms) => { ... })
  .catch(() => {});
```

If the backend is unavailable, the login POST fails silently without any user-facing feedback. The user appears connected (Gateway WebSocket is up) but has no JWT token and no permissions loaded, meaning permission-gated navigation tabs will be hidden even if the user would otherwise have access.

Additionally, this login-and-fetch happens every time the gateway reconnects (`onHello` callback), which can be multiple times per session (seq-gap reconnects).

**Fix:** Log the error at minimum, and consider dispatching a state update that the UI can reflect:

```typescript
.catch((err) => {
  console.warn('[auth] Slide login failed:', err);
});
```

---

### WR-07: requireInstanceAccess missing NaN guard on instanceId

**File:** `apps/db-ops-api/src/auth/require-instance-access.ts:52`
**Issue:** The `instanceId` from URL params is converted to a number without validation:

```typescript
const accessLevel = await rbacService.checkInstanceAccessLevel(userId, Number(instanceId));
```

If `request.params.id` is a non-numeric string (e.g., `"abc"` from a malformed route), `Number("abc")` produces `NaN`. The SQL query would receive `NaN` as the parameter, which would cause a type mismatch or unexpected behavior — at best returning no rows (denying access to a legitimate user), at worst causing a DB error.

**Fix:** Validate the instance ID before using it:

```typescript
const instIdNum = Number(instanceId);
if (!Number.isFinite(instIdNum) || instIdNum <= 0) {
  return reply.code(400).send({ error: '无效的实例 ID' });
}
const accessLevel = await rbacService.checkInstanceAccessLevel(userId, instIdNum);
```

---

### WR-08: `read-write` / `admin` routes lack verifyToken in requireInstanceAccess chain

**File:** `apps/db-ops-api/server.ts:702,718,733,781`
**Issue:** Several endpoints require instance-scoped access but the preHandler chain ordering for `requireInstanceAccess('read-write')` or `requireInstanceAccess('admin')` relies on `verifyToken` appearing earlier in the array. While the routes inspected do have `verifyToken` first (e.g., line 702: `preHandler: [verifyToken, requirePermission('instance:update'), requireInstanceAccess('read-write')]`), the `requireInstanceAccess` middleware at line 24 directly accesses `request.user` which is only set by `verifyToken`. If `verifyToken` were ever removed or reordered, `requireInstanceAccess` would silently fail with a 401 "请先登录" error.

This is less a bug and more a fragile dependency. The middleware should ideally be self-contained or document this dependency more explicitly.

**Fix:** Add a guard in `requireInstanceAccess` that explicitly checks for the `user` property:

```typescript
return async (request: any, reply: any) => {
  const user = (request as any).user;
  if (!user) {
    return reply.code(401).send({ error: '请先登录' });
  }
  // ...
};
```

This is already done at line 24-27. The issue is documented as a coordination dependency but worth flagging for robustness.

---

## Info

### IN-01: Unnecessary COALESCE in grantInstanceAccess UPDATE

**File:** `apps/db-ops-api/src/auth/rbac-service.ts:472`
**Issue:** The UPDATE query uses `COALESCE(?, access_level)` but the parameter is always a non-null value (`accessLevel || 'read-only'` ensures the parameter is never NULL). The `COALESCE` is dead logic:

```typescript
await pool.execute(
  'UPDATE instance_permissions SET access_level = COALESCE(?, access_level) WHERE user_id = ? AND instance_id = ?',
  [accessLevel || 'read-only', userId, instanceId]
);
```

**Fix:** Simplify to direct assignment since the parameter is always non-null:

```typescript
['UPDATE instance_permissions SET access_level = ? WHERE user_id = ? AND instance_id = ?',
 [accessLevel || 'read-only', userId, instanceId]]
```

---

### IN-02: RbacService instantiated twice

**File:** `apps/db-ops-api/src/auth/rbac-api.ts:12`, `apps/db-ops-api/server.ts:84`
**Issue:** `RbacService` is instantiated both in `server.ts` (line 84) and `rbac-api.ts` (line 12). Both instances use the same underlying singleton `dbConnection`, so there is no functional issue, but it creates conceptual confusion about which service owns the state. The instance in `server.ts` is unused by `rbacApiRoutes` (which creates its own).

**Fix:** Either make `rbacApiRoutes` accept the service instance as a parameter, or remove the unused `server.ts` instance if it is not needed outside RBAC routes.

---

_Reviewed: 2026-05-20_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
