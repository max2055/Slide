# Phase 85: RBAC Frontend - Research

**Researched:** 2026-05-10
**Domain:** LitElement/TypeScript frontend with RBAC management UI
**Confidence:** HIGH

## Summary

Phase 85 implements the admin RBAC management page for the Slide database operations platform. The backend (Phase 84) is fully complete and verified: 18 endpoints at `/api/v1/rbac/*` covering CRUD for roles, permissions, role-permission assignments, user-role bindings, and instance-level access grants. All endpoints require `admin:*` permission, enforced by `requirePermission` middleware on the backend.

The frontend stack uses Lit 3.3.2 with LitElement custom elements, following patterns established in existing views (`llm-config.ts` for CRUD management pattern, `users-management.ts` for user table with role badges). The work involves: (1) registering a new "rbac" tab in the navigation system, (2) building a parent page component with 4 sub-tabs, (3) implementing CRUD components for each sub-tab, and (4) updating the existing `users-management.ts` to show multi-role badges and add instance permission buttons.

**Primary recommendation:** Build 4 independent LitElement sub-tab components (roles, permissions, user-roles, instance-permissions) in a single file alongside a parent RbacPage shell, with a shared `api/rbac.ts` module for API calls. This follows the existing single-file view pattern (e.g., `users-management.ts`, `llm-config.ts`) while keeping API logic extractable for reuse.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Page Structure & Navigation
- **D-01:** 在 `navigation.ts` 的 settings TAB_GROUPS 中新增 "rbac" Tab，路由路径 `/rbac`
- **D-02:** RBAC 页面内部使用 4 个顶部 sub-tab 切换：角色管理 / 权限管理 / 用户-角色绑定 / 实例权限
- **D-03:** 现有 users Tab 的角色列改为展示多角色 badges（可点击跳转到 RBAC 页面对应用户-角色绑定视图）

#### 角色管理 Sub-tab
- **D-04:** 表格列出所有角色（名称、描述、权限数、用户数），支持创建/编辑/删除
- **D-05:** 创建/编辑角色使用 Modal 弹窗（name + description 字段）
- **D-06:** 每行"编辑权限"按钮 → Modal 弹窗，内部按 resource 类型分组展示 checkbox 列表（instance/alert/user/sql/notification/collector/ai/system 等），勾选/取消勾选后保存

#### 权限管理 Sub-tab
- **D-07:** 完整 CRUD：表格列出所有权限码（code, name, resource, action, description）
- **D-08:** 创建按钮 → Modal，code 字段校验 `resource:action` 格式
- **D-09:** 删除按钮带确认对话框

#### 用户-角色绑定 Sub-tab
- **D-10:** 左右分栏布局：左侧用户列表（可搜索/过滤），右侧显示选中用户当前角色
- **D-11:** 添加角色通过 dropdown 选择器，移除角色通过 badge × 按钮

#### 实例权限
- **D-12:** 用户列表每行"实例权限"按钮 → 独立 Modal
- **D-13:** Modal 内显示实例 checkbox 列表（已授权实例勾选），保存时调用 grant/revoke API

### Claude's Discretion
- 4 个 sub-tab 的组件拆分方式（独立 LitElement 组件 vs 单组件内 switch）
- API 调用封装方式（fetch wrapper inline vs 共享 api/rbac.ts 模块）
- Loading/empty/error 状态处理
- 响应式行为（移动端两栏变上下布局等）
- 角色 badge 点击跳转的实现方式

