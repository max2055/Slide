# Phase 101: 认证权限 - Research

**Researched:** 2026-05-20
**Domain:** JWT refresh token, RBAC extension, frontend permission-aware navigation
**Confidence:** HIGH

## Summary

Phase 101 implements five AUTH requirements building on the existing RBAC foundation (Phase 84-85). The backend already has JWT auth via `jsonwebtoken` 9.0.2, a complete role/permission/instance system in `rbac-service.ts`, and middleware patterns in `require-permission.ts` and `require-instance-access.ts`. The frontend stores JWT in `localStorage` via `ApiClient` and authenticates against Gateway via WebSocket with `hello.auth.scopes`.

**What needs to change:**
- **AUTH-01/02**: Add refresh token lifecycle (new `refresh_tokens` table, `/api/auth/refresh` endpoint, login response extension, ApiClient 401 interceptor with transparent retry)
- **AUTH-03**: Add `grant_expiry` columns to `user_roles` and `instance_permissions` tables, filter in existing permission lookup queries
- **AUTH-04**: Add `access_level` column to `instance_permissions`, extend `requireInstanceAccess()` middleware to accept a minimum level parameter, map all instance routes to levels, add auth to currently unprotected routes
- **AUTH-05**: Add `/api/auth/permissions` endpoint, extend login response with Slide-specific permission codes, filter `TAB_GROUPS` rendering in `app-render.ts`

**No new npm dependencies needed.** All required libraries (`crypto`, `jsonwebtoken`, `mysql2`, `bcrypt`) are already in the project.

**Primary recommendation:** Implement as 4-5 sequential plans: (1) refresh_tokens table + backend refresh endpoint + login modification, (2) frontend ApiClient 401 interceptor, (3) grant_expiry + user_roles table migration + filtering, (4) instance access levels + route mapping + unprotected route fix, (5) frontend permission-aware navigation with permissions endpoint.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: access token 1h, refresh token 7d
- D-02: token rotation enabled -- each refresh issues new refresh token
- D-03: refresh token stored in localStorage
- D-04: new refresh_tokens table (token_hash, user_id, expires_at, revoked)
- D-05: Three instance access levels -- read-only (view+SELECT), read-write (+modify), admin (+delete+manage users)
- D-06: Extend require-instance-access.ts for level checking
- D-07: No-permission nav items fully hidden (not greyed out)
- D-08: Extend existing scopes mechanism (hello.auth.scopes, hasOperatorReadAccess())
- D-09: grant_expiry immediate revocation, silent degradation
- D-10: No advance warning or grace period

### Claude's Discretion
- refresh token 表的具体 schema 设计
- token rotation 的重放检测阈值和告警策略
- 实例访问级别的具体 API 路由映射（哪些路由对应哪个级别）

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-01 | 实现 JWT refresh token 机制（新增 /api/auth/refresh 路由、refresh_tokens 表、token rotation） | crypto.createHash, jsonwebtoken 9.0.2, Fastify route pattern fully understood. Table schema designed. |
| AUTH-02 | 前端 ApiClient 添加 401 拦截器，自动透明刷新 token | ApiClient is a single class in `frontend/src/api/index.ts`. 401 interceptor pattern + retry queue designed below. |
| AUTH-03 | 实现时效性角色授权（grant_expiry 列，到期自动回收） | user_roles and instance_permissions tables exist (migration 002). Add grant_expiry column + WHERE clause. |
| AUTH-04 | 实现实例级访问级别控制（read-only / read-write / admin） | instance_permissions table exists. Add access_level column. Middleware extension + route mapping designed. |
| AUTH-05 | 前端导航根据用户权限感知隐藏不可访问的菜单项 | TAB_GROUPS in navigation.ts, renderTab in app-render.helpers.ts. Permissions endpoint + filter pattern designed. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Token signing/verification | API/Backend | -- | JWT_SECRET lives in backend .env, server.ts signs and verifies |
| Refresh token lifecycle | API/Backend | -- | New refresh_tokens table in MySQL, new /api/auth/refresh endpoint |
| Token rotation + replay detection | API/Backend | -- | Backend owns refresh_tokens DB table, checks revoked + expires_at |
| 401 transparent retry | Browser/Client | -- | ApiClient.ts manages token+refreshToken in localStorage, intercepts 401 |
| Grant expiry filtering | Database | API/Backend | WHERE clause in rbac-service.ts queries checks grant_expiry against NOW() |
| Instance access level check | API/Backend | Database | Middleware checks access_level in instance_permissions via rbac-service.ts |
| Permission-aware nav hiding | Browser/Client | API/Backend | Frontend TAB_GROUPS filter uses REST API permissions or JWT claims |
| Scope-based access (OpenClaw) | Browser/Client | Frontend Server | hello.auth.scopes from Gateway, hasOperatorReadAccess() checks |

