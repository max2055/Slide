# Phase 85: RBAC Frontend - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-09
**Phase:** 85-rbac-frontend
**Areas discussed:** Page Structure, Permission Editing, Instance Access, RBAC Layout, Permission UI, Instance Access UX, User-Role Binding, Permission Codes

---

## Page Structure & Navigation

| Option | Description | Selected |
|--------|-------------|----------|
| 新增独立 rbac Tab | settings 组新增 "rbac" Tab，含角色/权限/用户-角色/实例权限 4 个子区域。现有 users 页面保留但 role 列更新为多角色 badges | ✓ |
| 集成到 users Tab | 扩展现有 users 页面包含所有 RBAC 管理功能 | |
| 混合方案 | RBAC 独立 Tab + users Tab 内更新角色列展示 | |

**User's choice:** 新增独立 rbac Tab
**Notes:** users Tab 保留用户 CRUD，role 列改为多角色 badges 展示并可点击跳转

---

## RBAC Page Internal Layout

| Option | Description | Selected |
|--------|-------------|----------|
| 顶部 tab 切换（4 个子页） | 角色管理 / 权限管理 / 用户-角色绑定 / 实例权限 四个 tab 切换 | ✓ |
| 卡片分区（一页全展示） | 2-3 个卡片分区上下排列，一页看全 | |
| 左侧导航+右侧详情（两栏布局） | 文件管理器风格，角色列表树 + 详情面板 | |

**User's choice:** 顶部 tab 切换
**Notes:** 4 个 sub-tab 各含独立表格和操作

---

## Permission Editing UX

| Option | Description | Selected |
|--------|-------------|----------|
| 分组的 checkbox 列表 | 按 resource 分组展示所有权限码，勾选/取消勾选分配权限 | ✓ |
| 搜索 + 标签式添加 | 搜索框过滤 + tag/badge 展示已选权限 | |
| 双面板穿梭框 | 左侧可用权限 + 右侧已分配，拖拽或按钮移动 | |

**User's choice:** 分组的 checkbox 列表
**Notes:** 按 instance/alert/user/sql/notification/collector/ai/system 等 resource 分组

---

## Permission Editing Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Modal 弹窗编辑 | 点击"编辑权限"弹出 modal，内部 checkbox 分组列表 | ✓ |
| 行内展开面板 | 表格行下方展开编辑面板 | |
| 角色详情页 | 侧边栏角色列表 + 主区域权限编辑 | |

**User's choice:** Modal 弹窗编辑
**Notes:** 类似 llm-config 的 API Key 弹窗模式

---

## Instance Access UX

| Option | Description | Selected |
|--------|-------------|----------|
| 在用户详情中管理 | 以用户为中心管理实例权限 | ✓ |
| 在实例详情中管理 | 以实例为中心管理用户访问 | |
| 两者都需要 | 用户-实例矩阵视图 + 实例详情授权列表 | |

**User's choice:** 在用户详情中管理
**Notes:** 用户中心视图

---

## Instance Access Placement

| Option | Description | Selected |
|--------|-------------|----------|
| 独立的实例权限 Modal | 用户表格每行"实例权限"按钮 → 独立弹窗 | ✓ |
| 整合到用户编辑弹窗 | 实例权限区域整合到用户编辑 Modal 中 | |
| 矩阵视图 + 快捷入口 | RBAC 页面内用户-实例矩阵表格 | |

**User's choice:** 独立的实例权限 Modal
**Notes:** 弹窗内显示实例 checkbox 列表，已授权实例勾选，保存时调用 API

---

## User-Role Binding UX

| Option | Description | Selected |
|--------|-------------|----------|
| 用户列表 + 角色详情面板 | 左侧用户列表，右侧显示选中用户当前角色 badges + dropdown 添加 | ✓ |
| 表格 + 角色编辑 Modal | 表格每行"编辑角色"弹出 modal | |
| 角色中心视图 | 角色列表 + 拥有该角色的用户列表 | |

**User's choice:** 用户列表 + 角色详情面板
**Notes:** 添加通过 dropdown 选择，移除通过 badge × 按钮

---

## Permission Code Management

| Option | Description | Selected |
|--------|-------------|----------|
| 只读浏览 | 分组展示权限码列表，不提供创建/删除 | |
| 完整 CRUD 管理 | 列表 + 创建 + 删除，动态管理权限码 | ✓ |
| 只读 + 可折叠高级区 | 日常只读，创建操作折叠隐藏 | |

**User's choice:** 完整 CRUD 管理
**Notes:** 创建时校验 code 格式（resource:action），删除时带确认对话框

---

## Claude's Discretion

- Sub-tab 组件拆分方式（独立组件 vs 单组件 switch）
- API 调用封装（inline fetch vs 共享 api/rbac.ts）
- Loading/empty/error 状态处理
- 响应式行为
- 角色 badge 点击跳转实现

## Deferred Ideas

None — discussion stayed within phase scope.