### Deferred Ideas (OUT OF SCOPE)
None.
</user_constraints>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RBAC-09 | Frontend provides role/user/permission/instance-access CRUD management page | 18 backend endpoints verified at `/api/v1/rbac/*`. Existing LitElement CRUD patterns in `llm-config.ts` and `users-management.ts`. Navigation system supports new tab registration in `navigation.ts`. |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| RBAC Page navigation | Browser (Frontend) | -- | Tab registration, routing, sub-tab switching all occur in browser LitElement components |
| Role CRUD | Browser (Frontend) | API (Backend) | UI displays forms/tables, sends to `/api/v1/rbac/roles` endpoints |
| Permission CRUD | Browser (Frontend) | API (Backend) | UI displays forms/tables, sends to `/api/v1/rbac/permissions` endpoints |
| Role-Permission assignment | Browser (Frontend) | API (Backend) | Checkbox UI sends batch grant/revoke to `/api/v1/rbac/roles/:id/permissions` |
| User-Role binding | Browser (Frontend) | API (Backend) | Split-pane UI sends assign/revoke to `/api/v1/rbac/users/:id/roles` |
| Instance-level access | Browser (Frontend) | API (Backend) | Checkbox modal UI sends grant/revoke to `/api/v1/rbac/users/:id/instances` |
| Users list in split-pane | Browser (Frontend) | -- | Client-side filter on loaded `/api/users` data (user count is small) |
| Instances list in checkbox modal | Browser (Frontend) | -- | Load from `/api/database/instances`, client-side check state |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Lit | 3.3.2 | Web Components framework | Existing project dependency, used by all views |
| TypeScript | ^5.x | Type-safe JavaScript | Existing project convention |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Vite | ^5.0.0 | Build tool | Already configured in frontend/ |

**Installation:**
```bash
# No new dependencies needed -- Lit 3.3.2 is already in frontend/package.json
```

**Version verification:** Lit 3.3.2 is the current latest on npm registry [VERIFIED: npm registry]. Already in `frontend/package.json`.

### Alternatives Considered

Not applicable -- this phase uses only existing project stack (LitElement + TypeScript). No new libraries needed.

### Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Confirmation dialogs | Custom confirm UI | `window.confirm()` | Used consistently in existing views (users-management.ts line 678). Sufficient for admin tool. |
| Icons | Custom SVG icons | Existing `icons.ts` module | Already has `plus`, `x`, `check`, `chevronDown`, `search`, `shield`, `settings` etc. |
| CSS reset/system | Custom CSS | Existing `--card`, `--border`, `--accent`, `--muted` variable system | Consistent look, already used in all views |

## Architecture Patterns

### System Architecture Diagram

```
User clicks "settings > rbac" in sidebar
  |
  v
navigation.ts: state.tab = "rbac"
app-render.ts: switch(state.tab) -> renders <rbac-page>
  |
  v
<rbac-page> shell (RbacPage)
  |-- Sub-tab bar: 角色管理 | 权限管理 | 用户-角色绑定 | 实例权限
  |-- Renders ONE sub-tab component based on active state
  |
  |-- +--- <role-management-tab> ----+
  |   |  GET /api/v1/rbac/roles       |  Table + create/edit/delete modals
  |   |  GET/DELETE /roles/:id        |  "Edit permissions" modal (grouped checkboxes)
  |   |  GET/POST /roles/:id/permissions |  Calls grant/revoke per change
  |   +--------------------------------+
  |
  |-- +--- <permission-management-tab> -+
  |   |  GET /api/v1/rbac/permissions    |  Table + create/delete modals
  |   |  POST/DELETE /permissions/:id    |  Code validation (resource:action)
  |   +----------------------------------+
  |
  |-- +--- <user-role-binding-tab> ------+
  |   |  GET /api/users (user list)       |  Left-right split pane
  |   |  GET /users/:id/roles (assigned)  |  Dropdown adds role, badge x removes
  |   |  POST/DELETE /users/:id/roles/:id |
  |   +-----------------------------------+
  |
  |-- +--- <instance-permissions-tab> ---+
  |   |  GET /api/users (user list)       |  User table with "实例权限" button
  |   |  GET /api/database/instances      |  Modal: instance checkboxes
  |   |  POST/DELETE /users/:id/instances |
  |   +-----------------------------------+
  |
  v
users-management.ts (updated)
  |-- Role column: multi-badge display (clickable -> navigate to RBAC user-role tab)
  |-- "实例权限" button per row
```

### Recommended Project Structure

