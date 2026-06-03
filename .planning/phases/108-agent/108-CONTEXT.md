---
phase: 108
created: 2026-05-25
updated: 2026-05-25
---

# Phase 108: Agent 抽象层 — Context

**Gathered:** 2026-05-25
**Status:** Ready for planning

## Phase Boundary

定义 `IAgentEngine` 接口 + 构建 Slide 自己的 TypeScript Agent 引擎（`@slide/agent-core`），将平台代码与 Agent 引擎解耦。

**核心策略：学习 nanobot 的成熟机制设计，用 TypeScript 独立实现 Slide 自己的引擎。** 不是直接用 nanobot，也不是直接用 OpenClaw——是吸收两者设计精华后自研。

Agent 层有三个适配器，默认使用自研引擎：

```
IAgentEngine
├── DirectAdapter (默认)  ← agent-core 引擎，TypeScript 同进程，零额外依赖
├── OpenClawAdapter       ← 保留兼容，原 OpenClaw 代码移入适配器内部
└── nanobotAdapter       ← Phase 109，HTTP 调 Python 进程（可选备选）
```

**注意：三个适配器不是等价的替代品。** nanobot 适配器存在三个裂隙（systemPrompt 注入、会话历史冲突、工具注册无标准路径）。`capabilities()` 方法让平台代码查询适配器能力并做降级处理。详见 `02-设计/202605251600-Agent 架构分析与设计方案.md` 第 6 节。

**ROADMAP success criteria 调整：** 原 4 项能力（chat.send、工具注册/调用、会话管理、定时触发）中，会话和定时触发是平台基础设施，不属于 Agent 接口职责。接口覆盖：
- **chat.send** — 流式对话（`.chat()`）+ fire-and-forget 任务派发（`.invoke()`）
- **工具注册/调用** — 统一的工具生命周期管理

## Implementation Decisions

### IAgentEngine 接口设计

- **D-01:** 接口定义两个执行方法：`.chat(sessionKey, message, onEvent)` 用于交互式流式对话，`.invoke(sessionKey, message, systemPrompt?)` 用于 fire-and-forget 工具任务（AI 分析场景）。
- **D-02:** 统一流式事件格式。接口定义 `ChatEvent` 类型：`text_delta | tool_start | tool_result | tool_error | complete | error`。适配器负责将其内部事件映射到标准格式。
- **D-03:** 接口提供 `listTools(): ToolSchema[]` 和 `capabilities(): AgentCapabilities` 方法。`capabilities()` 让平台查询适配器支持什么（streaming, toolCalling, maxContextTokens, supportsCustomSystemPrompt），用于降级处理。
- **D-04:** 错误处理使用标准 `Error` 抛出（不用结构化错误码或 Result 模式）。调用方 try/catch。
- **D-05:** 接口设计考虑 nanobot（Phase 109）的已知差异——接口方法签名足够通用，不假设底层传输方式（WebSocket/HTTP/进程内）。

### Agent 引擎：@slide/agent-core

- **D-06:** 从 nanobot 移植成熟的 AgentRunner + ToolRegistry 设计到 TypeScript，作为 Slide 的默认 Agent 引擎。已完成 `packages/agent-core/`（1523 行 TS，编译通过）。
- **D-07:** 引擎包含从 nanobot 移植的 6 个关键机制：并行工具执行、中途消息注入、中断恢复（checkpoint）、上下文预算管理（microcompact + snip）、超时分层、结构化追踪。
- **D-08:** agent-core 是独立可复用包（`@slide/agent-core`），不耦合 Slide 业务逻辑。后续项目可 `npm install` 直接使用。

### 工具系统

- **D-09:** 工具 schema（name, description, parameters）由平台定义在 `tools/catalog.ts`，handler 一并注册。catalog.ts 是工具定义的唯一入口。
- **D-10:** 统一 `ToolHandler` 签名：`(params: Record<string, unknown>) => Promise<unknown>`。闭包注入服务实例（与当前模式一致）。
- **D-11:** Slide 数据库工具（db_health_check、db_slow_queries 等）是平台资产，走 catalog.ts → adapter.registerTool()。pi-agent 基础工具（bash, read, write, edit, grep, find, ls）归 OpenClaw 适配器内部注册——它们不是通用平台工具，不应出现在 DirectAdapter 或 nanobot 适配器中。
- **D-12:** OpenClaw 原生工具（createOpenClawTools 产出的插件/技能工具）由 OpenClaw 适配器内部加载作为补充，平台不感知。
- **D-13:** 工具启动时一次性注册，不支持运行时动态注册/卸载。
- **D-14:** agent-service.ts 中 `ALL_TOOL_DEFINITIONS` 的工具定义迁移到 catalog.ts。agent-service.ts 保留 `getAgentGreeting()`（被 server.ts 使用），其余 handleAgentRequest/classifyIntent 等死代码删除。

### IAgentEngine 实例获取

