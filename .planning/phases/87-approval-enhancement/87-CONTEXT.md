# Phase 87: Approval Enhancement - Context

**Gathered:** 2026-05-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Enhance the existing SQL approval workflow from a flat approve/reject list into a full-featured approval system. Deliver a detail view with syntax-highlighted SQL and history timeline, batch approve/reject operations, optional auto-execute on approve, and notification integration via existing channels.

Requirements: APPR-01 through APPR-06.
</domain>

<decisions>
## Implementation Decisions

### Detail Page
- **D-01:** 组件内子视图切换 — approval-dashboard 组件内部管理 列表/详情 两个子视图，不注册独立路由，不修改 navigation.ts
- **D-02:** 完整审批历史时间线，包含所有事件节点：提交审批 → AI 风险评估 → 审批通过/驳回 → SQL 自动执行结果 → 通知发送
- **D-03:** 左右分栏布局 — 左侧 CodeMirror 6 只读编辑器（SQL 语法高亮，复用 sql-console.ts 的 CodeMirror 配置），右侧展示元信息（实例名、提交人、提交时间、风险等级、当前状态）+ 时间线

### Batch Operations
- **D-04:** 待审批列表每行左侧 checkbox 多选，顶部操作栏自动显隐（勾选任意项后显示，全部取消后隐藏）
- **D-05:** 点击操作栏「通过 (N)」或「驳回 (N)」→ 弹出确认对话框，输入统一备注后提交
- **D-06:** 统一操作 — 同一批次只能全通过或全驳回，选中项中自动过滤非 pending 状态的请求

### Auto-Execute on Approve
- **D-07:** 待审批列表每行「审批后执行」checkbox，默认勾选（opt-out）— 审批人主动取消不执行的项
- **D-08:** 后端 reviewRequest 接受 `execute_after_approve: boolean` 参数，替代现有审批即执行的硬编码行为。驳回不受此参数影响
- **D-09:** 执行结果双展示 — 详情页时间线中作为"自动执行"事件节点 + 已处理列表页中展示执行耗时和行数摘要
- **D-10:** 批量通过时每个勾选了自动执行的请求独立展示执行结果，内联在对应列表项中

### Notification Integration
- **D-11:** 在 notificationService 中新增 `buildApprovalMessage()` 方法（按渠道生成审批通知消息格式），复用现有 `send()` / `sendWithRetry()` / `buildSignedUrl()` 基础设施
- **D-12:** 使用系统级通知渠道（`getEnabledChannels()`），不做提交人个人渠道配置
- **D-13:** 通过和驳回都发送通知，消息包含：审批结果、审批人备注、SQL 摘要（前 100 字符）、实例名、提交时间

### Claude's Discretion
- 审批历史时间线数据源 — 新 audit 表记录事件 vs 使用现有 approval_requests 表的 status 变更推导
- `buildApprovalMessage()` 各渠道消息格式（dingtalk/wecom/feishu/webhook）
- 批量操作后端 API 设计 — 新增 `/api/approval/batch-review` endpoint vs 前端循环调用单个 review
- 详情页左侧 CodeMirror 配置细节（language mode 根据实例类型切换 MySQL/PostgreSQL、readOnly、theme）
- 时间线组件的具体实现方式（纯 CSS / 自定义 Lit 组件 / 第三方）
- 列表页"已处理"Tab 中执行结果的展示样式
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Planning
- `.planning/ROADMAP.md` — Phase 87 goal, success criteria (5 items), and APPR-01 through APPR-06 requirements
- `.planning/REQUIREMENTS.md` — APPR-01 through APPR-06 detailed requirement descriptions

