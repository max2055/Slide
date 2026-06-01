# Phase 85: RBAC Frontend - Context

**Gathered:** 2026-05-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Admin RBAC 管理页面：在 settings 组新增独立的 "rbac" Tab（菜单名"权限管理"），提供角色和权限码的 CRUD 管理界面。用户-角色绑定和实例权限管理集成在用户管理页面中。

后端 API（Phase 84）已就绪：18 个 `/api/v1/rbac/*` 端点覆盖 roles/permissions/role-permissions/user-roles/instance-permissions 全部 CRUD 操作。
</domain>

> **Post-UAT Scope Update (2026-05-12):** Phase 84 UAT 后 sub-tab 从 4 个精简为 2 个（角色管理、权限管理）。用户-角色绑定和实例权限已在用户管理页面中实现，不再作为 RBAC 页面独立 sub-tab。菜单名从 "RBAC 权限管理" 改为 "权限管理"。

<decisions>
## Implementation Decisions

### Page Structure & Navigation
- **D-01:** 在 `navigation.ts` 的 settings TAB_GROUPS 中新增 "rbac" Tab，路由路径 `/rbac`
- **D-02:** RBAC 页面内部使用 2 个顶部 sub-tab 切换：角色管理 / 权限管理（用户-角色绑定和实例权限功能整合到用户管理页面 users-management.ts）
- **D-03:** 现有 users Tab 的角色列改为展示多角色 badges（可点击跳转到 RBAC 页面）

### 角色管理 Sub-tab
- **D-04:** 表格列出所有角色（名称、描述、权限数、用户数），支持创建/编辑/删除
- **D-05:** 创建/编辑角色使用 Modal 弹窗（name + description 字段）
- **D-06:** 每行"编辑权限"按钮 → Modal 弹窗，内部按 resource 类型分组展示 checkbox 列表（instance/alert/user/sql/notification/collector/ai/system 等），勾选/取消勾选后保存

### 权限管理 Sub-tab
- **D-07:** 完整 CRUD：表格列出所有权限码（code, name, resource, action, description）
- **D-08:** 创建按钮 → Modal，code 字段校验 `resource:action` 格式
- **D-09:** 删除按钮带确认对话框

- **D-10~D-13:** 用户-角色绑定和实例权限功能已移至用户管理页面实现，不再作为 RBAC 页面 sub-tab。

### Claude's Discretion
- 4 个 sub-tab 的组件拆分方式（独立 LitElement 组件 vs 单组件内 switch）
- API 调用封装方式（fetch wrapper inline vs 共享 api/rbac.ts 模块）
- Loading/empty/error 状态处理
- 响应式行为（移动端两栏变上下布局等）
- 角色 badge 点击跳转的实现方式
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Planning
- `.planning/ROADMAP.md` — Phase 85 goal and success criteria (RBAC-09)
- `.planning/REQUIREMENTS.md` — RBAC-09 requirement
- `.planning/phases/84-rbac-foundation/84-CONTEXT.md` — Phase 84 decisions (permission model, namespace convention, API design)

### Backend API (Phase 84 deliverables)
- `apps/db-ops-api/src/auth/rbac-api.ts` — 18 个 `/api/v1/rbac/*` 端点完整定义，含请求/响应格式和参数校验
- `apps/db-ops-api/src/auth/rbac-service.ts` — RbacService 类，所有 CRUD 方法的参数和返回类型
- `apps/db-ops-api/src/auth/require-permission.ts` — requirePermission 中间件，理解权限码匹配逻辑
- `apps/db-ops-api/src/auth/require-instance-access.ts` — requireInstanceAccess 中间件，理解 wildcard 逻辑

### Existing Frontend Patterns
- `frontend/src/openclaw/ui/navigation.ts` — Tab 类型定义和 TAB_GROUPS 路由注册
- `frontend/src/openclaw/ui/app-render.ts` — 页面路由分发（switch state.tab）
- `frontend/src/openclaw/ui/views/users-management.ts` — 现有用户管理页（LitElement + table + modal 模式，需更新 role 列）
- `frontend/src/openclaw/ui/views/llm-config.ts` — CRUD 管理页面参考（table + modal dialog 模式、API 调用模式、CSS 变量使用）
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **LLMConfigPage** (`llm-config.ts`): 完整的 CRUD 管理页面模式 — table listing、modal dialog（创建/编辑/确认）、API 调用、loading/error 状态、badge 展示。RBAC 管理页面可直接复用此模式
- **UsersManagement** (`users-management.ts`): 用户表格 + role badge + 创建/编辑 modal 模式。需更新：role 列改为数组展示、新增实例权限按钮
- **CSS 变量系统**: `--card`, `--border`, `--bg-elevated`, `--accent`, `--muted`, `--text` 等变量已定义，card/table/btn/badge 等样式复用

### Established Patterns
- `@customElement("element-name")` + `LitElement` + `@state()` 装饰器
- `static styles = css\`...\`` 组件内样式
- Modal 弹窗使用 `.dialog-overlay` + `.dialog` 固定定位 pattern
- 表格使用 HTML `<table>` + `.table` class + `.card` 容器
- API 调用使用 `fetch()` + `localStorage.getItem("token")` 认证
- 用户角色判断：`getUserRole()` 解析 JWT token payload

### Integration Points
- `navigation.ts`: 需在 `Tab` union type 新增 `"rbac"`，在 `TAB_GROUPS` settings 组新增 `"rbac"`，在 `TAB_PATHS` 新增路由映射
- `app-render.ts`: 需 import rbac view 并在 `switch (state.tab)` 中新增 case
- `users-management.ts`: role 列需改为多角色 badges 展示，每行新增"实例权限"按钮
- RBAC API 所有端点需要 `admin:*` 权限（由后端 requirePermission 中间件校验），前端无需额外权限判断（后端返回 403 时显示错误即可）
</code_context>

<specifics>
## Specific Ideas

- 权限 checkbox 按 resource 分组，使用折叠面板（accordion）减少滚动
- 角色 badge 颜色映射延续 users-management.ts 的 role-badge 风格
- 用户搜索过滤使用客户端过滤（用户量级不大）
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.
</deferred>

---
*Phase: 85-rbac-frontend*
*Context gathered: 2026-05-09*
