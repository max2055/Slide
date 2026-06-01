# Phase 93: AI Agent Ops Assistant - Context

**Gathered:** 2026-05-14
**Status:** Ready for planning

## Phase Boundary

增强 Chat AI 的数据库运维感知能力。用户在 Chat 中可以询问实例状态、告警、慢查询等运维问题，AI Agent 通过 on-demand tools 自主查询并回答。不碰 OpenClaw Gateway 原生流程，在 agent-service.ts 层做薄封装。

Scope 收窄：运维事件通知不在本 Phase 范围（复用现有通知渠道）。
新增：AI 分析配置管理——在 Settings 导航组新增"AI 设置"页，统一管理各类 AI 功能的自动触发开关（告警 RCA、事件聚合 RCA 等），可实时保存，即时生效。

## Implementation Decisions

### Ops Context Injection
- **D-01:** On-demand tools only — Agent 不预加载运维上下文，需要时调用 tools 查询。实时数据，实现最简。
- **D-02:** LLM-based intent classification — 用户消息先经轻量 LLM 分类，匹配对应 system prompt（alert_rca/topsql_analysis/通用 chat）。
- **D-03:** 新增轻量便捷查询工具（如 list_active_alerts、get_instance_summary），独立注册到 toolCatalog。Chat Agent 同时可调用现有 db_* 工具。
- **D-04:** 新会话时 Agent 主动问候 + 提示能力范围（查实例、查告警、查慢查询、跑诊断），不自动拉数据。
- **D-05:** 工具调用失败直接告知用户（超时/权限/不可用），不做优雅降级掩盖。
- **D-06:** 工具调用展示遵循 OpenClaw 原生机制，不做定制改动。

### Ops Event Notification
- **D-07:** 不在 Phase 93 范围。运维事件通过现有通知渠道（钉钉/企微/飞书/Webhook）推送，Chat 不做通知接入。

### Data Scope & RBAC
- **D-08:** Agent 继承用户 RBAC — 工具调用以当前用户身份执行，只能看到该用户有权限的数据。审计由现有操作日志覆盖。

### AI Analysis Settings
- **D-11:** 在 Settings 导航组新增 `ai-settings` Tab，统一管理 AI 分析配置
- **D-12:** 页面复用现有 `GET/PUT /api/ai/config` API（已支持部分更新）
- **D-13:** 首版包含：总开关、告警 RCA 级别/实例/时间窗；后续按分析类型扩展 per-type toggle
- **D-14:** 配置实时生效——保存后 cron 和事件聚合器立即读取最新配置
- **D-15:** 配置存储于 MySQL `system_config` 表，`aiAnalysisConfigService` 管理

### Architecture Approach
- **D-09:** 最薄方案 — 在 agent-service.ts 中增强 system prompt 注入逻辑。用户消息 → intent 分类 → 匹配 prompt → Gateway chat.send。Gateway 原生流程不改动。
- **D-10:** 便捷查询工具独立注册到 toolCatalog，与现有 db_* 工具并行。

### Claude's Discretion
- Intent 分类的 prompt 设计和 LLM 模型选择
- 便捷查询工具的具体字段和返回格式
- Agent greeting 消息文案
- 各 intent 对应的 prompt 模板内容
- agent-service.ts 中具体扩展点和方法签名

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & Roadmap
- `.planning/REQUIREMENTS.md` §AI-02 — Chat AI 运维助手的验收标准
- `.planning/ROADMAP.md` §Phase 93 — 阶段目标与成功标准

### Backend — AI/Gateway Integration
- `apps/db-ops-api/src/ai-agent-bridge.ts` — 统一 AI 分析入口，dispatchOrReuse() 模式参考
- `apps/db-ops-api/src/agent-service.ts` — 当前 Agent 服务，本 Phase 改动入口
- `apps/db-ops-api/src/gateway/chat-methods.ts` — chat.send/chat.history Gateway 方法
- `apps/db-ops-api/src/gateway/gateway-client.ts` — WebSocket Gateway 客户端，sendGatewayChat()

### Frontend — Chat UI
- `frontend/src/openclaw/ui/views/chat.ts` — Chat 页面组件，消息渲染和工具卡片展示

