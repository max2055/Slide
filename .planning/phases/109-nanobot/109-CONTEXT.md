---
phase: 109
created: 2026-05-25
updated: 2026-05-25
---

# Phase 109: Agent Engine 补全 & DirectAdapter 接管

**Gathered:** 2026-05-25
**Status:** Ready for planning

## Phase Boundary

补全 `@slide/agent-core`（nanobot Agent 机制的 TypeScript 移植），让 DirectAdapter 成为功能完整、可独立运行的 Agent 引擎。随后移除 OpenClaw Gateway 依赖，前端适配新的 Agent 层通信。

**核心原则：nanobot 和 OpenClaw 都有的功能/机制 → 用 nanobot 的移植；OpenClaw 独有的 → 本阶段讨论如何处理。**

当前 agent-core 只移植了 nanobot 的 ~12%（AgentRunner + ToolRegistry，1523 行）。以下按实现依赖排序：

```
超时分层 ────────────────────────────┐
                                     │
Session 管理 ── Context 构建 ────────┤
                    │               │
                    ├─ Skills 接入   │
                    │               │
                    └─ Memory ──────┤
                                     │
Checkpoint 恢复 ─────────────────────┤
                                     │
Subagent 接入 (代码已有，只需集成) ──┘
                                     │
移除 Gateway 协议 + 前端适配 ────────┘
```

## Implementation Decisions

### 全局原则

- **D-01:** nanobot 和 OpenClaw 都有的功能和机制，采用 nanobot 的实现（移植到 TypeScript）。
- **D-02:** OpenClaw 独有的机制（Gateway 协议），本阶段移除，前端同步适配。
- **D-03:** 已有但未接入的 Slide 代码（subagent、session-manager、ContextManager）优先复用而非重写。
- **D-04:** 从 nanobot Python 源码（`nanobot-reference/nanobot/`）移植，保持架构和命名一致。移植后用 TypeScript 惯用写法（async/await 替代 asyncio，Map 替代 dict 等）。

### 超时分层

- **D-05:** 移植 nanobot 的两层超时：LLM 请求超时（`NANOBOT_LLM_TIMEOUT_S`，默认 300s）+ 流式空闲超时（`NANOBOT_STREAM_IDLE_TIMEOUT_S`）。
- **D-06:** 超时后返回 `error_kind="timeout"` 的错误响应，不抛异常。保持与 agent-core 现有错误处理一致。

### Session 管理

- **D-07:** 移植 nanobot 的 Session 模型（`nanobot/session/manager.py`）到 agent-core。Session 存储对话历史、元数据、checkpoint 状态。
- **D-08:** MySQL `chatDatabaseService` 保留不动——前端 Chat 页面和历史查询依赖它。agent-core Session 是 Agent 引擎内部的会话表示，与 MySQL 持久化层互补。
- **D-09:** JSONL `session-manager.ts` 和 `ContextManager` 已存在但未接入，评估后复用或替换为 nanobot 移植版。

### Context 构建

- **D-10:** 移植 nanobot 的 ContextBuilder（`nanobot/agent/context.py`）到 agent-core。负责组装 system prompt：identity 文件 + memory context + skills 摘要 + 运行时上下文行。
- **D-11:** 保留 SOUL.md、AGENTS.md、HEARTBEAT.md 作为 context 源文件。这些文件的格式和内容不变。
- **D-12:** DirectAdapter 的 `DEFAULT_SYSTEM_PROMPT` 硬编码字符串替换为 ContextBuilder 动态组装。

### Skills 接入

- **D-13:** 采用 nanobot 的 SkillsLoader 模式：扫描 `skills/` 目录 + builtin skills 目录，解析 SKILL.md frontmatter，过滤不可用的 skill，注入 system prompt。
- **D-14:** `.agents/skills/` 中 33 个现有 skill 全部保留，作为 workspace skills 加载。

### Memory

- **D-15:** 采用 nanobot 的简化版 Memory 系统（MemoryStore + Consolidator）。不做 OpenClaw QMD 的 dreaming/ingestion/short-term-recall 复杂管道。
- **D-16:** MEMORY.md 文件保留，作为长期记忆的持久化载体。

### Checkpoint 恢复

- **D-17:** 移植 nanobot 的 checkpoint 恢复机制：`_set_runtime_checkpoint` 持久化到 session metadata，`_restore_runtime_checkpoint` 在下个 turn 恢复。当前 agent-core 只发不收（单向通知），改为双向。

### Subagent 接入

- **D-18:** Slide 已有完整的 subagent 基础设施（`subagent-registry.ts`、`subagent-capabilities.ts`、`subagent-spawn-tool.ts`），代码不移植，只做集成接入。
- **D-19:** `spawn_subagent` 和 `access_subagent` 工具注册到 agent-core 的 ToolRegistry。

