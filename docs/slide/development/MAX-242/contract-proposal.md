# MAX-242 跨模块契约提案（交 Chief 协调，本轮不改代码）

本文件只提出实现阶段需要的共享契约变更，供 MAX-235/Chief 评估与分配。**本轮未修改任何生产契约、生成 API/OpenAPI、共享组件或 investigations 代码**；以下“提案”不代表已实现。契约以执行时 main（本轮参考 `e11f6ba2e`）和 P1 合并后的实际代码为准，不引用 81cd 起点的过时行号。

## 0. 先区分：UI 派生文本 vs 真正需要持久化的扩展

零必填自由文本不等于必须改现有 `title/goal/message` 必填契约。有依据的客户端/服务端生成文本同样可以满足现有 schema。

| 类别 | 例子 | 是否必须改共享契约 | 说明 |
|---|---|---|---|
| UI 派生文本（不持久化新字段） | 由来源事实拼接的标题“对象 + 现象 + 时间”、目标句、推荐下一步生成的请求文本 | 否 | 只要最终提交满足现有 `title/goal` 长度/非空规则，生成方式属于 UI/客户端行为；生成依据应可回看，但不要求为新文本单开执行接口 |
| 需要持久化/审计的来源元数据 | `source.kind/ref`、`returnTo`、场景注册表条目版本、推荐项 ID | 视实现 | 若仅用于审计/回跳，可先写入审计或可选元数据；只有服务端需要据此校验/投影时才进入 HTTP 契约 |
| 需要结构化校验的意图 | 继续执行的 `intent`（下一步/比较窗口/重试失败项） | 是（P2） | 需要与 `expectedVersion`/`continuationOf`/权限一起校验，不能只靠客户端拼字符串 |
| 调查级三类复测记录 | `recovery_retest` | 是（P3） | 现有 `problemStatus` 语义不足以表达“未改善/证据不足” |
| 只读聚合投影 | “需要你处理” | 是（P4） | 引用原记录，不建第二套状态 |
| 交接草案 | 从记录生成 | 视产品决定（P5） | 可先纯前端拼接；若要服务端生成，需确认审计要求 |

结论：**P1 的大部分“少输入”可通过 UI 派生文本 + 现有 schema 达成**，不应为生成标题/目标另造执行接口。只有来源/返回位置/结构化意图等需要服务端校验或持久化时才扩展。

## 提案一览

| # | 提案 | 影响模块 | 兼容策略 | 依赖 |
|---|---|---|---|---|
| P1 | 创建调查的来源上下文（可选元数据），标题/目标可由 UI 派生 | `investigations/http-contracts.ts`、`routes.ts`、前端创建组件 | 标题/目标仍按现有规则必填；来源字段可选；旧客户端不变 | — |
| P2 | 继续执行接受结构化下一步意图 | `InvestigationRequestSchema`、`continuation`、详情页 | **校验前归一化**：服务端把 `intent` 转为规范 `message`，再走现有必填校验；旧调用完全不变 | — |
| P3 | 调查级三类复测结论 | `contracts.ts`（feedback/close）、审计、详情页 | 新增追加记录类型；不改 `problemStatus` 枚举语义 | MAX-239 恢复判定 |
| P4 | “需要你处理”投影查询 | 新增只读聚合端点或既有列表扩展 | 只读投影，不建第二套状态；引用原记录 ID | 审批/调查/验证 |
| P5 | 交接摘要草案 | 新增只读生成端点（不调模型） | 从记录生成；权限沿用原调查 | — |
| P6 | 来源与返回位置 | 调查记录新增可选 `source`/`returnTo` 元数据 | 可选字段；站内相对 URL 校验 | 旧入口改造 |
| P7 | 案例候选来源 | `operations-knowledge` 契约 | **已存在**来源授权/closed/最新结果/有效证据校验，复用即可；不重复实现 | — |
| P8 | 授权观测记录与报告精确绑定 | `investigations`、`operations` 报告/验证、审计 | 新增只读观测授权记录（或复用执行/验证记录的既有字段）；报告保存时服务端按稳定身份校验来源/执行/调查/范围/窗口/证据；不改变既有报告 schema 语义 | MAX-238/239/240 的 P1 证据与窗口语义 |

