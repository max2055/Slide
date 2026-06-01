# Phase 108: Agent 抽象层 — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-25
**Phase:** 108-agent
**Areas discussed:** Interface scope & boundaries, Adapter isolation depth, Migration strategy, Tool definition ownership

---

## Interface Scope & Boundaries

### Q1: IAgentEngine 覆盖范围

| Option | Description | Selected |
|--------|-------------|----------|
| Interface owns tools | IAgentEngine 包含工具注册。平台调用 adapter.registerTool()，adapter 转换为原生格式 | ✓ |
| Interface does chat+session only | 工具注册不进入接口 |
| Interface is chat.send only | 最小接口 |

**User's choice:** Interface owns tools
**Notes:** 接口覆盖 chat.send + 工具注册/调用 + 会话管理 + cron 触发（4 项）。会话管理和 cron 触发在后续问题中被移出接口。

### Q2: Chat vs AI 分析调用模式

| Option | Description | Selected |
|--------|-------------|----------|
| 分离为两个方法 | .chat() 交互式流式 + .invoke() fire-and-forget | ✓ |
| 一个接口两种模式 | .chat() 用参数区分 |
| 仅 Chat，AI 分析保持现状 | 不统一 AI 分析路径 |

**User's choice:** 分离为两个方法（推荐）
**Notes:** 中文输出要求已确认。后续讨论全程使用中文。

### Q3: Gateway WebSocket 服务器归属

| Option | Description | Selected |
|--------|-------------|----------|
| Gateway 属于适配器 | startGatewayServer 放入适配器。平台调用 adapter.start() | ✓ |
| Gateway 是平台基础设施 | WebSocket 层不属于 Agent 职责 |
| Gateway 逐步迁移 | Phase 108 不动 Gateway |

**User's choice:** Gateway 属于适配器（推荐）

### Q4: 错误处理策略

| Option | Description | Selected |
|--------|-------------|----------|
| 标准 Error 抛出 | 不用结构化错误码，try/catch | ✓ |
| 结构化错误码 | 保持 OpenClaw ErrorCodes 模式 |
| Result 模式 | { success, data?, error? } |

**User's choice:** 标准 Error 抛出（推荐）

### Q5: 流式事件格式

| Option | Description | Selected |
|--------|-------------|----------|
| 统一事件格式 | IAgentEngine 定义标准事件类型，适配器映射 | ✓ |
| 适配器自定义事件 | 每个适配器定义自己的事件 |
| 仅返回最终结果 | 不暴露流式事件 |

**User's choice:** 统一事件格式（推荐）

### Q6: 实例获取方式

| Option | Description | Selected |
|--------|-------------|----------|
| Factory 函数 | getAgentEngine() 模块级单例 | ✓ |
| 依赖注入 | Fastify decorate 注入 |
| 模块级单例 | 直接 export const agent |

**User's choice:** Factory 函数（推荐）

### Q7: 工具 Handler 签名

| Option | Description | Selected |
|--------|-------------|----------|
| 统一 ToolHandler | (params: Record<string, unknown>) => Promise<unknown> | ✓ |
| 保持原生签名 | 每个适配器接受自己的 handler 格式 |
| 声明式工具定义 | handler 不走接口 |

**User's choice:** 统一 ToolHandler（推荐）

### Q8: 适配器配置传入方式

| Option | Description | Selected |
|--------|-------------|----------|
| 构造函数注入 | new OpenClawAdapter({ workspaceDir, tools, config }) | ✓ |
| 环境变量驱动 | process.env |
| 配置文件驱动 | JSON/YAML |

**User's choice:** 构造函数注入（推荐）

---

## Adapter Isolation Depth

### Q1: 隔离程度

| Option | Description | Selected |
|--------|-------------|----------|
| 零 OpenClaw import | 平台代码中完全不 import OpenClaw | ✓ |
| 渐进隔离 | 先隔离功能调用，类型可跨边界 |
| 最小隔离 | 只隔离 chat.send |

**User's choice:** 零 OpenClaw import（推荐）

### Q2: gateway-client.ts 归属

| Option | Description | Selected |
|--------|-------------|----------|
| 适配器内部处理 | sendGatewayChat 移入 adapter | ✓ |
| 保留 WebSocket 客户端 | gateway-client.ts 保持为平台工具 |

**User's choice:** 适配器内部处理（推荐）

### Q3: 适配器文件结构

| Option | Description | Selected |
|--------|-------------|----------|
| 单一 adapter 目录 | src/adapter/openclaw/ 全部 OpenClaw 代码 | ✓ |
| 保持 gateway 目录 | 只加薄适配器层 |
| 适配器 + 共享 gateway | 提取协议无关部分 |

