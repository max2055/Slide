# Phase 109: Agent Engine 补全 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.

**Date:** 2026-05-25
**Phase:** 109-agent-engine
**Areas discussed:** 通信协议, 适配深度, 缺失功能评估, OpenClaw 独有机制

---

## 通信协议

| Option | Description | Selected |
|--------|-------------|----------|
| HTTP Server 模式 | nanobot 提供 aiohttp HTTP server，SSE 流式 | ✓ |
| 子进程 JSON 行协议 | child_process.spawn() + stdin/stdout | |
| WebSocket | ws:// 双向流式通信 | |

**User's choice:** 先分析 nanobot 源码。发现 nanobot 已有 OpenAI-compatible HTTP API (`/v1/chat/completions` + SSE streaming)。

**Notes:** 后续讨论决定本阶段不再建 HTTP 适配器调 Python nanobot——agent-core 已经是 nanobot 的 TS 移植，直接补全 agent-core 即可。

---

## 适配深度

| Option | Description | Selected |
|--------|-------------|----------|
| 仅 LLM 调用 | nanobot 做 LLM + 流式，工具在 Slide TS 侧 | |
| MCP 回调模式 | Slide 工具注册为 MCP tools | |
| 全托管模式 | nanobot 做完整 Agent loop | |
| **补全 agent-core** | 把缺失机制从 nanobot 移植到 agent-core TS | ✓ |

**User's choice:** 不建适配器调 Python nanobot。直接补全 agent-core（nanobot 的 TS 移植）。agent-core 已经是 Slide 自己的 Agent 引擎，只需补全缺失功能。

---

## 缺失功能优先级

| 组件 | 决策 | 理由 |
|------|------|------|
| 超时分层 | P0，移植 nanobot | agent-core 定义了字段但从未使用 |
| Session 管理 | P1，移植 nanobot | 三套碎片需整合；MySQL chatDB 保留 |
| Context 构建 | P0，移植 nanobot | DirectAdapter 没有动态 context |
| Checkpoint 恢复 | P1，移植 nanobot | 只发不收→双向 |
| Memory | P2，移植 nanobot 简化版 | 不做 QMD dreaming 复杂管道 |
| Skills 接入 | P2，接入已有代码 | 33 个 skill 待用，接入成本低 |
| Subagent 接入 | P1，集成已有代码 | 完整基础设施已写，未接入 |
| Gateway 移除 + 前端 | 本阶段 | 移除 OpenClaw 协议依赖 |

---

## OpenClaw 独有机制处理

| 机制 | 决策 |
|------|------|
| QMD Memory (dreaming/ingestion) | 用 nanobot 简化版 |
| Gateway 协议 (connect/challenge/auth) | 本阶段移除，前端同步适配 |
| Skills extraDirs | 用 nanobot 的 workspace + builtin 双目录模式 |
| 工具注册 | 用 nanobot pkgutil + entry-point 模式，catalog.ts 改为扫描调度入口 |

**User's choice:** nanobot 和 OpenClaw 都有的→用 nanobot。OpenClaw 独有的→本阶段讨论移除或替换。

---

## 全局原则

| 原则 | 决策 |
|------|------|
| 移植源 | nanobot Python → agent-core TypeScript |
| 已有代码 | 优先复用（subagent、session-manager 等已写未接入的） |
| 前端 | Gateway 协议移除，前端本阶段适配 |
| SOUL.md/AGENTS.md/HEARTBEAT.md | 保留，作为 ContextBuilder 的输入源 |
| MEMORY.md | 保留，作为 Memory 持久化载体 |

## Claude's Discretion

- 具体 TypeScript API 设计（类/接口命名、方法签名）
- 移植时的 TS 惯用写法选择（async/await、Map、generator 等）
- 文件组织结构

## Deferred Ideas

- OpenClaw QMD dreaming/ingestion/short-term-recall 复杂管道 — 不需要
- nanobot API server 模式 (aiohttp HTTP API) — 不需要，agent-core 直接 TS 进程内运行
- 多租户 session 隔离 — 不在范围
