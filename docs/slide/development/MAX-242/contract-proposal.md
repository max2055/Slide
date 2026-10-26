# MAX-242 跨模块契约提案（交 Chief 协调，本轮未改代码）

本文件只提出实现阶段需要的共享契约变更，供 MAX-235/Chief 评估与分配。**本轮未修改任何生产契约、生成 API/OpenAPI、共享组件或 investigations 代码**；以下“提案”不代表已实现。

## 提案一览

| # | 提案 | 影响模块 | 兼容策略 | 依赖 |
|---|---|---|---|---|
| P1 | 创建调查接受结构化来源与生成式标题/目标 | `investigations/http-contracts.ts`、`routes.ts`、前端创建组件 | 字段可选；缺省仍要求 `title/goal`（旧客户端不变） | — |
| P2 | 继续执行接受结构化下一步意图 | `InvestigationRequestSchema`、`continuation`、详情页 | `message` 保留必填；新增可选 `intent` + 生成文本，旧调用不变 | — |
| P3 | 调查级三类复测结论 | `contracts.ts`（feedback/close）、审计、详情页 | 新记录类型；不改 `problemStatus` 枚举语义 | MAX-239 恢复判定 |
| P4 | “需要你处理”投影查询 | 新增只读聚合端点或既有列表扩展 | 只读投影，不建第二套状态；引用原记录 ID | 审批/调查/验证 |
| P5 | 交接摘要草案 | 新增只读生成端点（不调模型） | 从记录生成；权限沿用原调查 | — |
| P6 | 来源与返回位置 | 调查记录新增 `source`/`returnTo` 元数据 | 可选字段；站内 URL 校验 | 旧入口改造 |
| P7 | 案例候选绑定结果版本 | `operations-knowledge` 契约 | 已存在 `source.investigationId/resultVersion`，仅补来源校验 | — |

## P1 结构化创建上下文

现状问题：`InvestigationCreateRequestSchema` 要求 `title`(1–200) 与 `goal`(1–2000) 非空（`apps/db-ops-api/src/investigations/http-contracts.ts:9-14`），前端同样强制（`frontend/src/app/ui/components/investigation-create.ts:131`）。仅在前端隐藏字段会提交空值或占位句，不可接受。

建议（向后兼容）：

```ts
// 新增可选字段，不改变现有必填语义
source?: {
  kind: 'event' | 'resource' | 'metric_history' | 'chat' | 'manual';
  eventRef?: { id: string; source: string };       // 事件来源
  resourceRef?: { type: 'instance'|'server'|'network_device'; id: number };
  metricRef?: { metricId: string; observedFrom?: string; observedTo?: string };
  chatSessionId?: string;                           // 与现有 sessionId 语义区分
  returnTo?: string;                                // 站内相对 URL，服务端校验
};
scenario?: { id: string; version: number };          // 场景注册表条目
generated?: { title: boolean; goal: boolean };       // 服务端/客户端生成标记（审计用）
```

约束：
- 服务端仍校验最终 `title/goal` 非空、长度与空白字符规则；生成来源写入审计。
- `returnTo` 只接受同源路径（拒绝协议/外部域），用于返回位置；无权时回退列表。
- 场景 ID 必须来自服务端能力注册表；未知场景返回 422，不静默降级。
- 自动带入不改变 `profileId/subject/resourceRefs` 的授权边界。

## P2 下一步意图（0 输入继续）

现状：`InvestigationRequestSchema.message` 必填 1–2000（`http-contracts.ts:15-17`），详情页要求非空文本（`investigation-detail.ts:93-98`）。

建议：

```ts
intent?: {
  kind: 'check_next' | 'compare_window' | 'retry_failed_check' | 'verify_recovery' | 'custom';
  recommendationId?: string;   // 来自上一结果 recommendations/缺口/失败检查
  parameters?: Record<string, string | number | boolean>; // 选择/数值，不接受任意脚本
};
```