## P1 结构化创建上下文（标题/目标仍由 UI 派生）

现状：`InvestigationCreateRequestSchema` 要求 `title`(1–200) 与 `goal`(1–2000) 非空（`apps/db-ops-api/src/investigations/http-contracts.ts:9-14`，81cd）；前端同样强制。**这不要求改 schema**：事件信息完整时，客户端可由对象 + 现象 + 绝对时间生成标题与目标，满足现有必填规则。

只有以下信息在实现阶段需要决定是否持久化/校验：

```ts
// 可选来源元数据；不替代现有 title/goal
source?: {
  kind: 'event' | 'resource' | 'metric_history' | 'platform_exception' | 'chat' | 'manual';
  ref: string;                                      // EVT-* / resource key / metric id / SYS-*
  observedFrom?: string; observedTo?: string;       // 绝对时间（UTC 秒级，前端显示 +08:00）
  returnTo?: string;                                // 同源相对 URL
};
scenario?: { id: string; version: number };          // 场景注册表条目
generated?: { title: boolean; goal: boolean };       // 审计标记；不改变必填校验
```

约束与样例：

- 有效：`{title:"[样例] mysql-order-01 · 连接异常 · 10:31", goal:"排查 …（+08:00）…", source:{kind:"event",ref:"EVT-8821",observedFrom:"2026-10-26T02:16:04Z",observedTo:"2026-10-26T02:46:04Z",returnTo:"/events?view=active&event=EVT-8821"}}` → 201/202。
- 无效：`title` 为空、`goal` 全空白、`returnTo:"https://evil.example"`、`source.kind` 未知、`observedFrom>=observedTo` → 400/422，不静默使用占位句。
- 兼容：旧客户端只传 `title/goal` 仍有效；来源字段缺失时审计记录为“未提供”，不回填伪造来源。
- 平台来源：`kind:"platform_exception"` 只带组件/平台异常引用，不携带资源工具权限或资源证据。

## P2 下一步意图（0 输入继续）：明确选择“校验前归一化”

现状：`InvestigationRequestSchema.message` 必填 1–2000（`http-contracts.ts:15-17`）；HTTP schema 在路由前拒绝缺失 `message`。因此**不能同时声称“message 保持必填”和“未提供由服务端生成”而不说明边界**。

本提案选择 **方案 A：校验前归一化（推荐）**：

```ts
intent?: {
  kind: 'check_next' | 'compare_window' | 'retry_failed_check' | 'verify_recovery' | 'custom';
  recommendationId?: string;   // 来自上一结果 recommendations/缺口/失败检查
  parameters?: Record<string, string | number | boolean>;
};
```

- 路由在 schema 校验**之前**执行 `normalizeIntentToMessage(intent, latestResult, expectedVersion)`；生成规范 `message` 后按现有 `message` 必填/长度规则校验并入库；`intent` 与生成文本一并保存用于审计。
- 旧客户端仍必须提供 `message`；新客户端可只提供 `intent`。两条路径最终都满足同一 `message` 约束，不另建执行接口。
- 不采用“新 union schema”：它会让旧校验路径与错误码分叉，且现有鉴权/幂等/版本逻辑都以归一化后的 body 为输入。

边界样例（实现阶段需有对应测试）：

| 场景 | 请求 | 期望 |
|---|---|---|
| 有效：点选推荐下一步 | `intent:{kind:"check_next",recommendationId:"n1"}` + `expectedVersion:2` + `Idempotency-Key:k1` | 归一化出非空 `message`；202；`intent` 与文本入库 |
| 有效：旧客户端 | `{message:"比较 10:05 前后连接曲线"}` + 同版本/同一 key | 202；行为不变 |
| 无效：两个都缺 | 无 `message` 且无 `intent` | 400 `MESSAGE_REQUIRED`（归一化后仍缺） |
| 无效：未知推荐项 | `recommendationId` 不属于该结果/缺口 | 422/409，不生成猜测文本 |
| 幂等：同 key 重放 | 同 body + 同 `Idempotency-Key` | 返回同一 `requestId/runId`，不创建第二个 Run |
| 版本过期 | `expectedVersion` 小于当前结果版本 | 409 `VERSION_CONFLICT`，不静默用最新结果改写意图 |
| 推荐项失效/过期 | 推荐来自已过期证据或旧版本 | 409/422，要求基于当前版本重新选择 |
| 撤权 | 调用者失去该调查/工具权限 | 403，不生成 `message`、不创建 Run |
| 自定义意图 | `kind:"custom"` 但无合法文本/参数 | 400，不把空意图归一化为占位执行 |

