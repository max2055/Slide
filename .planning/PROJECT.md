# Slide — AI 驱动的数据库运维平台

**Shipped:** v1.4 (2026-06-09)
**Status:** Complete — v1.4 Agent 解耦与替换 shipped (Phases 108-118)

## What This Is

Slide 是一个 AI 驱动的数据库运维管理平台，提供实时监控、告警通知、性能分析、SQL 审核和智能运维工具。Agent 引擎可以自主调用平台工具采集数据、分析问题、给出建议，将 DBA 从重复性工作中释放。

## 系统分层架构

Slide 的 Agent 系统采用分层架构，从底层纯引擎到上层业务应用共 5 层：

```
┌──────────────────────────────────────────────────────┐
│ ⑤ Platform Services (业务服务层)                      │
│    chat-handler, ai-agent-bridge, alert-rca-service  │
│    cron-executor, fault-diagnosis-service            │
│    依赖 IAgentEngine 接口，不感知具体实现              │
├──────────────────────────────────────────────────────┤
│ ④ DirectAdapter (应用适配层)                          │
│    WebSocket transport (port 28888), JWT auth         │
│    Session → DB 双向持久化, SubagentManager 生命周期   │
│    chat() 流式对话 / invoke() 火后不理执行             │
│    实现 IAgentEngine 接口                             │
├──────────────────────────────────────────────────────┤
│ ③ IAgentEngine (抽象接口层)                           │
│    chat / invoke / listTools / capabilities           │
│    ChatEvent: text_delta | tool_start | tool_result   │
│              tool_error | complete | error             │
├──────────────────────────────────────────────────────┤
│ ② @slide/agent-core (Agent 引擎层)                    │
│    AgentRunner / ToolRegistry / Session               │
│    ContextBuilder / MemoryStore / SkillsLoader        │
│    LLMProvider (Anthropic/OpenAI/Ollama)              │
│    nanobot (Python) → TypeScript 移植                  │
├──────────────────────────────────────────────────────┤
│ ① Platform Tools (工具层)                             │
│    slide-self-mgmt / db-ops / subagent / cron         │
│    50+ 工具供 Agent 自主调用                           │
└──────────────────────────────────────────────────────┘
```

### ① Platform Tools — Agent 的工具箱

平台工具是 Agent 与 Slide 系统交互的唯一途径。每个工具都有 JSON Schema 参数定义，Agent 通过 ToolRegistry 发现和调用它们。

| 工具类别 | 来源目录 | 说明 |
|---------|---------|------|
| 自管理工具 | `tools/generated/slide-self-mgmt/` | check_status, complete_analysis, load_skills 等 |
| DB 运维工具 | `tools/ops/` | get_instance_summary, list_active_alerts, query_metrics |
| 子 Agent 工具 | `agents/subagent-spawn-tool.ts` | spawn_subagent, access_subagent |
| Cron 工具 | `cron/cron-completion-tool.ts` | slide_complete_cron |

工具通过 `catalog.ts` 的 `toolCatalog` 全局注册，`getAgentEngine()` 工厂启动时加载全部工具到 ToolRegistry。

**子 Agent 系统** — Agent 可以通过 `spawn_subagent` 工具创建子 Agent 并行处理子任务：
- **SubagentManager** — 包装 AgentRunner，提供 spawn/access 生命周期
- **深度控制** — root(0) → trunk(1) → branch(2) → leaf(3)，最大深度 3 层
- **工具作用域** — `scope: ['core']` 的工具不会被传递给子 Agent，防止递归爆炸
- **Fire-and-forget** — 子 Agent 异步执行，结果写入 SubagentRegistry，父 Agent 可通过 `access_subagent` 查询

### ② @slide/agent-core — Agent 引擎（nanobot TypeScript 移植）

`packages/agent-core/` 是 nanobot (HKUDS/nanobot) 从 Python 到 TypeScript 的完整移植。这是**纯引擎层**——不依赖任何 Slide 业务代码，只做 LLM ↔ Tool 循环。

核心组件：

| 组件 | 来源 | 职责 |
|------|------|------|
| **AgentRunner** | `runner.py` 移植 | LLM ↔ Tool 执行循环，含 8 种关键机制 |
| **ToolRegistry** | `tools/registry.py` 移植 | 动态工具注册、JSON Schema 校验、执行 |
| **Session** | `session/` 移植 | 每次对话的状态容器，消息历史 + 元数据 |
| **SessionManager** | `session/manager.py` 移植 | JSONL 文件持久化，LRU 缓存，损坏修复 |
| **ContextBuilder** | 新增 | 动态 system prompt 组装（bootstrap 文件 + memory + skills） |
| **MemoryStore** | `memory/` 移植 | 跨会话持久化记忆 |
| **SkillsLoader** | `skills/` 移植 | 工作区 skills 发现和加载 |
| **LLMProvider** | `llm/` 移植 | 统一 LLM 调用接口（Anthropic/OpenAI/Ollama） |