- 服务端根据 `intent` 生成规范 `message`（若客户端未提供），并把 `intent` 与生成文本一并入库；`message` 保持必填，对旧调用完全兼容。
- `intent` 不允许扩大工具权限或跳过 `expectedVersion`/`continuationOf` 校验。
- “不清楚/跳过”映射为 `intent` 的可选缺口字段，不生成本轮检查。

## P3 三类复测结论

现状：行动报告有 `passed/failed/inconclusive`（`apps/db-ops-api/src/operations/contracts.ts:24`），调查只有 `problemStatus`（`contracts.ts:29-31`），无法记录“未改善/证据不足”。

建议新增调查反馈记录类型（不是修改 `problemStatus`）：

```ts
kind: 'recovery_retest';
verdict: 'recovered' | 'not_improved' | 'insufficient_evidence';
window: { from: string; to: string };      // 绝对时间
evidenceIds: string[];                      // 至少 1（insufficient 除外，需说明原因）
actionExecutionId?: string;                 // 可选：绑定执行
actionReportRef?: { id: string; version: number; hash: string };
note?: string;
```

- `recovered` 才可支持 `problemStatus=resolved` 的关闭；`not_improved`/`insufficient_evidence` 不得自动改变业务问题状态。
- 三类结论均为追加记录，保留历史；重复复测产生新记录，不覆盖。
- 与现有 `InvestigationRecoveryVerification` 并存：前者是人工确认绑定，本提案是“复测结论历史”，需要明确二者优先级与展示方式。

## P4 “需要你处理”投影

建议只读端点（或 `/api/investigations` 扩展）：

```ts
GET /api/investigations/attention?limit&cursor
→ { items: [{ kind: 'supplement'|'approval'|'verification', investigationId, title, reason, refId, updatedAt }], nextCursor }
```

- 仅投影三类原记录，不复制事件列表，不新增可写待办状态。
- 复用现有授权：无调查读权限不返回；审批项复用处室 `/approval` 的统一审批权限。
- 完成/失效后从投影消失；点击回到原记录。

## P5 交接摘要草案

建议只读生成（不调用模型）：

```ts
GET /api/investigations/:id/handoff[?resultVersion=]
→ { problem, impact, timeline[], conclusions[], gaps[], actions[], verifications[], nextOwner?, generatedFrom: { resultVersion, evidenceIds } }
```

- 全部字段来自现有记录，禁止模型生成新事实；用户确认后才可分享。
- 分享不扩大权限；敏感字段沿用现有脱敏与权限校验。

## P6 来源与返回位置

- `source` 元数据写入调查创建审计（事件/资源/指标/对话/手填 + 引用 ID）。
- `returnTo` 随创建/打开传递，用于旧入口返回；服务端或前端必须校验同源。
- 旧记录无该字段时返回列表，不伪造来源。

## P7 案例候选来源校验

现状已有 `sourceInvestigation`/`resultVersion` 查询参数与案例记录 `source`（`frontend/src/app/ui/views/operations-knowledge.ts:70-73,93,142`）。建议仅补：
- 服务端校验来源调查存在、调用者有读权限、`resultVersion` 属于该调查；
- 案例审核记录引用确切来源版本与脱敏人；
- 案例不得反向写入调查或改变调查状态。

## 协调请求

| 事项 | 需要 Chief 决定 |
|---|---|
| P1/P2 是否进入共享 HTTP 契约（`contracts:check` 影响） | 是；涉及生成 API/OpenAPI |
| P3 记录类型归属（investigations feedback vs operations） | 是；涉及 MAX-239 恢复判定语义 |
| P4 端点归属与权限 | 是；涉及审批模块 |
| P5 是否允许无模型生成 | 否（只读拼接），但需确认审计要求 |
| P6 `returnTo` 校验位置（前端/服务端） | 建议服务端 + 前端双重 |

本轮不实现以上任何一项；实现前需重新核对 MAX-238/239/240 的实际契约与基线。
