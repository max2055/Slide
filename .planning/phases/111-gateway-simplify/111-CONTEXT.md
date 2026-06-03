# Phase 111: Gateway 简化 - Context

**Gathered:** 2026-05-26
**Status:** Ready for planning

## Phase Boundary

清理 DirectAdapter 模式下已失效的 Gateway RPC controller、view 和 slash command。纯删除和简化，不加新功能。

核心改动：
1. 删除 9 个完全失效的 controller（所有 RPC 方法都 throw），对应 view 改为占位页
2. 精简 3 个部分失效的 controller（保留 REST 可用方法，删 WS RPC 调用）
3. 删除 8 个已断掉的 slash command 注册
4. 隐藏失效功能对应的 UI 按钮和导航入口

## Implementation Decisions

### 完全失效的 Controller（9 个）

- **D-01:** 删除以下 controller 文件：`usage.ts`、`cron.ts`、`config.ts`、`skills.ts`、`exec-approvals.ts`、`models.ts`、`agent-files.ts`、`agent-identity.ts`、`agent-skills.ts`。这些文件中的所有 `client.request()` 调用在 DirectAdapter 模式下都会 throw。
- **D-02:** 对应的 view 文件改为占位页，显示「此功能暂不可用」。占位页保留导航入口，避免 sidebar 出现空白或 404。具体的 view 包括：`views/usage*.ts`、`views/cron.ts`、`views/config*.ts`、`views/skills*.ts`、`views/exec-approval.ts`、`views/agents-panels-*.ts`（tools/skills 面板）、`views/overview*.ts`（部分失效面板）。
- **D-03:** 占位页使用统一的 Lit 模板，接受功能名称参数，显示中文提示「DirectAdapter 模式下暂不支持此功能」。

### 部分失效的 Controller（3 个）

- **D-04:** `controllers/sessions.ts` — 保留 `loadSessions()`（REST `/api/sessions` 可用），删除 `patchSession()`、`deleteSessionsAndRefresh()` 及所有 compaction 方法（`sessions.patch`、`sessions.delete`、`sessions.compact.*` 均 throw）。session 列表页的编辑/删除按钮隐藏。
- **D-05:** `controllers/agents.ts` — 保留 `loadAgents()`（REST `/api/agents` 可用），删除 `loadToolsCatalog()` 和 `loadToolsEffective()`（`tools.catalog`、`tools.effective` 均 throw）。agent 详情页的 tools/skills 面板改用占位页。
- **D-06:** `controllers/chat.ts` — 保留 `sendChat()`（WS `chat.send`）和 `loadChatHistory()`（REST `chat.history`），删除 `abortChatRun()`（`chat.abort` throw）。/stop slash command 同步删除。

### Slash Command 清理（8 个）

- **D-07:** 从 `chat/slash-commands.ts` 和 `chat/slash-command-executor.ts` 中完全删除以下命令的注册和处理逻辑：`/model`、`/think`、`/fast`、`/verbose`、`/compact`、`/kill`、`/redirect`、`/stop`。
- **D-08:** `/agents` 和 `/usage` 保留（它们依赖的 `agents.list` 和 `sessions.list` REST API 可用）。`/steer` 保留基本功能。

### 不做的事

- **D-09:** `openclaw/protocol/` 目录（23 个 Gateway schema 文件）Phase 111 不动，留给 Phase 112 统一处理。
- **D-10:** Slide 业务 view（`views/dashboard.ts`、`views/alerts.ts`、`views/reports.ts`、`views/instances-db.ts` 等 11 个）保持不变——它们使用 Slide REST API，和 Gateway 无关。

### Claude's Discretion

- 占位页的具体 UI 样式和文案
- 失效方法删除时 import 清理的范围（是否连带删除不再使用的类型 import）
- 文件删除顺序（先删 controller 再更新 view 还是反过来）

## Canonical References