### Frontend — Navigation & Settings
- `frontend/src/openclaw/ui/navigation.ts` — Tab 类型定义和 TAB_GROUPS
- `frontend/src/openclaw/ui/app-render.ts` — 页面路由和渲染分发
- `frontend/src/openclaw/ui/views/alerts.ts:1535` — 现有配置面板参考（`_renderConfigPanel`）
- `frontend/src/openclaw/ui/views/ai-settings.ts` — **新建** AI 配置页面

### Backend — AI Analysis Config
- `apps/db-ops-api/src/ai-analysis-config-service.ts` — 配置 CRUD（已支持部分更新）
- `apps/db-ops-api/src/event-aggregator.ts:103` — 事件聚合 RCA 触发点（已接入 config guard）
- `apps/db-ops-api/server.ts:3144` — 告警 RCA cron 触发点（已接入 config guard）

### Prior Phase Context
- `.planning/phases/92-ai-analysis-visibility/92-CONTEXT.md` — AI 分析基础设施和 slide_complete_analysis 工具
- `.planning/phases/91-ui-standardization/91-CONTEXT.md` — CSS 变量和 UI 风格统一

## Existing Code Insights

### Reusable Assets
- **`ai-agent-bridge.ts` dispatchOrReuse()**: 本 Phase 可仿照其模式创建 chat 版本的 dispatch 逻辑
- **`gateway-client.ts` sendGatewayChat()**: 直接复用，Chat 消息通过 Gateway 派发
- **`toolCatalog`**: Phase 92 已注册 complete_analysis 工具，新工具按相同模式注册
- **`chat.ts` Chat UI**: 已有完整的消息流、工具卡片、streaming 渲染

### Established Patterns
- **ai-agent-bridge 模式**: dispatch → Gateway → Agent → tools → stream back
- **toolCatalog.register()**: 模块级注册，server.ts 中 import 即生效
- **RBAC 中间件**: requireRole 已在所有 API 路由中使用，tools 需同步接入

### Integration Points
- **agent-service.ts**: 本 Phase 主改动点，新增 intentClassifier + getOpsSystemPrompt
- **Gateway chat.send**: 不改动，仍作为 Agent 派发入口
- **toolCatalog**: 注册新便捷查询工具

## Specific Ideas

- 用户倾向最简路径：不建新服务、不改 Gateway、不预加载数据
- 轻量便捷工具（list_active_alerts 等）可以返回摘要级数据，避免重型查询
- Intent 分类模型可以用最便宜的 LLM（如 Haiku / Ollama）节省成本

## Tech Debt: Chat State Management Upstream Port

Slide frontend 的 chat state 管理基于 OpenClaw v2026.4.14，落后上游（v2026.4.16+）约两个月。上游已重构以下机制：

### 需 Port 的关键差异

| 文件 | 差异 | 影响 |
|------|------|------|
| `controllers/chat.ts` | 缺 `reconcileChatRunLifecycle`、双路 run-id 事件匹配 | 加载动画缺失 |
| `app-chat.ts` | 缺 `onSlashAction("new-session")`、`withChatSubmitGuard` | 新会话闪烁 |
| `views/chat.ts` | 缺 `sanitizeStreamText`、`stripHeartbeatTokenForDisplay` | stream 文本处理不完整 |
| `app-gateway.ts` | 缺 `activeRunIdBeforeEvent`、deferred session reload | 终端事件处理不完整 |

### 根因

1. **加载动画缺失** — Slide 的 `handleChatEvent` 只按 `sessionKey` 匹配事件。Gateway 返回新 session 的 delta 时，前端因 sessionKey 变而丢弃。Reference 按 `sessionKey` **或** `activeRunId` 双路匹配，确保同一 run 的事件持续渲染。

2. **新会话闪烁** — Slide 把 `/new` 当普通消息发 Gateway，等回应才切 sessionKey。Reference 直接调 `onSlashAction("new-session")` 立即本地切，且显式排除 `/new` 不排队。

### Port 策略

此改动涉及 chat state management 核心，建议作为 Phase 93 一个独立 plan，逐文件 port 而非一次大 merge，优先搬：
1. `handleChatEvent` 双路 run-id 匹配（修复加载动画）
2. `/new` 本地化处理（修复新会话闪烁）
3. `reconcileChatRunLifecycle` 辅助函数（支撑 1&2）

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: 93-ai-agent-ops-assistant*
*Context gathered: 2026-05-14*