- **D-15:** 使用 factory 函数模式：`getAgentEngine(): IAgentEngine`。模块级单例，懒初始化。和当前 `getOpenClawRuntime()` 模式一致。
- **D-16:** 适配器配置通过构造函数注入：`new DirectAdapter({ tools, llmProvider })`。不用环境变量或配置文件。

### 适配器隔离深度

- **D-17:** **零 OpenClaw import 在平台代码中。** 平台代码（server.ts, chat-methods.ts, ai-agent-bridge.ts 等）不出现任何 `openclaw` 或 `../../src/`（OpenClaw 源码）的 import。
- **D-18:** 所有 OpenClaw 相关文件统一放在 `apps/db-ops-api/src/adapter/openclaw/` 单一目录。删除该目录即可移除 OpenClaw 依赖。
- **D-19:** `gateway/server.ts`（~500行，WebSocket + auth + RPC 分发）移入适配器。平台不再 import `startGatewayServer`，改为 `adapter.start()`。
- **D-20:** `gateway-client.ts`（sendGatewayChat）移入适配器。ai-agent-bridge.ts 改用 `agent.invoke()`。
- **D-21:** `chat-methods.ts`（handleChatSend, handleChatHistory）重写为平台级 RPC handler，通过 `getAgentEngine()` 调用 `agent.chat()`，不再直接 import OpenClaw。
- **D-22:** `config-service.ts` 中的 LLM→OpenClaw 配置同步逻辑移入适配器。适配器初始化时自己读取 LLM 配置。
- **D-23:** 前端不做任何改动。前端 Chat 通过 WebSocket 连接后端。Phase 108 需决定 WebSocket 传输层策略（见 D-31）。前端 OpenClaw UI 清理留给 Phase 112。
- **D-24:** 适配器通过相对路径直接 import OpenClaw 源码（`../../../src/auto-reply/...`）。OpenClaw 源码不动。

### WebSocket 传输层

- **D-25:** 前端 Chat 需要 WebSocket 进行实时流式通信。Phase 108 中，OpenClaw 适配器内有 Gateway 提供 WebSocket。DirectAdapter 也需要一个 WebSocket 传输方式。两种选择在 Plan 中决策：
  - **A) 从 Gateway 提取 WebSocket 框架**（连接管理、auth challenge、消息解析），放在 `gateway/shared/`。适配器只拥有 RPC handler 注册逻辑
  - **B) DirectAdapter 自带极简 WebSocket 服务**（~100 行），不依赖 OpenClaw
- **D-26:** `gateway/error-codes.ts` 和 `gateway/protocol.ts` 中与 OpenClaw 无关的部分提取到共享层。Phase 109 可复用。

### 迁移策略

- **D-27:** 3 个 plan，自底向上严格顺序执行：
  - **Plan 1:** IAgentEngine 接口定义 + agent-core 集成 + 死代码清理 + 共享层提取
  - **Plan 2:** OpenClawAdapter 实现 + 所有文件迁移到 `adapter/openclaw/`
  - **Plan 3:** 平台代码切换到 IAgentEngine + 双跑对比验证
- **D-28:** 文件直接移动删除原位置，不留 re-export shim。所有 import 路径一并更新。
- **D-29:** 按调用方 toggle 控制切换：`ENABLE_AGENT_ADAPTER_CHAT` 和 `ENABLE_AGENT_ADAPTER_ANALYSIS`。可独立切换 chat 或 AI 分析路径。
- **D-30:** Plan 3 完成后双跑对比验证：新旧路径同时运行，比较输出一致性。

### 死代码清理

- **D-31:** Phase 108 中清理已确认的死代码：
  - `agent-service.ts` — 删除 `handleAgentRequest`、`classifyIntent`、`OPS_SYSTEM_PROMPTS`、`ALL_TOOL_DEFINITIONS`、`executeTool` 等（保留 `getAgentGreeting`、`AGENT_GREETING`）
  - `agent-service-v2.ts` — 完全删除（无人 import）
  - `openclaw-bridge.ts` — 删除 `sendMessageToAgent`（无人调用），`initializeAgentRunner` 保留但简化为 no-op
  - `openclaw-integration.ts` — 完全删除（纯注释文档）

### 测试

- **D-32:** `openclaw-integration.test.ts` 改写为测试 IAgentEngine 接口。验证工具注册、chat.send、invoke 路径。

## Canonical References

### Agent 引擎（已实现）
- `packages/agent-core/src/types.ts` — 接口定义（LLMProvider, Tool, ToolRegistry, AgentHook 等）
- `packages/agent-core/src/tool-registry.ts` — ToolRegistry 实现 + JSON Schema 校验
- `packages/agent-core/src/runner.ts` — AgentRunner（LLM ↔ Tool 循环，6 个关键机制）
- `packages/agent-core/src/index.ts` — 公共 API

### nanobot 参考源码
- `nanobot-reference/nanobot/agent/runner.py` — AgentRunner（1319 行，设计参考源）
- `nanobot-reference/nanobot/agent/loop.py` — AgentLoop 状态机（1598 行）
- `nanobot-reference/nanobot/agent/tools/registry.py` — ToolRegistry（126 行）
- `nanobot-reference/nanobot/agent/tools/base.py` — Tool 基类 + Schema 校验（297 行）
- `nanobot-reference/nanobot/api/server.py` — REST API，单条消息入口
- `nanobot-reference/nanobot/session/manager.py` — SessionManager
- `nanobot-reference/nanobot/agent/hook.py` — AgentHook 接口