`intent` 不允许扩大工具权限、跳过 `expectedVersion`/`continuationOf`、跳过预算/去重/冷却，也不改变未知提交只核对原请求的语义。

## P3 三类复测结论

现状：行动报告有 `passed/failed/inconclusive`（`apps/db-ops-api/src/operations/contracts.ts:24`），调查只有 `problemStatus`（`contracts.ts:29-31`），无法记录“未改善/证据不足”。

建议新增调查反馈记录类型（不是修改 `problemStatus`）：

```ts
kind: 'recovery_retest';
verdict: 'recovered' | 'not_improved' | 'insufficient_evidence';
window: { from: string; to: string };                 // 绝对时间，含日期/时区
evidenceIds: string[];                                // 只能来自报告/后续观测已有证据
actionExecutionId?: string;                           // 可选：绑定执行
actionReportRef?: { id: string; version: number; hash: string; validUntil: string };
note?: string;
```

- `recovered` 才可支持 `problemStatus=resolved`；且必须报告通过、证据完整、未过期；`not_improved`/`insufficient_evidence` 不得自动改变业务问题状态。
- 三类结论均为追加记录；重复复测产生新记录，不覆盖。不得制造报告里不存在的证据（报告只有 EV-11 时不能写入 EV-12）。
- 无行动调查也可创建该记录（`actionExecutionId` 为空），依据后续实际观测；不得强制每项都执行变更。
- 与现有 `InvestigationRecoveryVerification` 并存；需明确二者优先级与展示顺序，不能出现两套互相覆盖的状态。

## P4 “需要你处理”投影

```ts
GET /api/investigations/attention?limit&cursor
→ { items: [{ kind: 'supplement'|'approval'|'verification', investigationId, title, reason, refId, updatedAt, actionable: boolean }], nextCursor }
```

- 仅投影三类原记录；`actionable` 按当前用户角色/权限计算，明确“你可处理/仅可查看”，不复制事件列表，不新增可写待办状态。
- 复用现有授权：无调查读权限不返回；审批项复用统一审批权限；完成/失效后消失；点击回到原记录。

## P5 交接摘要草案

```ts
GET /api/investigations/:id/handoff[?resultVersion=]
→ { problem, impact, timeline[], conclusions[], gaps[], actions[], verifications[], nextOwner?, generatedFrom: { resultVersion, evidenceIds } }
```

- 全部字段来自现有记录，禁止模型生成新事实；用户确认后才可分享。
- 分享不扩大权限；敏感字段沿用现有脱敏与权限校验。

## P6 来源与返回位置

- `source` 元数据写入调查创建审计（事件/资源/指标/平台异常/对话/手填 + 引用 ID）。
- `returnTo` 随创建/打开传递，用于旧入口返回；服务端与前端双重校验同源；旧记录无该字段时返回列表，不伪造来源。

## P7 案例候选来源：复用现有校验，不重复实现

准确 head 的 `apps/db-ops-api/src/operations/knowledge/store.ts:153–183` 已执行：

- 调查读取授权（`authorize(..., 'content')`）；
- 调查必须 `closed` 且无 `active_request_id`；
- `resultVersion` 必须等于该调查当前最新结果版本（子查询 `MAX(version)`）；
- 结果体校验、证据引用非空且 ≤100、provenance 完整（model/prompt/tool 版本非 unknown/unavailable、runtimeRunId 匹配）；
- 每条证据属于同一 `investigation_id/request_id/run_id`、未过期，并再次按证据资源范围授权；
- 资源范围与结果资源一致且 1–100 条。