## Standard Stack

### Core (already in project)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| jsonwebtoken | 9.0.2 | JWT signing, verification, expiry | Existing; already used in server.ts for auth |
| mysql2 | 3.20.0 | MySQL pool/execute API | Existing; all rbac-service queries use this |
| crypto (Node built-in) | -- | SHA-256 hashing for refresh tokens | Existing; already imported in server.ts |
| fastify | 4.24.3 | HTTP framework, router, preHandler | Existing; all routes registered on fastify instance |
| bcrypt | 6.0.0 | Password hashing | Existing; used in auth-database-service.ts |
| Lit | 3.3.2 | Web Components UI framework | Existing; app-render.ts, renderTab all use Lit html templates |

### No new packages required

All features can be implemented with existing dependencies:
- Refresh tokens: `crypto.randomUUID()` + `crypto.createHash('sha256')` for token generation and hashing
- Grant expiry: SQL `WHERE grant_expiry IS NULL OR grant_expiry > NOW()` filtering
- Access levels: `ENUM` column in `instance_permissions`
- Frontend permissions: REST API endpoint returning permission codes

## Architecture Patterns

### AUTH-01/02: Refresh Token Flow

```
Browser (ApiClient)               Backend (Fastify)                  MySQL
       │                               │                               │
       │── POST /api/auth/login ──────▶│                               │
       │   (username, password)        │── verifyPassword ────────────▶│
       │                               │◀── OK ───────────────────────│
       │                               │── INSERT refresh_tokens ─────▶│
       │◀── { access_token (1h),       │                               │
       │       refresh_token (7d) }    │                               │
       │                               │                               │
       │── (stores both in localStorage)                               │
       │                               │                               │
       │── GET /api/xxx (Bearer access_token) ──────▶│                 │
       │                               │── jwt.verify ─── expires!     │
       │◀── 401                           │                            │
       │                               │                               │
       │── POST /api/auth/refresh ─────▶│                               │
       │   { refresh_token }            │── hash refresh_token ───────▶│
       │                               │── SELECT from refresh_tokens ▶│
       │                               │── verify not revoked/expired  │
       │                               │── UPDATE revoked=TRUE ───────▶│
       │                               │── INSERT new refresh_tokens ─▶│
       │◀── { new_access_token,         │                               │
       │       new_refresh_token }     │                               │
       │                               │                               │
       │── retry original request ─────▶│                               │
       │   (new access_token)           │                               │
```

**Replay detection:** When a revoked refresh token is presented, immediately revoke ALL refresh tokens for that user (security measure). Log the event for audit. [VERIFIED: industry standard for token rotation]

### AUTH-03: Grant Expiry

```
GET /api/auth/permissions (or permission check in middleware)
  │
  ├── rbacService.getUserPermissions(userId)
  │     └── SQL: SELECT p.code FROM user_roles ur
  │                JOIN role_permissions rp ON ur.role_id = rp.role_id
  │                JOIN permissions p ON rp.permission_id = p.id
  │                WHERE ur.user_id = ?
  │                  AND (ur.grant_expiry IS NULL OR ur.grant_expiry > NOW())
  │
  └── rbacService.checkInstanceAccess(userId, instanceId)
        └── SQL: SELECT COUNT(*) FROM instance_permissions
                  WHERE user_id = ?
                    AND instance_id = ?
                    AND (grant_expiry IS NULL OR grant_expiry > NOW())
```

Key insight: No background cron job is needed (per D-09). The filtering happens on every permission check query, so revocation is immediate when the next API call hits the middleware.

### AUTH-04: Instance Access Levels

The `require-instance-access.ts` middleware factory currently does a binary check (has access / no access). It needs to be extended to accept a minimum access level parameter:

```typescript
// Usage:
// preHandler: [verifyToken, requireInstanceAccess('read-write')]
export function requireInstanceAccess(minLevel?: AccessLevel) { ... }
```