**User's choice:** 单一 adapter 目录（推荐）

### Q4: 工具定义位置

| Option | Description | Selected |
|--------|-------------|----------|
| 工具留在 src/tools/+ | 平台定义 schema + handler，适配器注册 | ✓ |
| 工具拷入适配器 | 每个适配器自己实现工具 |
| 共享工具接口 | 统一注册逻辑 |

**User's choice:** 工具留在 src/tools/+（推荐）

### Q5: 前端代码处理

| Option | Description | Selected |
|--------|-------------|----------|
| 前端不改 | Phase 108 只改后端，前端留给 Phase 112 | ✓ |
| 前端同步改接口 | 改为 REST API 调用 |

**User's choice:** 前端不改（推荐）

### Q6: LLM 配置同步

| Option | Description | Selected |
|--------|-------------|----------|
| 适配器内部处理 | config-service.ts 移入适配器 | ✓ |
| 平台统一管理 | 配置同步保持在平台层 |

**User's choice:** 适配器内部处理（推荐）

### Q7: 双路径分析

**Notes:** 经代码分析发现只有一条实际使用的路径（chat-methods.ts → dispatchInboundMessage）。agent-service.ts 的 handleAgentRequest 路径是死代码。不存在"双路径合并"问题。

### Q8: gateway/server.ts 处理

| Option | Description | Selected |
|--------|-------------|----------|
| 移入适配器 | gateway/server.ts（~500行）整体移入 adapter | ✓ |
| 拆分：协议层保留 + 业务层移入 | 为 Phase 109 复用 |
| 保持原位，接口代理 | 不移动 |

**User's choice:** 移入适配器（推荐）

### Q9: chat-methods.ts 归属

| Option | Description | Selected |
|--------|-------------|----------|
| 重写为平台级 RPC handler | 改用 IAgentEngine，不 import OpenClaw | ✓ |
| 移入适配器 | 整体移入 adapter |
| 保留不动 | 只包一层 |

**User's choice:** 重写为平台级 RPC handler（推荐）

### Q10: 共享基础设施提取

| Option | Description | Selected |
|--------|-------------|----------|
| 提取共享层 | error-codes.ts + protocol.ts 非 OpenClaw 部分 → gateway/shared/ | ✓ |
| 全部移入适配器 | 不做共享 |
| 全部保留 | 文件位置不变 |

**User's choice:** 提取共享层（推荐）

### Q11: 死代码清理

| Option | Description | Selected |
|--------|-------------|----------|
| 顺手清理 | Phase 108 删除已确认死代码 | ✓ |
| 标记不删 | 加 @deprecated |
| 不动 | 只加新代码 |

**User's choice:** 顺手清理（推荐）

### Q12: ai-agent-bridge.ts 处理

| Option | Description | Selected |
|--------|-------------|----------|
| 改用 agent.invoke() | AI bridge 保持，替换 sendGatewayChat | ✓ |
| 移入适配器 | 整个移入 |
| 不动 | 保持 WebSocket 路径 |

**User's choice:** 改用 agent.invoke()（推荐）

---

## Migration Strategy

### Q1: Plan 拆分

| Option | Description | Selected |
|--------|-------------|----------|
| 自底向上 | Plan 1: 接口+清理 → Plan 2: 适配器 → Plan 3: 切换+验证 | ✓ |
| 先接口后实现 | 只 2 个 plan |
| 一次性重构 | 单 plan |

**User's choice:** 自底向上（推荐）

### Q2: 验证策略

| Option | Description | Selected |
|--------|-------------|----------|
| 双跑对比 | 新旧路径同时运行，比较输出 | ✓ |
| 单元测试 + 手动 | 更稳妥 |
| 端到端手动 | 最小验证 |

**User's choice:** 双跑对比

### Q3: 切换开关

| Option | Description | Selected |
|--------|-------------|----------|
| 按调用方 toggle | ENABLE_AGENT_ADAPTER_CHAT / ENABLE_AGENT_ADAPTER_ANALYSIS | ✓ |
| 环境变量 toggle | 单开关控制全部 |
| 无条件切换 | 不用开关 |

**User's choice:** 按调用方 toggle

### Q4: 旧文件处理

| Option | Description | Selected |
|--------|-------------|----------|
| 直接移动+删除原文件 | 不留 shim | ✓ |
| 移动+留 re-export shim | 渐进迁移 |
| 先复制后删除 | 两阶段 |

**User's choice:** 直接移动+删除原文件（推荐）

### Q5: 定时任务处理

**User's note:** 定时任务建议与 Agent 解耦，放到平台层实现。IAgentEngine 不包含 scheduleTrigger/cancelTrigger。此能力从接口移除。

