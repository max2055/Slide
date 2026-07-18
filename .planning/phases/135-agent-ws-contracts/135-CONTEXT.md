---
phase: 135-agent-ws-contracts
status: planned
priority: P1
depends_on:
  - 132-security-boundaries
  - 133-operation-sql-safety
plans: 2
source: Phase 131 audit and Data Loom reasoning review
---

# Phase 135：Agent/WS 执行契约与结构化分析

## 目标

使 Chat、invoke、工具调用和 AI 分析拥有版本化协议、明确终态、可取消执行、持久幂等和可验证结构化结果。前端只展示 DirectAdapter 真正支持的能力。

## 覆盖发现

- HI-10：Agent/LLM 失败被解释为完成
- ME-01：停止按钮不取消任务
- ME-02：附件和幂等字段在 WS 链路丢失
- ME-05：Agent 管理页暴露无效控件
- TG-01/TG-06：Agent Core 契约测试与实现漂移
- Data Loom：AI 推理结构化、证据/建议/执行轨迹建议

## 锁定决策

1. WS v2 消息包含 `protocolVersion`、`messageId`、`runId`、`sessionKey`、`idempotencyKey`、attachments 和 Actor/Operation 引用。未知字段版本拒绝而非静默丢弃。
2. 运行终态使用判别联合：`completed | partial | failed | cancelled | timed_out`。Promise resolve 不代表业务成功。
3. DirectAdapter 持久跟踪 `runId -> AbortController/Operation`；取消须校验用户和会话所有权，并向前端发送唯一终态。
4. 幂等键存入共享数据库并带 TTL；同一用户/会话/消息重放返回原 Operation，而不是再次调用 LLM 或工具。
5. attachments 采用白名单类型、大小和内容引用；不支持时返回明确错误。
6. AI 分析保存为版本化 `AnalysisEnvelope`：结论、假设、证据引用、置信度、建议、展示 Markdown、模型/提示词/工具版本。`execution_trace` 保持独立字段。
7. `slide_complete_analysis` 接受结构化对象并做 TypeBox/JSON Schema 校验，不再要求在 Markdown 代码块内嵌 JSON。
8. `capabilities()` 扩展为 feature 级能力，Agent 管理页按能力隐藏或禁用入口，禁止空回调。

## 非目标

- 不让 Data Loom 成为写入系统；它只消费版本化调查包。
- 不增加新的模型供应商。
- 不在本 Phase 实现跨领域 Memory 自动学习，Phase 137 只允许验证后事件进入记忆候选。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 135-01 | 1 | WS v2、终态联合、取消、附件、持久幂等、失败恢复 |
| 135-02 | 2 | AnalysisEnvelope、结构化完成工具、回填策略、能力驱动 Agent UI |

## Phase 退出门禁

- provider 错误、超时、工具错误、最大迭代和用户取消分别落入正确终态。
- 重连重放同一 idempotency key 不重复调用工具。
- 附件从浏览器到 Agent 输入保持完整或收到明确拒绝。
- AnalysisEnvelope schema 验证、旧 Markdown 兼容读取和安全渲染测试通过。
- 所有可见 Agent 控件都有实际 handler、持久反馈和失败提示。
