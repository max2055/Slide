# Phase 101: 认证权限 - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

## Phase Boundary

实现 JWT refresh token 机制和精细化权限管控。消除登录丢失问题，实现实例级访问控制（read-only / read-write / admin），前端导航根据权限感知隐藏不可访问项。

**Requirements:** AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05
**Depends on:** Phase 100

## Implementation Decisions

### AUTH-01/02: Refresh Token 策略
- **D-01:** access token 有效期 1 小时，refresh token 有效期 7 天
- **D-02:** 启用 token rotation——每次 `/api/auth/refresh` 同时下发新的 refresh token，旧的立即失效。若攻击者使用已失效的 refresh token，系统检测到重放并废弃该用户所有 token
- **D-03:** refresh token 存储在 localStorage，与现有 token 存储方式一致
- **D-04:** 新增 `refresh_tokens` 表，记录 token_hash、user_id、expires_at、revoked 字段

### AUTH-04: 实例访问级别
- **D-05:** 三级访问控制按操作类型划分：
  - **read-only**: 查看指标、列表、详情 + 执行 SQL SELECT
  - **read-write**: 以上全部 + SQL INSERT/UPDATE/DELETE + 配置修改
  - **admin**: 以上全部 + 删除实例 + 管理该实例的用户授权
- **D-06:** 已有 `require-instance-access.ts` 中间件，在此基础上扩展级别检查逻辑

### AUTH-05: 权限感知导航
- **D-07:** 无权限的导航项完全隐藏（不是灰显）
- **D-08:** 扩展现有 scopes 机制——`hello.auth.scopes` 已下发，`hasOperatorReadAccess()` 已有。将导航项与 scope 关联匹配

### AUTH-03: 授权过期
- **D-09:** grant_expiry 到期立即回收权限，静默降级。用户下次刷新或 API 调用时自然失去该权限，不影响登录态
- **D-10:** 不做提前提醒、不做宽限期。管理员可在用户管理界面查看即将过期的授权

### Claude's Discretion
- refresh token 表的具体 schema 设计
- token rotation 的重放检测阈值和告警策略
- 实例访问级别的具体 API 路由映射（哪些路由对应哪个级别）

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Auth Infrastructure
- `apps/db-ops-api/server.ts` — JWT 签发逻辑（L279-287）、verifyToken 中间件（L85-107）
- `apps/db-ops-api/src/auth/require-permission.ts` — 权限校验中间件
- `apps/db-ops-api/src/auth/require-instance-access.ts` — 实例级访问中间件（待扩展）
- `apps/db-ops-api/src/auth/rbac-service.ts` — 角色/权限管理服务
- `apps/db-ops-api/src/auth-database-service.ts` — 用户认证数据库层（Phase 84 移除了 users.role 列，角色改走 user_roles 表）

### Frontend Auth
- `frontend/src/api/index.ts` — ApiClient，token 管理（setToken/getToken），需添加 401 拦截器
- `frontend/src/openclaw/ui/app-gateway.ts` — REST 登录调用（L289-297）
- `frontend/src/openclaw/ui/app-settings.ts` — hasOperatorReadAccess()（L497-505），导航权限检查入口

### Navigation
- `frontend/src/openclaw/ui/navigation.ts` — TAB_GROUPS、TAB_PATHS 定义
- `frontend/src/openclaw/ui/app-render.ts` — 侧边栏渲染，权限条件渲染插入点

### Specs
- `.planning/REQUIREMENTS.md` — AUTH-01~AUTH-05 需求定义
- `.planning/ROADMAP.md` — Phase 101 成功标准和依赖

## Existing Code Insights

### Reusable Assets
- `verifyToken` (server.ts:85) — 已有 JWT 验证，需扩展支持 token 过期时的 refresh flow
- `requirePermission('xxx:yyy')` — 已有权限校验模式，AUTH-04 可复用
- `hasOperatorReadAccess()` (app-settings.ts:497) — 已有 scope 检查，AUTH-05 直接扩展
- `updateHealthStatusFromCheck()` (monitor-collector.ts:274) — checkHealth 调用模式，AUTH-04 类似的中间件+服务模式
- Phase 100 的 `logout()` 和 `connectedCallback` 自动重连——Gateway 侧会话恢复已解决，AUTH-01/02 只需关注 REST API 的 token 刷新

### Established Patterns
- Fastify route auth: `{ preHandler: [verifyToken] }` 或 `{ preHandler: [verifyToken, requirePermission('...')] }`
- Scope-based access: `roleScopesAllow({ role, scopes, required })` 模式

### Integration Points
- `/api/auth/login` → 需新增下发 refresh token
- `/api/auth/refresh` → 新增路由
- `ApiClient.get/post/put/delete` → 需添加 401 拦截 + 自动刷新逻辑
- 侧边栏 TAB_GROUPS 渲染 → 需接入 scope 检查过滤

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: 101-认证权限*
*Context gathered: 2026-05-20*