**Route-to-Level Mapping** (Claude's Discretion):

| Route | Current Auth | Required Level | Rationale |
|-------|-------------|----------------|-----------|
| GET /api/database/instances/:id | NONE | read-only | Basic instance detail view |
| GET /api/database/instances/:id/metrics | NONE | read-only | Read metrics data |
| GET /api/database/instances/:id/metrics/history | NONE | read-only | Historical metrics |
| GET /api/database/instances/:id/topsql | NONE | read-only | View slow queries |
| GET /api/database/instances/:id/qan | instance:view | read-only | Query analysis (reading) |
| GET /api/database/instances/:id/explain | instance:query | read-only | EXPLAIN is a read operation |
| GET /api/database/instances/:id/query-history | instance:query | read-only | View history |
| GET /api/database/instances/:id/sessions | NONE | read-only | View active sessions |
| GET /api/database/instances/:id/capacity | NONE | read-only | View capacity |
| GET /api/database/instances/:id/capacity/history | NONE | read-only | View capacity history |
| GET /api/database/instances/:id/capacity/databases | NONE | read-only | View capacity detail |
| GET /api/database/instances/:id/databases | NONE | read-only | List databases (read) |
| GET /api/database/instances/:id/schema-objects | NONE | read-only | Schema browsing |
| GET /api/metrics/:instanceId | verifyToken only | read-only | Metrics endpoint |
| PUT /api/database/instances/:id | instance:update | read-write | Update config |
| POST /api/database/instances/:id/reload | instance:manage | read-write | Connection management |
| POST /api/database/instances/:id/execute | instance:query | read-write | SQL mutation (INSERT/UPDATE/DELETE) |
| POST /api/database/instances/:id/capacity/collect | instance:manage | read-write | Trigger collection |
| DELETE /api/database/instances/:id | instance:delete | admin | Delete instance |
| POST /api/database/instances/:id | instance:create | admin | Create (though this has no instanceId param) |

Note: Routes without any auth (marked NONE) must have `verifyToken` and `requireInstanceAccess()` added -- they currently leak data to unauthenticated requests. This is a security fix in the same vein as Phase 100.

### AUTH-05: Permission-Aware Navigation

**How the existing scopes mechanism works:**

1. OpenClaw Gateway WebSocket sends `hello.auth.scopes` with operator scopes (e.g., `["operator.read", "operator.admin"]`)
2. Frontend checks via `hasOperatorReadAccess(auth)` using `roleScopesAllow()` in `operator-scope-compat.ts`
3. This is the Gateway-level auth, not Slide's REST API permissions

**How Slide permissions differ:**
- Slide uses permission codes from `permissions` table (e.g., `instance:view`, `admin:*`, `alert:view`)
- These are separate from OpenClaw Gateway scopes
- The user's Slide permissions come from the RBAC system (roles -> role_permissions -> permissions)

**Two approaches for frontend permission-awareness:**

Option A (recommended -- extends D-08 mechanism):
- Add Slide-specific permission codes to the JWT token during login (extend JWT payload)
- Or create a dedicated endpoint `/api/auth/permissions` that returns the user's full permission set
- Frontend maps each TAB_GROUPS entry to a required permission code
- Filter sidebar rendering based on permissions

**Tab-to-Permission Mapping:**

| Tab | Required Permission | Rationale |
|-----|-------------------|-----------|
| users | admin:* | User management requires admin |
| rbac | admin:* | RBAC management requires admin |
| llm-config | llm:view | LLM config requires llm:view (or llm:manage) |
| alerts | alert:view | Alert viewing requires alert:view |
| reports | report:view | Report viewing requires report:view |
| metric-registry | metric:view | Metric registry requires metric:view |
| approval | approval:view | Approval requires approval:view |
| ai-settings | ai:view | AI settings requires ai:view |
| dashboard | instance:view | Dashboard shows instances |
| instances-db | instance:view | Instance management requires instance:view |
| sql-console | instance:query | SQL console requires instance:query |
| events | event:view or alert:view | Event management |
| schema | schema:view | Schema management |
| OpenClaw tabs (overview, sessions, usage, cron, agents, skills, appearance) | None (delegated to OpenClaw Gateway scopes) | These are managed by Gateway, not Slide |

### SQL Migration Plan

Migration 005: `add_refresh_tokens_and_grant_expiry.sql`

```sql
START TRANSACTION;

-- 1a. refresh_tokens table (AUTH-01)
CREATE TABLE IF NOT EXISTS `refresh_tokens` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `token_hash` CHAR(64) NOT NULL COMMENT 'SHA-256 hash of the refresh token',
  `user_id` INT UNSIGNED NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `revoked` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_token_hash` (`token_hash`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_expires_at` (`expires_at`),
  CONSTRAINT `fk_rt_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1b. Add grant_expiry to user_roles (AUTH-03)
ALTER TABLE `user_roles`
  ADD COLUMN `grant_expiry` DATETIME NULL DEFAULT NULL AFTER `created_at`,
  ADD INDEX `idx_grant_expiry` (`grant_expiry`);

-- 1c. Add access_level and grant_expiry to instance_permissions (AUTH-04, AUTH-03)
ALTER TABLE `instance_permissions`
  ADD COLUMN `access_level` ENUM('read-only', 'read-write', 'admin') NOT NULL DEFAULT 'read-only' AFTER `instance_id`,
  ADD COLUMN `grant_expiry` DATETIME NULL DEFAULT NULL AFTER `access_level`,
  ADD INDEX `idx_grant_expiry` (`grant_expiry`);

COMMIT;
```

### Recommended Project Structure (changes only)

```
apps/db-ops-api/
├── server.ts                          # Add /api/auth/refresh route, modify login route
├── src/
│   └── auth/
│       ├── rbac-service.ts            # Add refreshToken CRUD, expiry-aware queries, access level checks
│       ├── require-instance-access.ts # Add minLevel parameter support
│       └── rbac-api.ts                # Extend instance permission APIs to support access_level
└── sql/
    └── migrations/
        └── 005_add_refresh_tokens_and_grant_expiry.sql   # New migration

frontend/
├── src/
│   ├── api/
│   │   └── index.ts                   # Add 401 interceptor with token refresh + retry
│   └── openclaw/
│       └── ui/
│           ├── app-render.ts          # Filter TAB_GROUPS by permissions
│           ├── app-render.helpers.ts  # Update renderTab to accept skip/visible flag
│           ├── app-settings.ts        # Add hasSlidePermission() helper
│           ├── app-gateway.ts         # Store refresh token on login response
│           └── navigation.ts          # Add TAB_REQUIRED_PERMISSIONS mapping
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JWT signing/verification | Custom HMAC implementation | jsonwebtoken 9.0.2 (existing) | Proper token expiry checking, algorithm enforcement |
| Password hashing | Custom hashing | bcrypt 6.0.0 (existing) | Salt generation, constant-time comparison, evolution support |
| Refresh token hashing | Custom KDF | crypto.createHash (sha256) | Refresh tokens are random 128-bit values, sha256 is sufficient for hashing |
| Scope permission matching | Custom wildcard logic | roleScopesAllow() (existing in operator-scope-compat.ts) | Already handles operator.read/admin/write scopes with prefix matching |

**Key insight:** The refresh token is NOT a JWT. It is a random UUID/crypto token that gets SHA-256 hashed and stored in the database. JWT expiration (1h) means fast re-auth; refresh token (7d) is the long-lived credential that enables session persistence. Token rotation means each refresh creates a new refresh token and invalidates the old one, limiting the window of any leaked refresh token.

## Common Pitfalls

### Pitfall 1: Token Rotation Replay Vulnerability
**What goes wrong:** If a stolen refresh token is used by an attacker, the legitimate user's next refresh attempt fails (because their token was already consumed on the first use at the wrong endpoint).
**Why it happens:** Token rotation without replay detection means the first one to use a refresh token wins; the other party gets permanently locked out.
**How to avoid:** Implement replay detection per D-02: if a *revoked* refresh token is submitted, revoke ALL refresh tokens for that user and log the event. This is a stronger security posture -- if there's evidence of token theft, it's better to force re-login than to silently grant access to one party.
**Warning signs:** User reports being unexpectedly logged out; logs show "refresh token replayed" warnings.

### Pitfall 2: Race Condition on 401 Retry
**What goes wrong:** When the access token expires, multiple concurrent API requests may all receive 401 at the same time and all try to refresh simultaneously, causing redundant /api/auth/refresh calls.
**Why it happens:** The frontend ApiClient has no mutex or promise cache around the refresh call.
**How to avoid:** Use a single `refreshPromise` that resolves to the new token. If a refresh is already in-flight, queue the retry behind the same promise. Only one /api/auth/refresh call executes at a time.
**Warning signs:** Browser network tab shows multiple /api/auth/refresh calls triggered by a single token expiration event.

### Pitfall 3: Routes Without Instance-Level Auth
**What goes wrong:** Several instance-related routes (GET /api/database/instances/:id, /metrics, /topsql, /sessions, /capacity, /databases, /schema-objects) have NO auth middleware at all, so even adding access_level checks to requireInstanceAccess() is insufficient unless verifyToken is also added.
**Why it happens:** These routes were implemented before the auth infrastructure was mature, and Phase 100 only fixed 4 specific routes, not the full inventory.
**How to avoid:** Add `verifyToken` and `requireInstanceAccess()` to ALL instance-specific routes in the same migration.
**Warning signs:** A GET request to `/api/database/instances/1/metrics` with no Authorization header returns data instead of 401.

### Pitfall 4: refresh_tokens Table Cleanup
**What goes wrong:** Stale expired refresh tokens accumulate in the database, slowing down index scans.
**Why it happens:** Token rotation generates new rows on every refresh. Over time, users with frequent refreshes can accumulate thousands of expired rows.
**How to avoid:** Add a periodic cleanup query (or on-startup cleanup): `DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL 30 DAY`. This can run in start() after DB initialization.
**Warning signs:** `SELECT COUNT(*) FROM refresh_tokens` grows unboundedly.

### Pitfall 5: Grant Expiry Midnight Semantics
**What goes wrong:** User expects "expires at midnight of expiry date" but timezone handling is inconsistent.
**Why it happens:** MySQL `DATE` vs `DATETIME` behavior differs; if expiry is stored as `2026-05-25` (DATE), MySQL may interpret midnight differently than if stored as `2026-05-25 23:59:59`.
**How to avoid:** Store grant_expiry as `DATETIME` and set to `2026-05-25 23:59:59` for "end of day" semantics. The comparison `grant_expiry > NOW()` in the WHERE clause naturally handles this. Document the convention clearly.
**Warning signs:** Users report losing permissions at 00:00 instead of 23:59 on expiry date.

## Code Examples

### Refresh Token Generation (Backend)

```typescript
// server.ts - inside login handler (after password verification)
import { randomBytes, createHash } from 'crypto';

// Generate random refresh token
const refreshToken = randomBytes(48).toString('hex'); // 96 chars hex = 48 bytes
const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

// Store hash in database
await pool.execute(
  'INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
  [tokenHash, user.id, refreshExpiresAt]
);

// Return both tokens
reply.send({
  token,       // access token (1h JWT, existing)
  refreshToken, // plaintext refresh token (client stores this)
  expiresIn: 3600,
  user: { ... },
});
```

### Token Rotation (Backend)

```typescript
// POST /api/auth/refresh handler
fastify.post('/api/auth/refresh', async (request, reply) => {
  const { refreshToken: rawToken } = request.body as { refreshToken: string };
  if (!rawToken) {
    return reply.code(400).send({ error: '缺少 refreshToken' });
  }

  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const [rows] = await pool.execute(
    'SELECT id, user_id, revoked, expires_at FROM refresh_tokens WHERE token_hash = ?',
    [tokenHash]
  ) as any;

  if (!rows || rows.length === 0) {
    return reply.code(401).send({ error: '无效的 refresh token' });
  }

  const stored = rows[0];

  // Replay detection: if already revoked, revoke ALL tokens for this user
  if (stored.revoked) {
    console.warn(`[security] Refresh token replay detected for user ${stored.user_id}`);
    await pool.execute(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?',
      [stored.user_id]
    );
    return reply.code(401).send({ error: 'refresh token 已被使用，请重新登录' });
  }

  // Check expiry
  if (new Date(stored.expires_at) < new Date()) {
    return reply.code(401).send({ error: 'refresh token 已过期，请重新登录' });
  }

  // Revoke current token (rotation)
  await pool.execute(
    'UPDATE refresh_tokens SET revoked = TRUE WHERE id = ?',
    [stored.id]
  );

  // Issue new tokens
  const newAccessToken = jwt.sign(
    { userId: stored.user_id, username: user.username },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const newRefreshToken = randomBytes(48).toString('hex');
  const newTokenHash = createHash('sha256').update(newRefreshToken).digest('hex');
  const newRefreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.execute(
    'INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    [newTokenHash, stored.user_id, newRefreshExpiresAt]
  );

  reply.send({
    token: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn: 3600,
  });
});
```

### ApiClient 401 Interceptor (Frontend)

```typescript
// frontend/src/api/index.ts - with 401 retry

class ApiClient {
  private refreshPromise: Promise<string | null> | null = null;

  setRefreshToken(token: string | null) {
    if (token) localStorage.setItem('refreshToken', token);
    else localStorage.removeItem('refreshToken');
  }

  getRefreshToken(): string | null {
    return localStorage.getItem('refreshToken');
  }

  private async attemptTokenRefresh(): Promise<string | null> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return null;

    try {
      const response = await fetch(this.buildURL('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        this.setToken(null);
        this.setRefreshToken(null);
        return null;
      }
      const data = await response.json();
      this.setToken(data.token);
      this.setRefreshToken(data.refreshToken);
      return data.token;
    } catch {
      return null;
    }
  }

  private async fetchWithAuth<T>(url: string, options: RequestInit): Promise<T> {
    const doFetch = (token: string | null) => {
      return fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: `Bearer ${token}` }),
          ...options.headers,
        },
      });
    };

    let response = await doFetch(this.getToken());

    if (response.status === 401) {
      // Deduplicate concurrent refresh attempts
      if (!this.refreshPromise) {
        this.refreshPromise = this.attemptTokenRefresh().finally(() => {
          this.refreshPromise = null;
        });
      }
      const newToken = await this.refreshPromise;
      if (newToken) {
        response = await doFetch(newToken);
      }
    }

    return this.parseResponse<T>(response);
  }

  async get<T>(endpoint: string, config?: RequestConfig): Promise<T> {
    const url = this.buildURL(endpoint, config?.params);
    return this.fetchWithAuth<T>(url, { ...config, method: 'GET' });
  }

  async post<T>(endpoint: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const url = this.buildURL(endpoint);
    return this.fetchWithAuth<T>(url, {
      ...config,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async put<T>(endpoint: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const url = this.buildURL(endpoint);
    return this.fetchWithAuth<T>(url, {
      ...config,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async delete<T>(endpoint: string, config?: RequestConfig): Promise<T> {
    const url = this.buildURL(endpoint, config?.params);
    return this.fetchWithAuth<T>(url, { ...config, method: 'DELETE' });
  }
}
```

### Instance Access Level Middleware

```typescript
// src/auth/require-instance-access.ts - extended version

export type AccessLevel = 'read-only' | 'read-write' | 'admin';

const ACCESS_LEVEL_HIERARCHY: Record<AccessLevel, number> = {
  'read-only': 0,
  'read-write': 1,
  admin: 2,
};

export function requireInstanceAccess(minLevel?: AccessLevel) {
  return async (request: any, reply: any) => {
    const user = (request as any).user;
    if (!user) {
      return reply.code(401).send({ error: '请先登录' });
    }

    const userId = user.userId;

    // Wildcard check
    const userPermissions = await rbacService.getUserPermissions(userId);
    if (userPermissions.has('*') || userPermissions.has('instance:*')) {
      return; // Wildcard passes all checks
    }

    const instanceId = request.params?.id || request.params?.instanceId;
    if (!instanceId) {
      return reply.code(400).send({ error: '缺少实例 ID' });
    }

    const accessLevel = await rbacService.checkInstanceAccessLevel(
      userId, Number(instanceId)
    );

    if (!accessLevel) {
      return reply.code(403).send({ error: '无权访问该实例' });
    }

    // If a minimum access level is required, check hierarchy
    if (minLevel) {
      const userLevel = ACCESS_LEVEL_HIERARCHY[accessLevel as AccessLevel] ?? -1;
      const requiredLevel = ACCESS_LEVEL_HIERARCHY[minLevel];
      if (userLevel < requiredLevel) {
        return reply.code(403).send({ error: '权限不足，需要 ' + minLevel + ' 级别' });
      }
    }
  };
}
```

### Permission-Aware Navigation (Frontend)

```typescript
// navigation.ts - add permission requirement mapping

export const TAB_REQUIRED_PERMISSIONS: Partial<Record<Tab, string>> = {
  'users': 'admin:*',
  'rbac': 'admin:*',
  'llm-config': 'llm:view',
  'alerts': 'alert:view',
  'reports': 'report:view',
  'metric-registry': 'metric:view',
  'approval': 'approval:view',
  'ai-settings': 'ai:view',
  'events': 'alert:view',
  'schema': 'schema:view',
  'instances-db': 'instance:view',
  'dashboard': 'instance:view',
  'sql-console': 'instance:query',
  // OpenClaw tabs are not listed -- they remain always visible
};
```

```typescript
// app-render.ts - in the sidebar rendering (around line 846)
import { TAB_REQUIRED_PERMISSIONS } from './navigation.ts';

// In the renderApp function, before rendering sidebar:
const userPermissions = state.userPermissions ?? new Set<string>();
const hasPermission = (tab: Tab): boolean => {
  const required = TAB_REQUIRED_PERMISSIONS[tab];
  if (!required) return true; // No requirement = always visible
  // Wildcard matching (same logic as require-permission.ts)
  if (userPermissions.has('*')) return true;
  if (userPermissions.has(required)) return true;
  const colonIdx = required.indexOf(':');
  if (colonIdx !== -1) {
    const resourcePrefix = required.substring(0, colonIdx) + ':*';
    if (userPermissions.has(resourcePrefix)) return true;
  }
  return false;
};

// Then in the sidebar template, filter tabs:
${group.tabs.map((tab) =>
  hasPermission(tab) ? renderTab(state, tab, { collapsed: navCollapsed }) : nothing
)}
```

### Grant Expiry Query (Backend)

```typescript
// rbac-service.ts - modified getUserPermissions
async getUserPermissions(userId: number): Promise<Set<string>> {
  const pool = this.getPool();
  if (!pool) return new Set();

  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT p.code
       FROM user_roles ur
       JOIN role_permissions rp ON ur.role_id = rp.role_id
       JOIN permissions p ON rp.permission_id = p.id
       WHERE ur.user_id = ?
         AND (ur.grant_expiry IS NULL OR ur.grant_expiry > NOW())`,
      [userId]
    ) as any;
    return new Set((rows as any[]).map((r: any) => r.code));
  } catch (error) {
    console.error('获取用户权限失败:', error);
    return new Set();
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| JWT 24h expiry, no refresh | JWT 1h + refresh token 7d | Phase 101 | Users stay logged in across sessions; token rotation prevents replay |
| instance_permissions: binary access | instance_permissions: 3-level access (read-only/read-write/admin) | Phase 101 | Finer-grained control per instance; read-only users can view but not modify |
| user_roles: permanent | user_roles: grant_expiry optional | Phase 101 | Temporary role grants with automatic expiration |
| Route data: unprotected | Route data: verifyToken + requireInstanceAccess(level) | Phase 101 | All instance data access flows through auth |
| Sidebar: all tabs visible | Sidebar: tabs filtered by permissions | Phase 101 | No unauthorized navigation options visible |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | refresh_tokens table cleanup (deleting expired rows) can run on startup | AUTH-01 | Low -- expired rows are filtered by query even without cleanup |
| A2 | JWT payload can be extended with permission codes without breaking existing verification | AUTH-05 | Medium -- existing tokens in circulation won't have new claims; code must handle missing claims gracefully via `|| []` |
| A3 | OpenClaw Gateway scopes (hello.auth.scopes) and Slide REST API permissions are independent systems | AUTH-05 | Low -- confirmed by code inspection; they are served by different auth backends |
| A4 | The `userPermissions` set from `getUserPermissions()` can be fetched by a new API endpoint and passed to frontend | AUTH-05 | Low -- same query already used by require-permission.ts middleware |

## Open Questions

1. **User info/permissions in JWT payload or dedicated endpoint?**
   - What we know: Existing JWT only contains userId + username. Adding permission codes would make it larger but reduce API calls.
   - What's unclear: Whether the jwt.decode-only approach (no DB hit for permission check) is worth the complexity. Current middleware always calls `getUserPermissions()` which hits the DB.
   - Recommendation: Use a dedicated `/api/auth/permissions` endpoint for frontend consumption. Keep JWT payload lightweight. The existing middleware already hits DB so there is no performance gain from embedding permissions in the JWT.

2. **frontend state management for userPermissions?**
   - What we know: AppViewState has many state fields but no `userPermissions` field.
   - What's unclear: When to fetch permissions (on login, on gateway hello, periodically) and how to cache them.
   - Recommendation: Fetch permissions on login response and store in localStorage alongside token. Re-fetch on 401 auto-refresh. Add `userPermissions: Set<string>` to AppViewState (or equivalent state).

3. **Should OpenClaw Gateway tabs (overview, sessions, usage, cron, agents, skills, appearance) also be permission-filtered?**
   - What we know: These are controlled by OpenClaw Gateway scopes (operator.read/write/admin), not Slide's RBAC.
   - What's unclear: Whether we should also demand a Slide permission for these tabs, or keep them controlled only by Gateway scopes.
   - Recommendation: Keep them controlled only by Gateway scopes. The `hasOperatorReadAccess()` check already protects sensitive areas. Slide permissions should only gate Slide-specific features.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| jsonwebtoken | JWT signing/verification | Yes | 9.0.2 | -- |
| mysql2 | All DB queries | Yes | 3.20.0 | -- |
| crypto (Node built-in) | Refresh token hashing | Yes | Node built-in | -- |
| bcrypt | Password hashing (not directly needed, existing) | Yes | 6.0.0 | -- |
| vite | Frontend dev server | Yes | 5.0.0 | -- |

**Missing dependencies with no fallback:** None -- all required libraries are already installed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (likely configured via vite) or jest via package.json |
| Config file | TBD -- check frontend/ and apps/db-ops-api/ for test configs |
| Quick run command | `cd apps/db-ops-api && npx vitest run src/auth/ --reporter verbose` |
| Full suite command | TBD |

### Phase Requirements -> Test Map

The following tests exist from Phases 84-85 that should still pass after modifications:
- `src/auth/require-permission.test.ts` -- tests wildcard matching
- `src/auth/rbac-service.test.ts` -- tests all CRUD operations
- `src/auth/require-instance-access.test.ts` -- tests existing access check
- `src/auth/role-permissions.test.ts` -- tests role-permission assignment
- `src/auth/approval-flow.test.ts` -- approval flow tests
- `src/auth/migration.test.ts` -- migration tests

New tests needed:
| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|-------------------|
| AUTH-01 | Refresh token creation, rotation, replay detection | integration | `cd apps/db-ops-api && npx vitest run src/auth/rbac-service.test.ts` |
| AUTH-03 | Grant expiry filtering in permission queries | unit | Same -- extend rbac-service.test.ts |
| AUTH-04 | Instance access level hierarchy (read-only < read-write < admin) | unit | Extend require-instance-access.test.ts |

### Sampling Rate
- Per task commit: Run auth-related tests
- Phase gate: Full auth test suite green before /gsd-verify-work

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | JWT with refresh token rotation (jsonwebtoken 9.0.2) |
| V3 Session Management | Yes | Refresh token rotation + replay detection |
| V4 Access Control | Yes | RBAC permission codes + instance access levels |
| V5 Input Validation | Yes | zod would be ideal, but existing `requirePermission()` pattern uses SQL parameterization via `pool.execute()` |
| V6 Cryptography | Yes | SHA-256 for refresh token hashing, bcrypt for passwords |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Refresh token theft/replay | Tampering | Token rotation (D-02): each refresh invalidates old token. Replay detection: reuse of revoked token triggers full user token revocation |
| JWT expiry reuse | Elevation of Privilege | verifyToken() always checks jwt.verify() which enforces expiry. 1h window limits exposure |
| Access level bypass | Elevation of Privilege | Checks happen per-request in preHandler middleware; cannot be bypassed by URL manipulation |
| SQL injection in permission queries | Tampering | All queries use `pool.execute()` parameterized queries (verified in rbac-service.ts) |
| Direct URL access to unprotected routes | Information Disclosure | Phase 101 adds verifyToken + requireInstanceAccess() to all currently unprotected instance routes |

## Sources

### Primary (HIGH confidence)
- [VERIFIED: codebase] server.ts lines 80-111 -- JWT_SECRET, verifyToken implementation
- [VERIFIED: codebase] server.ts lines 260-302 -- login endpoint, JWT signing, response
- [VERIFIED: codebase] src/auth/require-instance-access.ts -- existing middleware pattern
- [VERIFIED: codebase] src/auth/require-permission.ts -- wildcard permission checking
- [VERIFIED: codebase] src/auth/rbac-service.ts -- all RBAC CRUD + permission lookup queries
- [VERIFIED: codebase] src/auth/rbac-api.ts -- all existing RBAC management API endpoints
- [VERIFIED: codebase] frontend/src/api/index.ts -- ApiClient class with setToken/getToken
- [VERIFIED: codebase] frontend/src/openclaw/ui/navigation.ts -- TAB_GROUPS, Tab type, TAB_PATHS
- [VERIFIED: codebase] frontend/src/openclaw/ui/app-render.ts -- sidebar rendering in renderApp()
- [VERIFIED: codebase] frontend/src/openclaw/ui/app-render.helpers.ts -- renderTab() implementation
- [VERIFIED: codebase] frontend/src/openclaw/ui/app-settings.ts -- hasOperatorReadAccess() with roleScopesAllow
- [VERIFIED: codebase] frontend/src/openclaw/ui/app-gateway.ts -- REST login during gateway hello
- [VERIFIED: codebase] sql/migrations/002_add_rbac_tables.sql -- existing RBAC schema
- [VERIFIED: npm registry] jsonwebtoken 9.0.2, fastify 4.24.3, bcrypt 6.0.0

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries verified installed and in use
- Architecture: HIGH -- all patterns exist in codebase and are well-understood
- Pitfalls: HIGH -- industry-standard token rotation pitfalls mitigated by replay detection
- Route mapping: MEDIUM -- specific level assignments are Claude's Discretion; may need tuning

**Research date:** 2026-05-20
**Valid until:** 2026-06-20 (stable stack, no fast-moving dependencies)