### 现有代码（Phase 111 改动目标）
- `frontend/src/openclaw/ui/controllers/usage.ts` — 4 个 RPC 方法，全部 throw（待删除）
- `frontend/src/openclaw/ui/controllers/cron.ts` — 8 个 RPC 方法，全部 throw（待删除）
- `frontend/src/openclaw/ui/controllers/config.ts` — 6 个 RPC 方法，全部 throw（待删除）
- `frontend/src/openclaw/ui/controllers/skills.ts` — 5 个 RPC 方法，全部 throw（待删除）
- `frontend/src/openclaw/ui/controllers/exec-approvals.ts` — 4 个 RPC 方法，全部 throw（待删除）
- `frontend/src/openclaw/ui/controllers/models.ts` — `models.list` throw（待删除）
- `frontend/src/openclaw/ui/controllers/agent-files.ts` — 3 个 RPC 方法，全部 throw（待删除）
- `frontend/src/openclaw/ui/controllers/agent-identity.ts` — `agent.identity.get` throw（待删除）
- `frontend/src/openclaw/ui/controllers/agent-skills.ts` — `skills.status` throw（待删除）
- `frontend/src/openclaw/ui/controllers/sessions.ts` — 保留 loadSessions，删其他（待精简）
- `frontend/src/openclaw/ui/controllers/agents.ts` — 保留 loadAgents，删 loadTools*（待精简）
- `frontend/src/openclaw/ui/controllers/chat.ts` — 保留 send/history，删 abort（待精简）
- `frontend/src/openclaw/ui/chat/slash-commands.ts` — 8 个命令待删除
- `frontend/src/openclaw/ui/chat/slash-command-executor.ts` — 对应 handler 待删除
- `frontend/src/openclaw/ui/direct-gateway.ts` — `request()` shim 中对应的显式 throw 方法可以简化（只保留 4 个可用的 + 通用 throw）

### 设计上下文
- `.planning/phases/110-directadapter-switch/110-CONTEXT.md` — DirectAdapter 切换决策，D-03 实时推送后续 phase 再看
- `.planning/phases/108-agent/108-CONTEXT.md` — IAgentEngine 接口契约
- `frontend/src/openclaw/ui/app-gateway.ts` — initChatClient（DirectGatewayClient 入口）

## Existing Code Insights

### Reusable Assets
- **DirectGatewayClient.request()**: 已实现 4 个可用方法（chat.send、chat.history、agents.list、sessions.list）+ 7 个显式 throw + 通用 throw。Phase 111 后只需保留 4 个可用方法 + 通用 throw。
- **Lit 组件模式**: 占位页可用简单的 Lit `html` 模板，参照现有 view 结构。

### Established Patterns
- **Controller 模式**: 每个 controller 导出 async 函数，接收 `client` 参数。删除 controller 时同步清理 `app-settings.ts` 中的 import 和调用。
- **Slash command 注册**: `slash-commands.ts` 中定义命令元数据，`slash-command-executor.ts` 中实现 handler。删除时两处都要清理。
- **Navigation 定义**: sidebar/routing 在 `app.ts` 和 `app-render.ts` 中，占位页需保留路由入口。

### Integration Points
- `app-settings.ts` → 各 controller 的 import 和调用（需要清理死 import）
- `app.ts` → slash command 路由（`onSlashAction` switch case）
- `app-render.ts` → view 标签页渲染（需要为占位页更新渲染逻辑）
- `direct-gateway.ts` → `request()` shim（可以删除不再使用的显式 throw 分支）

## Deferred Ideas

- `openclaw/protocol/` 目录清理 — Phase 112
- `openclaw/` → `app/` 重命名 — Phase 112
- Slide 业务 view 移出 `openclaw/ui/views/` — Phase 112
- 为删掉的 Gateway 功能实现 REST API 替代 — 后续 milestone

---

*Phase: 111-gateway-simplify*
*Context gathered: 2026-05-26*