### 当前架构（必须理解才能设计接口）
- `apps/db-ops-api/src/gateway/chat-methods.ts` — chat.send RPC handler，当前 dispatchInboundMessage 的调用方
- `apps/db-ops-api/src/gateway/openclaw-runtime.ts` — OpenClaw 配置、MsgContext 创建、工具初始化
- `apps/db-ops-api/src/gateway/gateway-client.ts` — sendGatewayChat WebSocket 客户端
- `apps/db-ops-api/src/gateway/server.ts` — Gateway WebSocket 服务器（~500行）
- `apps/db-ops-api/src/ai-agent-bridge.ts` — AI 分析统一调度入口（dispatchOrReuse）
- `apps/db-ops-api/src/agent-service.ts` — 当前工具定义 + handleAgentRequest
- `apps/db-ops-api/server.ts:71-79` — Gateway 启动和 import
- `apps/db-ops-api/server.ts:3520-3533` — OpenClaw 运行时初始化和 Gateway 启动

### 工具系统
- `apps/db-ops-api/src/tools/catalog.ts` — 当前 toolCatalog + registerPredefinedToolGroups
- `apps/db-ops-api/src/tools/types.ts` — 工具类型定义
- `apps/db-ops-api/src/tools/orchestrator.ts` — 工具编排器
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/` — Slide 自管理工具（complete_analysis 等）

### 相关 Phase 上下文
- `.planning/phases/106-指标采集可配置化/106-CONTEXT.md` — Registry<T> 通用抽象模式（D-02），数据驱动设计原则
- `.planning/phases/107-实例详情页指标动态化/107-CONTEXT.md` — Phase 107 完成的动态指标架构（Phase 108 的依赖）

### 设计文档
- `02-设计/202605251600-Agent 架构分析与设计方案.md` — 完整分析：三种世界观、nanobot 评估、IAgentEngine ↔ nanobot 适配分析、agent-core 设计

### OpenClaw 源码（适配器需引用）
- `src/auto-reply/dispatch.js` — dispatchInboundMessage
- `src/auto-reply/reply/reply-dispatcher.js` — createReplyDispatcher
- `src/agents/openclaw-tools.js` — createOpenClawTools
- `src/gateway/server.js` — startGatewayServer

## Existing Code Insights

### Reusable Assets
- `getOpenClawRuntime()` 单例模式 → 改为 `getAgentEngine()` 相同模式
- `toolCatalog` + `registerPredefinedToolGroups` → 保留为平台工具注册入口
- `chat-methods.ts` 的消息持久化逻辑（chatDatabaseService.addMessage）→ 保留在平台层

### Established Patterns
- `Registry<T>` 通用抽象（Phase 106 D-02）→ 不在此 phase 重复使用，但接口设计风格一致
- 闭包注入服务实例 → 工具 handler 继续此模式
- Factory 函数 + 懒初始化单例 → IAgentEngine 实例获取

### Integration Points
- `apps/db-ops-api/server.ts:71-72` — 当前 `startGatewayServer` + `getOpenClawRuntime` import，替换为 `getAgentEngine().start()`
- `apps/db-ops-api/src/gateway/chat-methods.ts:292` — 当前 `dispatchInboundMessage` 调用，替换为 `agent.chat()`
- `apps/db-ops-api/src/ai-agent-bridge.ts:47` — 当前 `sendGatewayChat` 调用，替换为 `agent.invoke()`
- `apps/db-ops-api/server.ts:3511` — 当前 `syncLLMConfigToOpenClaw` 调用，替换为适配器内部处理

### Dead Code Identified
- `agent-service-v2.ts` — 无人 import
- `agent-service.ts` 的 `handleAgentRequest`、`classifyIntent`、`OPS_SYSTEM_PROMPTS`、`ALL_TOOL_DEFINITIONS`、`executeTool` 等 — 仅被死代码引用
- `openclaw-bridge.ts` 的 `sendMessageToAgent` — 无人调用
- `openclaw-integration.ts` — 纯注释文档

## Deferred Ideas

- 定时任务与 Agent 无关 — 保持在平台层用 CronJob 管理。IAgentEngine 不包含 scheduleTrigger/cancelTrigger
- 会话管理是平台基础设施 — chatDatabaseService（MySQL）保持不变。IAgentEngine 不包含 session CRUD
- 前端 OpenClaw UI 清理 → Phase 112
- Gateway 依赖移除 → Phase 111（Phase 108 Gateway 仍在 OpenClaw 适配器内）
- nanobot 适配器实现 → Phase 109
- 从 Slide 提取 `@slide/agent-core` 为独立 npm 包 → 第二个项目需要时再做

---

*Phase: 108-agent*
*Context gathered: 2026-05-25*
*Updated: 2026-05-25*