### Existing Backend — Approval
- `apps/db-ops-api/src/approval-service.ts` — Current ApprovalService: submitForApproval, reviewRequest (always auto-executes on approve), getPendingRequests, getProcessedRequests, getRequestById
- `apps/db-ops-api/server.ts` lines 607–670 — 5 approval endpoints: POST /api/approval/submit, POST /api/approval/:id/review, GET /api/approval/pending, GET /api/approval/history, GET /api/approval/:id
- `apps/db-ops-api/src/notification-service.ts` — NotificationService with send(), sendWithRetry(), buildMessage() per channel type, sendEscalationNotification()

### Existing Frontend — Approval
- `frontend/src/openclaw/ui/views/approval-dashboard.ts` — Current approval list (pending/processed tabs, inline approve/reject, SQL preview truncated at 80px). All new features extend or restructure this component.

### Frontend Patterns Reference
- `frontend/src/openclaw/ui/views/sql-console.ts` — CodeMirror 6 EditorView setup pattern (SQL autocomplete, oneDark theme, readOnly config). Reuse for detail page read-only SQL editor.
- `frontend/src/openclaw/ui/navigation.ts` — Tab type definitions and TAB_GROUPS. Detail page does NOT modify this (component-internal sub-view).
- `frontend/src/openclaw/ui/app-render.ts` — Route dispatch. Detail page does NOT modify this.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **CodeMirror 6** (`sql-console.ts` lines 3–8): Already configured with `sql({ dialect: MySQL })`, `oneDark`, `basicSetup`. Detail page creates a single read-only EditorView with `EditorView.editable.of(false)`.
- **NotificationService** (`notification-service.ts`): `send()`, `sendWithRetry()`, `buildSignedUrl()` — all reusable for approval notifications. `buildMessage()` per channel type provides the template pattern for `buildApprovalMessage()`.
- **CSS variable system**: `--card`, `--border`, `--bg-elevated`, `--accent`, `--muted`, `--text`, `--ok`, `--ok-subtle`, `--destructive`, `--danger-subtle`, `--warn`, `--warn-subtle` — all defined and used throughout.

### Established Patterns
- `@customElement("approval-dashboard")` + `LitElement` + `@state()` decorators
- `static override styles = css\`...\`` component-scoped styles
- `fetch()` + `localStorage.getItem("token")` for API calls with `_headers()` helper
- Badge system (`badge-high`, `badge-medium`, `badge-low`, `badge-critical`) for risk levels
- Modal dialog pattern (`.dialog-overlay` + `.dialog`) from `llm-config.ts` / `users-management.ts`

### Integration Points
- **Backend**: Approval endpoints at `/api/approval/*` already RBAC-guarded with `requirePermission('approval:approve')` / `requirePermission('approval:view')`. Batch review needs a new endpoint or loop.
- **Navigation**: No changes needed — detail page is component-internal sub-view
- **Notification**: `notificationService.send()` is the integration point for approval messages. New `buildApprovalMessage()` method needed.
- **Review request**: `/api/approval/:id/review` needs an `execute_after_approve` parameter added to the request body. Current behavior (always execute) must be preserved as default.

### Creative Options
- Approval history timeline can be derived from existing `approval_requests` fields (status + timestamps) or a dedicated `approval_events` table
- Batch review can be a single backend endpoint (`POST /api/approval/batch-review`) for atomicity, or frontend loop with progress indicator
- CodeMirror language mode can dynamically switch between MySQL and PostgreSQL based on instance type
</code_context>

<specifics>
## Specific Ideas

- 详情页左右分栏参考 SQL 审核工具（如 Yearning/Archery）的布局风格
- 时间线展示完整事件链路，让审批人能追溯整个审批过程
- 批量操作借鉴邮箱/GitHub PR 的多选+批量操作模式

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

### Reviewed Todos (not folded)
- **自动 AI 分析结果在告警列表中不可见** — AI/alert area, not relevant to approval scope. Score: 0.3
- **定时任务改为可配置** — Backend infrastructure, not relevant to approval scope. Score: 0.2

</deferred>

---
*Phase: 87-approval-enhancement*
*Context gathered: 2026-05-11*