AgentRunner 的 8 种关键机制（从 nanobot 继承）：

1. **并行工具执行** — `concurrencySafe` 工具按 Kahn 算法批量并行
2. **回合中消息注入** — `injectionCallback` 在回合间插入系统消息
3. **中断恢复** — `checkpointCallback` 保存运行时状态，崩溃后可从断点恢复
4. **上下文预算管理** — microcompact（压缩旧工具结果）+ snip（按 token 预算截断历史）
5. **超时分层** — LLM 请求超时 + 流式空闲超时
6. **结构化追踪** — ToolEvent[] 记录每次工具调用的状态和详情
7. **双向检查点** — `_setRuntimeCheckpoint` / `_restoreRuntimeCheckpoint` 实现执行中保存/恢复
8. **工具自动发现** — `scanToolDir` 扫描目录动态 import 工具模块

### ③ IAgentEngine — 抽象接口

`apps/db-ops-api/src/adapter/types.ts` 定义了平台与 Agent 引擎之间的**接口契约**。所有业务代码只依赖此接口，不依赖具体实现。

```typescript
interface IAgentEngine {
  start(): Promise<void>;                    // 启动 WS 传输
  chat(sessionKey, message, onEvent): ...;   // 流式对话
  invoke(sessionKey, message, systemPrompt?): ...; // 火后不理执行
  listTools(): ToolSchema[];                 // 列出所有工具
  capabilities(): AgentCapabilities;          // 查询能力
}
```

ChatEvent 联合类型（8 种事件）：
- `text_delta` — 流式文本增量（前端逐字渲染）
- `tool_start` — 工具调用开始（含参数）
- `tool_result` — 工具执行成功结果
- `tool_error` — 工具执行失败
- `thinking_delta` — 推理过程增量
- `thinking_end` — 推理结束
- `complete` — 对话完成（含 finalContent）
- `error` — 对话错误

### ④ DirectAdapter — 应用适配层（nanobot 之上的那一层）

`apps/db-ops-api/src/adapter/direct-adapter.ts` 是 **IAgentEngine 的唯一实现**，将 @slide/agent-core 纯引擎适配到 Slide 业务环境。

**这是 nanobot 之上加的那一层** — 它做的是 nanobot 本身不做的事：

- **WebSocket 传输** — 自管理 WS server（端口 28888），不依赖外部 Gateway。含心跳检测（30s ping/pong）
- **JWT 认证** — WS 连接后的第一条消息必须是 `{type: 'auth', token}`，验证通过后才接受业务消息
- **会话持久化** — SessionManager（JSONL 文件）+ chatDatabaseService（MySQL），双写保证
- **上下文组装** — ContextBuilder 动态构建 system prompt，注入 memory、skills、历史摘要
- **子 Agent 初始化** — `start()` 时创建 SubagentManager 并注入全局
- **LLM Provider 动态切换** — `setProvider()` 支持运行时更换模型/API key，无需重启
- **消息幂等** — `idempotencyKey` 防止 WS 重连导致的重复消息
- **invoke() 广播** — fire-and-forget 执行完成后通过 WS 推送给订阅的前端会话

DirectAdapter 提供两种 Agent 执行模式：

| 模式 | 方法 | 流式 | 会话持久化 | 使用场景 |
|------|------|------|-----------|---------|
| **Chat** | `chat()` | ✅ | ✅ (JSONL + MySQL) | 前端 Chat UI 交互式对话 |
| **Invoke** | `invoke()` | ❌ | ✅ (JSONL + MySQL) | Alert RCA、Cron 任务、定时分析 |

### ⑤ Platform Services — 业务服务层

这些服务通过 `getAgentEngine()` 获取 `IAgentEngine` 实例，完全不感知底层是 DirectAdapter 还是 @slide/agent-core：

| 服务 | 文件 | 使用的 Agent 方法 | 用途 |
|------|------|------------------|------|
| **Chat Handler** | `chat-handler.ts` | `chat()` | WebSocket 聊天端点 |
| **AI Agent Bridge** | `ai-agent-bridge.ts` | `invoke()` | 统一 AI 分析分发 + TTL 缓存 |
| **Alert RCA Service** | `alert-rca-service.ts` | `invoke()` | 告警根因自动分析 |
| **Cron Executor** | `cron/cron-executor.ts` | `AgentRunner.run()` | AI 驱动定时任务（直接调引擎） |
| **Fault Diagnosis** | `fault-diagnosis-service.ts` | `invoke()` | 故障自动诊断 |

## 技术栈