### Q6: 测试和文档

| Option | Description | Selected |
|--------|-------------|----------|
| 测试重写+文档删除 | test 改测 IAgentEngine，纯注释文档删 | ✓ |
| 原样保留 | 不动 |

**User's choice:** 测试重写+文档删除（推荐）

### Q7: 前向兼容

| Option | Description | Selected |
|--------|-------------|----------|
| 接口设计预留 nanobot | 考虑 HTTP API、无 Gateway 的差异 | ✓ |
| 只考虑 OpenClaw | 不做过早抽象 |

**User's choice:** 接口设计预留 nanobot（推荐）

### Q8: Plan 依赖关系

| Option | Description | Selected |
|--------|-------------|----------|
| 严格顺序 | Plan 1 → Plan 2 → Plan 3 | ✓ |
| Plan 1+2 可并行 | 缩短周期 |

**User's choice:** 严格顺序（推荐）

### Q9: OpenClaw 源码依赖

| Option | Description | Selected |
|--------|-------------|----------|
| 适配器直接引用 | 通过相对路径 import 源码，源码不动 | ✓ |
| 拷贝关键文件 | vendor/ 下拷贝 |

**User's choice:** 适配器直接引用（推荐）

---

## Tool Definition Ownership

### Q1: 工具注册流程

| Option | Description | Selected |
|--------|-------------|----------|
| 平台定义 Schema + 适配器注册 | catalog.ts 定义，adapter.registerTool() 注册 | ✓ |
| 适配器各自定义 | 每个适配器自带工具定义 |
| 统一 JSON schema 文件 | 独立配置文件 |

**User's choice:** 平台定义 Schema + 适配器注册（推荐）

### Q2: pi-agent 系统工具

| Option | Description | Selected |
|--------|-------------|----------|
| 平台统一注册 | pi-agent 工具也走 catalog.ts | ✓ |
| 适配器自行添加 | 适配器自己加载 |

**User's choice:** 平台统一注册（推荐）

### Q3: OpenClaw 原生工具

| Option | Description | Selected |
|--------|-------------|----------|
| 适配器内部加载 | createOpenClawTools 由适配器内部调用 | ✓ |
| 平台统一管理 | 全部工具对平台可见 |
| 不加载原生工具 | 只注册 Slide 工具 |

**User's choice:** 适配器内部加载（推荐）

### Q4: 工具服务注入

| Option | Description | Selected |
|--------|-------------|----------|
| 闭包注入 | handler 已绑定服务，和当前模式一致 | ✓ |
| 共享 context 对象 | adapter.chat() 传 context |

**User's choice:** 闭包注入（推荐）

### Q5: 工具可见性

| Option | Description | Selected |
|--------|-------------|----------|
| 接口提供 listTools() | 展示可用工具列表 | ✓ |
| 不暴露工具列表 | 内部实现细节 |

**User's choice:** 接口提供 listTools()（推荐）

### Q6: 工具生命周期

| Option | Description | Selected |
|--------|-------------|----------|
| 启动时一次性注册 | 不支持运行时动态增删 | ✓ |
| 支持运行时注册 | 可动态 register/unregister |

**User's choice:** 启动时一次性注册（推荐）

### Q7: 工具目录结构

| Option | Description | Selected |
|--------|-------------|----------|
| catalog.ts 是唯一入口 | schema + handler 一起，迁移 agent-service.ts 的定义过来 | ✓ |
| catalog + definitions 分离 | 模块化 |

**User's choice:** catalog.ts 是唯一入口（推荐）

### Q8: capabilities() 方法

| Option | Description | Selected |
|--------|-------------|----------|
| 需要 capabilities() | 返回 { streaming, toolCalling, maxContextTokens } | ✓ |
| 不需要 | 接口方法签名隐含能力 |

**User's choice:** 需要 capabilities()（推荐）

### Q9: 会话存储

| Option | Description | Selected |
|--------|-------------|----------|
| 平台管理 | chatDatabaseService（MySQL）保持不变 | ✓ |
| 适配器管理 | 适配器负责存储 |
| 接口不包含会话 | 会话 CRUD 移出接口 |

**User's choice:** 平台管理（推荐）
**Notes:** 会话管理从 IAgentEngine 接口中移除。chat-methods.ts 保持对 chatDatabaseService 的直接调用。

---

## Claude's Discretion

None — all decisions were made by the user.

## Deferred Ideas

- 定时任务与 Agent 解耦 → 平台 CronJob
- 前端 OpenClaw UI 清理 → Phase 112
- Gateway 简化 → Phase 111
- nanobot 适配器 → Phase 109
- 会话管理 → 平台 chatDatabaseService