```
frontend/src/openclaw/ui/
├── views/
│   ├── rbac-page.ts              # NEW: Parent shell + all 4 sub-tab components
│   └── users-management.ts       # MODIFIED: Multi-role badges, instance perm button
├── navigation.ts                 # MODIFIED: Add "rbac" Tab, TAB_GROUPS, TAB_PATHS
└── app-render.ts                 # MODIFIED: Import rbac-page, add switch case
```

**Rationale:** Single file for all RBAC components (`rbac-page.ts`) follows the existing project convention. Every existing view is a single file (`users-management.ts: 990 lines`, `llm-config.ts: 254 lines`, `instances-db.ts: 1000+ lines`). Splitting 4 sub-tabs into separate files would add 4 imports to `app-render.ts` with no real benefit.

### Pattern 1: CRUD Management Page (from llm-config.ts)

**What:** Table listing + modal dialogs for create/edit/delete + inline actions (toggle, test) [CITED: llm-config.ts]
**When to use:** All 4 sub-tabs follow this pattern
**Example:**
```typescript
@state() private roles: Role[] = [];
@state() private loading = true;
@state() private error: string | null = null;
@state() private showModal = false;
@state() private saving = false;

async _loadRoles() {
  this.loading = true;
  this.error = null;
  try {
    const token = localStorage.getItem("token") || "";
    const res = await fetch("/api/v1/rbac/roles", {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) {
      this.error = `加载失败 (${res.status})`;
      return;
    }
    this.roles = await res.json();
  } catch (e: any) {
    this.error = `网络错误: ${e.message}`;
  } finally {
    this.loading = false;
  }
}
```

### Pattern 2: Modal Dialog (from users-management.ts, llm-config.ts)