- **Frontend** — Lit 3.3 + Vite (Web Components) + ECharts，端口 5173
- **Backend** — Fastify + TypeScript，端口 3000
- **Agent Engine** — @slide/agent-core (nanobot TS 移植)，DirectAdapter WS 端口 28888
- **Databases** — MySQL (primary) + Elasticsearch + MongoDB + Redis
- **Auth** — JWT (bcrypt)
- **LLM** — Anthropic SDK / OpenAI SDK / Ollama（通过 @slide/agent-core provider 统一接口）

## 数据流全景

```
用户浏览器 (Lit Web Components)
  │  WebSocket
  ▼  ws://127.0.0.1:28888/ws
DirectAdapter (IAgentEngine)
  │  chat() / invoke()
  ▼
AgentRunner (agent-core)
  │  LLM ↔ Tool 循环
  ├──→ Anthropic/OpenAI/Ollama API  (LLM 推理)
  └──→ ToolRegistry.execute()       (工具调用)
        ├──→ slide-self-mgmt tools  (自管理)
        ├──→ db-ops tools           (数据库操作)
        ├──→ spawn_subagent         (创建子 Agent)
        └──→ slide_complete_cron    (Cron 完成回调)
              │
              ▼
            MySQL / Elasticsearch / MongoDB (数据采集)
```

## Key Capabilities

| Capability | Description |
|-----------|-------------|
| Multi-DB Monitoring | MySQL + PostgreSQL metrics collection at 30s interval |
| Alert Engine | 50+ metric rules, 3-level thresholds, cron-based evaluation |
| Multi-Channel Notification | DingTalk, WeCom, Feishu, Webhook with SSRF protection |
| Report Generation | Health, performance, slow query, capacity reports (PDF/HTML/JSON/MD) |
| SQL Audit | LLM-driven pre-execution SQL review with risk detection |
| Query Analytics | QAN fingerprint analysis + EXPLAIN JSON visualization |
| AI Chat | 流式 Agent 对话，支持 tool calling、thinking、子 Agent 分发 |
| AI Analysis | RCA, fault diagnosis, TopSQL analysis via ai-agent-bridge |
| AI Cron | 自然语言驱动的定时任务，替换硬编码 handler |
| RBAC | JWT auth + role-based access control (admin/dba/viewer) |
| Approval Workflow | SQL execution approval with LLM risk assessment |
| Capacity Prediction | Linear regression on metrics history |

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| nanobot → @slide/agent-core 移植 | 自研可控，TypeScript 原生，无 Python 依赖 | ✓ Shipped in v1.4 |
| DirectAdapter 自管理 WS | 不依赖外部 Gateway，~100 行独立 WS server | ✓ Working |
| IAgentEngine 抽象层 | 平台代码只依赖接口，Agent 实现可替换 | ✓ Validated in Phase 108 |
| JWT + requireRole middleware | Consistent auth pattern across all write endpoints | ✓ Working |
| Parameterized queries | Prevent SQL injection across all DB operations | ✓ Verified |
| ECharts over Chart.js | Richer interactivity, better Chinese ecosystem support | ✓ Working |
| AI Agent Cron (Phase 113) | Natural language cron tasks replace 13 hardcoded handlers | ✓ Validated in Phase 113 |
| Subagent depth-based scoping | Prevent infinite recursive spawn; 3-level max depth | ✓ Working |
| LLM Provider 动态切换 | `setProvider()` 运行时更换模型，无需重启 | ✓ Working |

## Constraints

- Database access is read-only (no DDL execution)
- No OS-level access (log collection via SQL queries only)
- LLM available for AI features (Anthropic/OpenAI/Ollama)

## Current Milestone: v1.4 Agent 解耦与替换 ✅ Complete

**Goal:** 将 OpenClaw Agent 框架替换为自研 @slide/agent-core（nanobot TS 移植），实现完全自主可控

**Shipped features (Phases 108-118):**
- Phase 108: IAgentEngine 抽象层 + DirectAdapter 基础
- Phase 109: Agent 引擎补全（Session/Context/Memory/Checkpoint/Subagent/Skills）
- Phase 110: DirectAdapter 默认切换 + 端到端验证
- Phase 111: Gateway 简化（删除失效 controller/view/slash command）
- Phase 112: 前端清理 + 定时任务可配置化
- Phase 113: AI Agent Cron（自然语言驱动定时任务）
- Phase 114: Verification 清账（12 项遗留验证）
- Phase 115-117: 去 OpenClaw 清理、运行时引用替换、收尾
- Phase 118: Agent DB 连接工具 + 告警机制完善

## Known Issues / Tech Debt

See `01-SECURITY.md` accepted risks:
- Instance-level authorization deferred (all users are trusted operators)
- PDF concurrency limiting deferred (low traffic internal tool)
- Alert rate limiting deferred to hardening phase
- GET /api/alerts missing JWT auth (documented, accepted)

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

*Last updated: 2026-06-09 — 架构文档全面更新，新增系统分层架构和数据流全景*