### Gateway 移除 & 前端适配

- **D-20:** 移除 OpenClaw Gateway 协议依赖。DirectAdapter 的 WebSocket 传输层直接服务前端。
- **D-21:** 前端清理 `frontend/src/openclaw/` 依赖，Chat 界面基于新 Agent 层通信。
- **D-22:** 前端 WebSocket 消息协议简化为 DirectAdapter 原生格式（`chat.send` / `chat.history`），不再经过 OpenClaw Gateway 协议层。

### 工具注册

- **D-23:** 采用 nanobot 的 pkgutil + entry-point 模式：工具文件自注册（import 时 side-effect），loader 做文件扫描 + 动态 import。`catalog.ts` 改为扫描调度入口，不再手动列举。
- **D-24:** Slide 数据库工具（`tools/generated/slide-self-mgmt/`）保持 TypeScript 实现，接入 agent-core ToolRegistry。

## Canonical References

### nanobot 源码（移植源）
- `nanobot-reference/nanobot/agent/runner.py` — AgentRunner 完整实现（1318 行），超时分层参考
- `nanobot-reference/nanobot/session/manager.py` — Session 管理器
- `nanobot-reference/nanobot/agent/context.py` — ContextBuilder（249 行）
- `nanobot-reference/nanobot/agent/memory.py` — MemoryStore + Consolidator（1162 行）
- `nanobot-reference/nanobot/agent/skills.py` — SkillsLoader（242 行）
- `nanobot-reference/nanobot/agent/loop.py` — AgentLoop，checkpoint 恢复参考（1597 行）
- `nanobot-reference/nanobot/agent/tools/loader.py` — 工具自动发现（pkgutil + entry_point）

### Slide 现有代码
- `packages/agent-core/src/runner.ts` — 当前 AgentRunner（958 行，待补全）
- `packages/agent-core/src/tool-registry.ts` — ToolRegistry（297 行）
- `packages/agent-core/src/types.ts` — 类型定义（214 行）
- `apps/db-ops-api/src/adapter/direct-adapter.ts` — DirectAdapter（当前封装）
- `apps/db-ops-api/src/adapter/types.ts` — IAgentEngine 接口
- `apps/db-ops-api/src/sessions/session-manager.ts` — 已有 Session 管理（未接入）
- `apps/db-ops-api/src/sessions/context-manager.ts` — 已有 ContextManager（未接入）
- `apps/db-ops-api/src/agents/subagent-registry.ts` — Subagent 注册表
- `apps/db-ops-api/src/agents/subagent-capabilities.ts` — Subagent 能力模型
- `apps/db-ops-api/src/agents/subagent-spawn-tool.ts` — Subagent 工具定义
- `apps/db-ops-api/src/skills/loader.ts` — Skills 加载器（未接入）
- `.agents/skills/` — 33 个活跃 skill

### 设计文档
- `nanobot-reference/CLAUDE.md` — nanobot 架构总览
- `.planning/phases/108-agent/108-CONTEXT.md` — Phase 108 决策（IAgentEngine 接口、适配器架构）
- `.planning/phases/108-agent/108-RESEARCH.md` — Phase 108 调研（nanobot 机制分析）

## Existing Code Insights

### Reusable Assets
- **agent-core AgentRunner**: 核心 loop 已移植（LLM→Tool 执行循环、并行工具、注入、snip/microcompact），只需补缺失机制
- **Slide subagent 基础设施**: 完整但未接入，代码质量好，有测试
- **Skills loader**: Slide 侧已有 YAML frontmatter 解析 + 目录扫描，只需接入 DirectAdapter
- **Session manager + ContextManager**: 已实现未接入，评估后可复用

### Established Patterns
- **Lazy singleton factory**: `getAgentEngine()` / `getOpenClawRuntime()` 模式
- **IAgentEngine 接口**: 5 方法（start, chat, invoke, listTools, capabilities），适配器不假设传输方式
- **ChatEvent 联合类型**: 6 variants（text_delta, tool_start, tool_result, tool_error, complete, error）
- **adapter/shared/ 共享层**: 协议类型和错误码可复用

### Integration Points
- `server.ts` → `getAgentEngine().start()` — 启动入口
- `chat-handler.ts` → `getAgentEngine().chat()` — Chat RPC
- `ai-agent-bridge.ts` → `getAgentEngine('analysis').invoke()` — AI 分析
- 前端 WebSocket → port 28789 — Chat 实时通信
- `.agents/skills/` → ContextBuilder — Skill 注入

## Deferred Ideas

- OpenClaw QMD dreaming/ingestion 复杂管道 — 不需要，nanobot 简化版够用
- 多租户 session 隔离 — 当前单用户场景不需要
- Plugin marketplace / remote skill installation — 不在本阶段范围

---

*Phase: 109-agent-engine*
*Context gathered: 2026-05-25*
