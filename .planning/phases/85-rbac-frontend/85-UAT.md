---
status: complete
phase: 85-rbac-frontend
source: 85-01-SUMMARY.md, 85-02-SUMMARY.md
started: 2026-05-12T00:00:00Z
updated: 2026-05-12T07:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. RBAC 页面入口 — 设置侧边栏"权限管理"
expected: 点击「设置」→「权限管理」(shield 图标)，页面加载成功。顶部显示 2 个 sub-tab：角色管理、权限管理。不应出现"用户角色绑定"和"实例权限"tab。
result: pass

### 2. 角色管理 — CRUD 操作
expected: 角色列表展示所有角色（名称、描述、权限数、用户数）。可新建/编辑/删除角色。点击「编辑权限」弹出 checkbox 列表，按 resource 分组。
result: pass
fixed: "listRoles SQL 添加 COUNT 子查询"

### 3. 权限管理 — CRUD 操作
expected: 权限列表展示所有权限码（code, name, resource, action, description）。新建权限校验 resource:action 格式。删除带确认。
result: pass

### 4. 用户管理页 — 多角色 badge
expected: 用户列表每行显示多个角色 badge（不是单个）。admin 用户应显示 "admin" badge。角色 badge 可点击，跳转到 RBAC 页面。
result: pass

### 5. 用户管理页 — 实例权限 modal
expected: 每行「实例权限」按钮打开 modal。Modal 显示实例 checkbox 列表（带搜索过滤）。勾选/取消勾选后保存，调用 grant/revoke API。
result: pass

### 6. Dead code 清理验证
expected: 角色 badge 点击跳转到 RBAC "权限管理"页面（不是"用户角色绑定"tab）。无 `_rbacTargetUserId` dead store。无 `navigate-to-rbac` 事件绑定到不存在的 tab。
result: pass

## Summary

total: 6
passed: 5
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "角色管理 tab 中角色列表展示正确的权限数和用户数"
  status: failed
  reason: "User reported: 所有角色的权限和用户数都是0"
  severity: minor
  test: 2
  root_cause: "GET /api/v1/rbac/roles only returns id/name/description/is_system/created_at — no permission_count or user_count aggregation"
  artifacts:
    - path: "apps/db-ops-api/src/auth/rbac-api.ts"
      issue: "listRoles route handler calls rbacService.listRoles() which does plain SELECT — needs COUNT subqueries"
    - path: "apps/db-ops-api/src/auth/rbac-service.ts"
      issue: "listRoles method at ~line 54 has no permission_count or user_count computation"
  missing:
    - "Add COUNT subquery for role_permissions to listRoles SQL"
    - "Add COUNT subquery for user_roles to listRoles SQL"
    - "Or: make frontend fetch counts separately and hide columns if unavailable"
