# Phase 87: Approval Enhancement - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-11
**Phase:** 87-approval-enhancement
**Areas discussed:** Detail Page, Batch Operations, Auto-Execute, Notification Integration

---

## Detail Page

### Entry Pattern

| Option | Description | Selected |
|--------|-------------|----------|
| 独立路由 /approval/:id | 新路由+新 Tab 注册 | |
| 组件内子视图 | 同组件切换列表/详情，不注册路由 | ✓ |
| Modal 弹窗 | 弹窗覆盖层详情 | |

**User's choice:** 组件内子视图切换

### Timeline Events

| Option | Description | Selected |
|--------|-------------|----------|
| 完整时间线 | 提交→AI评估→审批决策→执行结果→通知发送 | ✓ |
| 精简时间线 | 提交→审批决策→执行结果 | |

**User's choice:** 完整时间线

### Layout

| Option | Description | Selected |
|--------|-------------|----------|
| 纵向布局 | 元信息→SQL→时间线 | |
| 左右分栏 | 左SQL+右元信息/时间线 | ✓ |

**User's choice:** 左右分栏布局，参考 Yearning/Archery 风格

---

## Batch Operations

### Interaction Pattern

| Option | Description | Selected |
|--------|-------------|----------|
| 批量按钮 + 确认对话框 | 选中→点击操作按钮→弹窗输入备注→确认 | ✓ |
| 批量按钮 + 内嵌备注 | 选中→顶部操作栏带备注框→一步完成 | |

**User's choice:** 批量按钮 + 确认对话框

### Visibility Rule

| Option | Description | Selected |
|--------|-------------|----------|
| 自动显隐 | 勾选显示，全取消隐藏 | ✓ |
| 始终显示 | 按钮始终可见，未选中时 disabled | |

**User's choice:** 自动显隐

### Operation Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| 统一操作 | 同批全通过/全驳回，自动过滤非pending | ✓ |
| 统一操作 + 过滤 | 混选后仅对pending项生效 | |

**User's choice:** 统一操作（全通过/全驳回）

---

## Auto-Execute on Approve

### Default State

| Option | Description | Selected |
|--------|-------------|----------|
| opt-in（默认不勾选） | 审批人主动勾选才执行 | |
| opt-out（默认勾选） | 默认执行，审批人可取消 | ✓ |

**User's choice:** 默认勾选（opt-out）

### Result Display

| Option | Description | Selected |
|--------|-------------|----------|
| 仅详情页时间线 | 时间线中作为事件节点 | |
| 详情页 + 列表页 | 双展示：时间线节点 + 列表摘要 | ✓ |

**User's choice:** 详情页 + 列表页都展示

### Batch Result Display

| Option | Description | Selected |
|--------|-------------|----------|
| 列表详情中内联展示 | 每个请求独立展示结果 | ✓ |
| 时间线节点展示 | 每个请求的时间线节点 | |

**User's choice:** 在列表详情中内联展示

---

## Notification Integration

### Integration Approach

| Option | Description | Selected |
|--------|-------------|----------|
| 新增 buildApprovalMessage + 复用发送 | 扩展现有 notificationService | ✓ |
| 独立实现 | 审批通知完全独立 | |

**User's choice:** 新增 buildApprovalMessage() + 复用 send()/sendWithRetry()

### Channel Source

| Option | Description | Selected |
|--------|-------------|----------|
| 提交人个人渠道配置 | users 表新增 notification_config | |
| 系统级通知渠道 | getEnabledChannels() 统一渠道 | ✓ |

**User's choice:** 使用系统级通知渠道

### Notification Triggers

| Option | Description | Selected |
|--------|-------------|----------|
| 仅驳回通知 | 通过的去页面看 | |
| 通过和驳回都通知 | 所有审批结果都发通知 | ✓ |

**User's choice:** 通过和驳回都通知

---

## Claude's Discretion

- 审批历史时间线数据源（新表 vs 推导）
- buildApprovalMessage() 各渠道消息格式
- 批量操作后端 API 设计
- 详情页 CodeMirror 配置细节
- 时间线组件实现方式
- 已处理列表执行结果展示样式

## Deferred Ideas

None — discussion stayed within phase scope.