因此 P7 **不需要新增“来源校验能力”**。实现阶段应直接复用该路径；若产品确实需要放宽到历史结果候选（非最新版本），必须作为**明确兼容决定**交 Chief，并单独证明授权/证据有效性不被放宽，不能在本任务中无意修改。

## P8 授权观测记录与报告精确绑定（复测结论的来源约束）

现状：行动效果报告的 `passed/failed/inconclusive`（`apps/db-ops-api/src/operations/contracts.ts:24`）只说明机器观测结论；调查层缺少“这条报告属于哪个调查/哪次执行/哪段授权观测范围与窗口/引用了哪些既有证据”的服务端事实。仅靠报告字段非空判断会让跨对象、跨执行、跨调查的报告或同 id/version/hash 的内容替换被误当成有效复测依据（见原型 B1–B8/P1–P5 负例）。

提案：保存复测结论时，服务端从**授权观测记录**派生期望绑定并校验报告，而不是相信报告自报的来源字段。

```ts
// 只读派生记录；由“本次执行成功”或“后续观测被授权”时的既有记录生成
type ObservationAuthorization = {
  id: string;
  investigationId: string;
  source: 'action_effect_report' | 'follow_up_observation';
  executionId: string | null;         // 后续观测为 null
  scope: string[];                    // 稳定身份（type:id），平台组件可含 shard 子对象
  window: { from: string; to: string }; // 绝对时间（含时区）
  evidence: Record<string, { object: string; window: { from: string; to: string }; source: string }>;
  validUntil: string;
};

// 保存复测结论（recovery_retest）时的服务端校验
POST /api/investigations/:id/retests
{ verdict, reportRef: { id, version, hash }, note?, expectedVersion, idempotencyKey }
→ 校验：来源枚举与授权一致；
        action_effect_report.executionId === 本次执行，investigationId === 当前调查；
        follow_up_observation 不得携带 executionId；
        report.object ∈ authorization.scope（按稳定身份，禁止用显示名称比较）；
        report.window ⊆ authorization.window；
        report.evidence ⊆ authorization.evidence 且证据对象/时间在授权范围内；
        报告不可变：内容摘要与登记内容一致，同 id/version/hash 不可替换；
        报告改版后必须重新选择结论（客户端显式确认，服务端以 expectedVersion/快照校验）。
→ 任一不符返回 409/422，不写入复测记录、不改 problemStatus、不自动关闭事件。
```

约束与说明：

- 授权记录以既有执行/验证/证据记录派生，**不新建第二套观测状态**；若 P1 已提供等价事实则直接复用。
- 稳定身份必须来自资源目录，不用显示名称；行动目标与观测对象可以不同（例如行动目标是 `server:7`，授权观测在 `instance:12`），平台组件授权范围包含其 shard 子对象。
- 证据只允许引用授权记录中的既有证据；不接受“报告里新增 EV-12”这类凭空补证。
- 报告内容摘要由报告内容计算；`id/version/hash` 相同的报告必须内容一致，否则拒绝。
- 这是一条**公开契约变更**：实现前需 `contracts:check`、前端 typecheck/build 与真实业务/浏览器验收；本轮只提案，原型仅演示交互。

## 协调请求

| 事项 | 需要 Chief 决定 |
|---|---|
| P1 是否持久化 `source/returnTo/scenario`，还是仅写审计 | 是（涉及可选契约字段与迁移） |
| P2 是否接受“校验前归一化”方案（而非 union schema） | 是；涉及 `contracts:check` 与错误码 |
| P3 记录类型归属（investigations feedback vs operations） | 是；涉及 MAX-239 恢复判定语义 |
| P4 端点归属与权限 | 是；涉及审批模块 |
| P5 是否允许无模型生成 | 否（只读拼接），但需确认审计要求 |
| P6 `returnTo` 校验位置（前端/服务端） | 建议服务端 + 前端双重 |
| P7 是否允许历史结果候选 | 默认否；如需要，另行明确兼容决定 |
| P8 授权观测记录归属与是否复用 P1 既有事实 | 是；涉及 `contracts:check`、`investigations`/`operations` 边界与 MAX-239 恢复判定 |

本轮不实现以上任何一项；实现前需重新核对 MAX-238/239/240 的实际契约与基线。