**What:** Fixed overlay + centered dialog card pattern [CITED: users-management.ts lines 305-337]
**When to use:** All create/delete/confirm dialogs
**Example:**
```typescript
// Modal overlay with backdrop click to dismiss
html`
  <div class="modal-overlay" @click=${(e: Event) => {
    if ((e.target as HTMLElement).classList.contains("modal-overlay")) {
      this._closeModal();
    }
  }}>
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">${title}</span>
        <button class="modal-close" @click=${this._closeModal}>&times;</button>
      </div>
      <div class="modal-body">
        <!-- form fields -->
      </div>
      <div class="modal-footer">
        <button class="btn" @click=${this._closeModal}>取消</button>
        <button class="btn btn--primary" @click=${this._save} ?disabled=${this.saving}>
          ${this.saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  </div>
`;
```

### Pattern 3: Navigation Tab Registration

**What:** Three-step registration: Tab type -> TAB_GROUPS -> TAB_PATHS -> app-render switch [CITED: navigation.ts, app-render.ts]
**When to use:** Adding any new top-level page
**Example (navigation.ts insertions):**
```typescript
// 1. In Tab union type:
type Tab = /* ... */ | "rbac"

// 2. In TAB_GROUPS settings:
{ label: "settings", tabs: ["config", "appearance", "system", "users", "llm-config", "rbac"] }

// 3. In TAB_PATHS:
rbac: "/rbac"

// 4. In iconForTab:
case "rbac": return "shield";
```

### Pattern 4: Sub-tab Switching Component

**What:** A parent shell with top tab bar that conditionally renders one of 4 child components [ASSUMED]
**When to use:** D-02 mandates 4 sub-tabs for the RBAC page
**Example:**
```typescript
// In rbac-page.ts:
type RbacSubTab = "roles" | "permissions" | "user-roles" | "instance-permissions";

const SUB_TABS: { key: RbacSubTab; label: string }[] = [
  { key: "roles", label: "角色管理" },
  { key: "permissions", label: "权限管理" },
  { key: "user-roles", label: "用户-角色绑定" },
  { key: "instance-permissions", label: "实例权限" },
];

// Render sub-tab bar:
html`
  <div class="sub-tabs">
    ${SUB_TABS.map(st => html`
      <button class="sub-tab ${st.key === this.activeSubTab ? 'sub-tab--active' : ''}"
              @click=${() => this.activeSubTab = st.key}>
        ${st.label}
      </button>
    `)}
  </div>
  ${this.activeSubTab === "roles" ? html`<role-management-tab></role-management-tab>` : ""}
  ${this.activeSubTab === "permissions" ? html`<permission-management-tab></permission-management-tab>` : ""}
  ...
`;
```

### Anti-Patterns to Avoid

- **Mixing sub-tab components in app-render.ts:** The RBAC page is a single page. Only the parent `rbac-page` component should handle sub-tab switching. `app-render.ts` should simply render `<rbac-page></rbac-page>` for `state.tab === "rbac"`.
- **Hardcoded instance list in checkbox modal:** The instance list must be fetched live from `/api/database/instances` (no authentication required on that endpoint) to ensure stale data is never shown.
- **Bulk API calls without error handling:** When saving permission changes (grant/revoke per checkbox), each action is an individual API call. If one fails, the code must handle partial success state gracefully.

## Common Pitfalls

### Pitfall 1: Stale Role/Permission Data After CRUD
**What goes wrong:** After creating/deleting a role or permission, the users-management.ts multi-role badges don't reflect the update.
**Why it happens:** The users page and RBAC page are independent components with separate data loading. Role data shown in badges (user_roles join) is fetched from `/api/users/:userId/roles`, which is always current.
**How to avoid:** Each sub-tab reloads its data on `connectedCallback()` and after every successful mutation. Use `firstUpdated()` to auto-load (same as llm-config.ts line 83).
**Warning signs:** `firstUpdated()` not called, `_loadRoles()` not called after save/delete.

### Pitfall 2: Navigation.ts Type Error
**What goes wrong:** TypeScript error when adding "rbac" to the `Tab` union type because `titleForTab()` calls `t(`tabs.${tab}`)` expecting a translation key.
**Why it happens:** The `Tab` type is used in `TAB_PATHS` and `titleForTab`. Adding a new tab requires at minimum a translation entry.
**How to avoid:** Add `"rbac"` string to the Tab union type, TAB_GROUPS settings array, and TAB_PATHS. The translation keys (`tabs.rbac`, `subtitles.rbac`) default gracefully if missing. [VERIFIED: navigation.ts pattern]
**Warning signs:** TypeScript compile error on `titleForTab(state.tab)`.

### Pitfall 3: Conflict Between Legacy Role Check and RBAC
**What goes wrong:** `users-management.ts` uses `getUserRole()` which reads the JWT token payload's `role` field to determine admin status. However, Phase 84 (CR-02 fix) removed `role` from the JWT payload and login response.
**Why it happens:** The current code at users-management.ts line 39-46 calls `getUserRole()` which does `payload.role` -- but `role` is no longer in the JWT after Phase 84.
**How to avoid:** The existing getUserRole() still works because Phase 84 preserved backward compatibility -- looking at the server.ts verifyToken function, the `(request as any).user = decoded` line preserves whatever the JWT contains. And at JWT generation (line 163), `role` was removed from the payload. This means `getUserRole()` will return `null`, making `this.isAdmin` always `false`, making the users page always show "无权限" for all users. This MUST be fixed before Phase 85 can work. The fix: replace `getUserRole()` with a call to check RBAC permissions, or include `isAdmin` from a dedicated endpoint.
**Warning signs:** getUserRole() returns null, admin users see "No permission" on the users page.
**Resolution:** Modify `users-management.ts` to check admin status via `/api/v1/rbac/roles` or a dedicated endpoint, rather than reading `payload.role` from JWT.

### Pitfall 4: Multi-role Badge Display After Migration
**What goes wrong:** The existing role badge shows a single role name mapped via `ROLE_LABELS`. After Phase 84, users can have multiple roles, so a single badge is insufficient.
**Why it happens:** Phase 84 removed the single `role` column and migrated to `user_roles` table. The users-management.ts still expects a single `role` string.
**How to avoid:** Create a new `getUserRoles(userId)` helper that calls `/api/v1/rbac/users/${userId}/roles` and displays multiple badges. Use color mapping from the existing `.role-badge` CSS classes (admin=red, dba=blue, developer=green, analyst=purple, viewer=gray, auditor=yellow).
**Warning signs:** User table still shows single role badge, or breakage because `u.role` is undefined.

## Code Examples

### Verified API Call Pattern

```typescript
// Source: users-management.ts lines 472-503, llm-config.ts lines 74-77
// Auth pattern used across ALL existing views
private _getToken(): string {
  return localStorage.getItem("token") || "";
}

private get _headers(): Record<string, string> {
  const t = this._getToken();
  return t ? {
    "Authorization": `Bearer ${t}`,
    "Content-Type": "application/json",
  } : { "Content-Type": "application/json" };
}

async _fetch(url: string, options?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { ...this._headers, ...options?.headers },
  });
}
```

### Role-Permission Batch Save Pattern (Role-permission edit modal)

```typescript
// Source: rbac-api.ts GET/POST /roles/:roleId/permissions, DELETE /roles/:roleId/permissions/:permissionId
// Strategy: load current permissions on modal open, show grouped checkboxes,
// diff on save, call grant for new, revoke for removed.

async _openPermissionEditModal(roleId: number) {
  const [allPerms, rolePerms] = await Promise.all([
    this._fetchJson("/api/v1/rbac/permissions"),
    this._fetchJson(`/api/v1/rbac/roles/${roleId}/permissions`),
  ]);
  this.allPermissions = allPerms;
  this.rolePermissionIds = new Set(rolePerms.map(p => p.id));
  this.showPermissionModal = true;
}

async _savePermissions(roleId: number) {
  // Diff: find granted and revoked
  const currentlyGranted = this.rolePermissionIdsSnapshot; // saved on modal open
  const newGranted = this.rolePermissionIds;
  const toGrant = [...newGranted].filter(id => !currentlyGranted.has(id));
  const toRevoke = [...currentlyGranted].filter(id => !newGranted.has(id));

  // Batch calls
  for (const permId of toGrant) {
    await this._fetch(`/api/v1/rbac/roles/${roleId}/permissions`, {
      method: "POST",
      body: JSON.stringify({ permissionId: permId }),
    });
  }
  for (const permId of toRevoke) {
    await this._fetch(`/api/v1/rbac/roles/${roleId}/permissions/${permId}`, {
      method: "DELETE",
    });
  }
}

// Group permissions by resource for accordion display:
private _groupByResource(permissions: Permission[]): Map<string, Permission[]> {
  const grouped = new Map<string, Permission[]>();
  for (const p of permissions) {
    const list = grouped.get(p.resource) || [];
    list.push(p);
    grouped.set(p.resource, list);
  }
  return grouped;
}
```

### User-Role Badge Click Navigation

```typescript
// users-management.ts: Multi-role badge display + click navigation
// Source: D-03

// In user table row, replace single role badge:
html`
  <td>
    ${user.roles.map(r => html`
      <span class="role-badge ${r.role_name}"
            @click=${() => this._navigateToRbacUserRoles(user.id)}
            style="cursor:pointer">
        ${ROLE_LABELS[r.role_name] || r.role_name}
      </span>
    `)}
    <button class="action-btn" @click=${() => this._openInstancePermModal(user)}>
      实例权限
    </button>
  </td>
`
```

### Instance Permission Checkbox Modal

```typescript
// Source: rbac-api.ts GET/POST/DELETE /users/:userId/instances + GET /api/database/instances
// Pattern: fetch all instances + user's granted instances, render checkbox list,
// save by diff (grant new, revoke removed)

async _loadInstancePerms(userId: number) {
  const [allInstances, grantedInstanceIds] = await Promise.all([
    this._fetchJson("/api/database/instances"),
    this._fetchJson(`/api/v1/rbac/users/${userId}/instances`),
  ]);
  this.allInstances = allInstances;
  this.grantedInstanceIds = new Set(grantedInstanceIds);
  this.savedGrantedInstanceIds = new Set(grantedInstanceIds);
  this.showInstancePermModal = true;
}

// On save:
async _saveInstancePerms(userId: number) {
  const toGrant = [...this.grantedInstanceIds].filter(
    id => !this.savedGrantedInstanceIds.has(id)
  );
  const toRevoke = [...this.savedGrantedInstanceIds].filter(
    id => !this.grantedInstanceIds.has(id)
  );
  // ... grant/revoke loops similar to role-permission pattern
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single ENUM role via `users.role` | Many-to-many via `user_roles` table | Phase 84 (2026-05-09) | Frontend must now load roles per user via `/api/v1/rbac/users/:id/roles` instead of reading `u.role` |
| JWT payload includes `role` field | JWT no longer has `role` | Phase 84 (CR-02 fix) | `getUserRole()` returns `null` -- users-management.ts must switch to RBAC API for admin check |
| Old `requireRole` middleware | `requirePermission` + `requireInstanceAccess` | Phase 84 | Frontend just needs to know 403 means "not authorized" -- error state pattern handles this |
| `/api/users` with single role field | `/api/users` (unchanged) + `/api/v1/rbac/users/:id/roles` (new) | Phase 84 | User fetch stays same; role data now from separate endpoint |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `getUserRole()` in users-management.ts will return `null` after Phase 84 because `role` is removed from JWT payload | Pitfalls - Pitfall 3 | The admin check fails and the user management page becomes inaccessible. Requires confirmation that Phase 84 actually removed `role` from JWT. |
| A2 | The instances list endpoint `GET /api/database/instances` requires no auth (`preHandler` not set for lines 275-278 in server.ts) | Instance Permissions Modal | If auth is added later, the instance modal will return 401/403. Confirmed by server.ts lines 275-278: `fastify.get('/api/database/instances'` has no `preHandler`. |
| A3 | The users list endpoint `GET /api/users` returns data in the format `{ users: UserInfo[] }` or `UserInfo[]` | User-Role Binding Tab | The API returns format must match what users-management.ts already uses. Verified: `this.users = Array.isArray(data) ? data : (data.users || [])`. |
| A4 | 4 sub-tab components in a single file (`rbac-page.ts`) is manageable | Recommended Structure | If all 4 are complex, the file could exceed 1500 lines. Mitigation: each sub-tab is a separate `@customElement` class but in the same file. Can be extracted to separate files later if needed without changing app-render.ts. |
| A5 | Navigation tab translation keys (`tabs.rbac`, `subtitles.rbac`) do not need to be added explicitly | Navigation Integration | Missing keys default gracefully. Chinese labels could be added to i18n if desired. |

## Open Questions (RESOLVED)

1. **How to determine if current user is admin (for the admin check buttons)?**
   - What we know: getUserRole() reads `payload.role` from JWT, which Phase 84 removed.
   - What's unclear: Is there an existing `/api/me` or similar endpoint that returns current user's permissions? Or should the UI check by attempting to call `/api/v1/rbac/roles` (which requires `admin:*` and returns 403 if not admin)?
   - Recommendation: Attempt to load roles list on page mount. If 403, show "no permission" message (same pattern as users-management.ts lines 487-492). This avoids needing a dedicated admin-check endpoint.

2. **Should users-management.ts load user roles from `/api/v1/rbac/users/:id/roles` or from the `/api/users` response?**
   - What we know: `/api/users` response format is `{ users: UserInfo[] }` with no role array. Roles are fetched separately via `/api/v1/rbac/users/:id/roles`.
   - What's unclear: Can `/api/users` be augmented to include role names? No -- the Phase 84 scope explicitly says `/api/users` endpoint is unchanged (D-05).
   - Recommendation: Load roles per user asynchronously in the user table. Use a batch approach: collect all user IDs, fetch roles for each (or use a new batch endpoint if one were available). Since the user count is small, sequential fetches are acceptable.

3. **What happens when the instances list is very large (100+)?**
   - What we know: The instance permissions modal shows a checkbox list of all instances.
   - What's unclear: Performance with many instances in a checkbox list.
   - Recommendation: Add search/filter within the modal (client-side filter by instance name). This addresses the display load issue and improves UX.

## Environment Availability

**Step 2.6: SKIPPED** (no external dependencies -- the frontend uses only existing project stack: Lit 3.3.2, TypeScript, Vite -- all already in `frontend/package.json`). The backend Phase 84 is complete and verified.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Playwright 1.59 |
| Config file | `frontend/playwright.config.ts` (assumed, based on package.json scripts) |
| Quick run command | `cd frontend && npx playwright test --grep "rbac"` |
| Full suite command | `cd frontend && npx playwright test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RBAC-09 | Admin can view roles table | smoke | `npx playwright test --grep "rbac-roles-list"` | ❌ Wave 0 |
| RBAC-09 | Admin can create/edit/delete roles | smoke | `npx playwright test --grep "rbac-roles-crud"` | ❌ Wave 0 |
| RBAC-09 | Admin can assign permissions to role | smoke | `npx playwright test --grep "rbac-permissions-assign"` | ❌ Wave 0 |
| RBAC-09 | Admin can bind users to roles | smoke | `npx playwright test --grep "rbac-user-roles"` | ❌ Wave 0 |
| RBAC-09 | Admin can grant instance access | smoke | `npx playwright test --grep "rbac-instance-perms"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** None (visual UI tests are not suitable for per-commit runs without integration test infrastructure)
- **Per wave merge:** Manual smoke test via browser
- **Phase gate:** Manual verification by navigating through all 4 sub-tabs and testing CRUD operations

### Wave 0 Gaps
- [ ] `frontend/tests/rbac.spec.ts` — smoke test for all 4 sub-tab CRUD operations (requires Playwright setup)
- Existing Playwright smoke tests exist at `frontend/smoke/` — check existing pattern for RBAC tests

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Backend middleware handles auth, frontend just shows 401/403 errors |
| V4 Access Control | No | Backend `requirePermission('admin:*')` enforces RBAC. Frontend does NOT make access decisions. |
| V5 Input Validation | Partial | Permission code format validation (`resource:action`) on frontend for UX, backend validates again |
| V6 Cryptography | No | No cryptographic operations in this phase |

### Known Threat Patterns for {stack}
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Frontend-only access control bypass | Elevation of Privilege | All RBAC endpoints on backend require `admin:*` permission. Frontend's "show/hide admin buttons" is purely cosmetic. A non-admin calling the API directly still gets 403. |
| XSS in role/permission names | Tampering | Existing `dompurify` dependency is already in `package.json`. Role/permission names displayed in tables should be treated as text content (Lit auto-escapes). |

## Sources

### Primary (HIGH confidence)
- [Phase 84 CONTEXT.md] - Backend API design, permission model, data structures
- [Phase 84 VERIFICATION.md] - Confirmed all 12 verification truths passed, 4 gaps closed
- [navigation.ts] - Tab registration pattern (Tab type, TAB_GROUPS, TAB_PATHS, iconForTab)
- [app-render.ts] - Page routing via switch(state.tab) with lazy loading
- [users-management.ts] - CRUD pattern: table, modal dialogs, admin check, API calls
- [llm-config.ts] - Alternative CRUD pattern: table, dialog overlay, state management
- [rbac-api.ts] - 18 endpoint definitions, request/response formats
- [rbac-service.ts] - 574 lines, 25 async methods, parameterized queries
- [server.ts] - Route registrations with verifyToken + requirePermission preHandlers

### Secondary (MEDIUM confidence)
- [npm registry] - Lit 3.3.2 verified as current version

### Tertiary (LOW confidence)
None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Lit 3.3.2 verified in frontend/package.json and npm registry
- Architecture: HIGH - All patterns verified against existing codebase (llm-config.ts, users-management.ts, navigation.ts, app-render.ts)
- Pitfalls: HIGH - Pitfall 1 and Pitfall 3 verified against Phase 84 changes (JWT role removal, user_roles table)
- Environment: HIGH - No new dependencies; Phase 84 backend complete and verified

**Research date:** 2026-05-10
**Valid until:** 2026-06-10 (30 days for stable Lit + established project patterns)
