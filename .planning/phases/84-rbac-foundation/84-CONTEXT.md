# Phase 84: RBAC Foundation - Context

**Gathered:** 2026-05-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Backend RBAC 基础建设：将当前硬编码的 `users.role` ENUM 单角色体系升级为可配置的多对多角色权限体系。交付 5 张新 MySQL 表、RbacService、两个新 Fastify 中间件、用户数据迁移脚本。前端管理页面（Phase 85）依赖本阶段的 API。

</domain>

<decisions>
## Implementation Decisions

### Permission Model
- **D-01:** Permission code namespace = `resource:action` 格式（如 `instance:view`, `alert:manage`, `user:create`）
- **D-02:** 两层粒度 + wildcard 支持。操作级（`instance:query`）+ 模块级（`instance:*`），中间件匹配时 `instance:query` 可被 `instance:*` 覆盖

### Migration Strategy
- **D-03:** 直接替换。一次性将所有用户从 `users.role` ENUM 迁移到 `user_roles` 表，迁移完成后删除旧 `role` 列

### Middleware Integration
- **D-04:** 完全替换。新增 `requirePermission` + `requireInstanceAccess` 替代旧 `requireRole`，旧中间件代码删除。115 处路由注册全部更新

### API Design
- **D-05:** 新 RBAC 管理 API 使用 `/api/v1/rbac/*` 路径。旧 `/api/users` 路径保留不动，Phase 85 完成后移除

### Claude's Discretion
- 权限码初始清单（基于现有 role-permissions.ts 推断资源类别）
- `requirePermission` 中间件的缓存策略
- 迁移脚本的事务边界和回滚方案
- 通配符匹配实现方式（字符串匹配 vs 正则 vs 集合运算）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Planning
- `.planning/ROADMAP.md` — Phase 84 goal and success criteria
- `.planning/REQUIREMENTS.md` — RBAC-01 through RBAC-08
- `.planning/research/ARCHITECTURE.md` — RBAC data model, permission check flow, middleware composition
- `.planning/research/PITFALLS.md` — Migration pitfalls, permission cache staleness, middleware ordering, route audit gaps

### Existing Code
- `apps/db-ops-api/src/auth/role-permissions.ts` — Existing RolePermissionRegistry, SystemRole types, DangerLevel definitions
- `apps/db-ops-api/src/auth-middleware.ts` — Existing requireRole preHandler pattern
- `apps/db-ops-api/src/auth/auth-database-service.ts` — User CRUD operations
- `apps/db-ops-api/sql/schema.sql` — Current `users` table with `role` ENUM column
- `apps/db-ops-api/server.ts` — 115 requireRole usages, 19 instance-scoped routes to audit

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **RolePermissionRegistry** (`role-permissions.ts`): 内存注册表模式，可扩展为 DB-backed。`register()/get()/has()` 接口保留
- **requireRole** (`auth-middleware.ts`): Fastify preHandler 组合模式，新中间件复用相同签名 `(request, reply) => void`
- **DEFAULT_ROLE_POLICIES** (`role-permissions.ts`): 6 种角色 × tool group 权限矩阵，用于推断初始 permission codes

### Established Patterns
- Fastify `preHandler` 数组组合：`[verifyToken, requireRole('admin')]` → `[verifyToken, requirePermission('instance:query'), requireInstanceAccess()]`
- Service class with `private getPool()` 封装 `dbConnection.getPool()`
- MySQL 直接 SQL 查询（无 ORM），参数化查询防注入

### Integration Points
- `server.ts` 115 处路由注册需要更新 preHandler 数组
- `verifyToken` 中间件设置 `request.user = { id, username, role }`，需扩展加入 permissions 集合
- 19 条实例级路由（`/instances/:id`）需加 `requireInstanceAccess`
- `/api/users` 路由保留不变，新增 `/api/v1/rbac/*` 路由组

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

### Reviewed Todos (not folded)
- **定时任务改为可配置** — 属于基础设施改进，不在 Phase 84 RBAC 范围内
- **自动 AI 分析结果不可见** — 属于 AI 分析展示问题，不在 RBAC 范围内

</deferred>

---
*Phase: 84-rbac-foundation*
*Context gathered: 2026-05-09*
