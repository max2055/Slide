# MAX-242 真实能力盘点

基线：`81cdcc92c8533a3c2f094528d79095cc55ec374e`。以下“已有”仅指当前分支代码与契约中可定位的实现；“可用”仍须真实配置、权限与业务数据验证。行号为该基线下的文件行号。

## 1. 调查对象、生命周期与三状态

| 项 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| 调查主体 | 资源（instance/server/network_device）或平台（component + 可选 releaseId） | `apps/db-ops-api/src/investigations/contracts.ts:20-24` | — |
| 调查生命周期 | `open/waiting/closed/archived` | `contracts.ts:26-28` | 界面仅显示徽章，无“是否可继续/归档原因”说明 |
| 执行状态 | `running/completed/failed/cancelled/timed_out/partial`，`partial` 可带 `resolution=outcome_unknown` | `contracts.ts:32-40` | — |
| 对外执行状态 | 追加 `queued`、`unknown` | `contracts.ts:42-44` | — |
| 业务问题状态 | `unconfirmed/in_progress/resolved/not_applicable` | `contracts.ts:29-31` | “未改善/证据不足”无独立枚举，见 §6 |
| 三状态并列展示 | 本次执行 / 调查进度 / 业务问题 | `frontend/src/app/ui/views/investigation-detail.ts:37-42` | 无“一句话现在怎样、谁该做什么”，状态下方仍是技术化结果区 |

调查列表目前只显示标题、资源/平台类型、生命周期（`frontend/src/app/ui/views/investigations.ts:207`），不显示主对象、当前进度、最近有效结论/阻塞原因与更新时间——这与设计要求的“继续工作”列表有明确差距。

## 2. Run、请求与结果版本

| 项 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| 创建调查即准入首个 Run | `POST /api/investigations` 需要 `Idempotency-Key`，202 返回 `requestId/jobId` | `apps/db-ops-api/src/investigations/routes.ts:81-106` | 创建时标题与目标均为必填（见 §4） |
| 创建入参 | `title`(必填)、`goal`(必填)、`profileId`、`subject`、`resourceRefs`、可选 `from/to`、可选 `sessionId` | `apps/db-ops-api/src/investigations/http-contracts.ts:9-14` | 无“来源/场景/关联证据/推荐下一步”的结构化字段 |
| 窗口校验 | `from/to` 成对、UTC 秒级、`from<to`、跨度不超过 Profile 上限 | `routes.ts:89-97` | 前端只提供 `datetime-local`，不显示时区/绝对时间摘要 |
| 继续执行 | `POST /api/investigations/:id/runs`，需 `message`(必填自由文本) 与 `expectedVersion` | `http-contracts.ts:15-17`、`routes.ts:149-155` | 无“点选有依据的下一步”结构化意图；全部依赖用户手写 |
| 部分结果继续 | `continuationOf` 绑定 `requestId/runId/resultVersion` | `http-contracts.ts:15-17`、`frontend/src/app/ui/controllers/investigations.ts:285-295` | 前端按钮仅在 `partial` + 版本一致时可点，属正确收紧；但没有解释“为何不可继续”的完整原因 |
| 结果版本 | `results` 列表按版本倒序，`GET /results?before&limit` | `routes.ts:139-143` | — |
| 结果结构 | 事实/假设/推断/反证/根因验证/缺口/建议/provenance | `contracts.ts:73-107` | 无“结论 vs 当前判断”的稳定字段；界面用 `summary` + facts 重组 |
| 结果读取兼容 | v1 AnalysisEnvelope / v2 InvestigationResult / legacy markdown | `contracts.ts:232-241` | 旧结果不回填证据绑定，符合兼容决定 |
| 断线与重放 | WS 快照 + 序列号 + `replay_required`；断线即清空内容并提示重连恢复 | `frontend/src/app/ui/controllers/investigations.ts:169-198` | 无离线提示“离开页面后可继续查看”以外的恢复进度说明 |
| 提交结果未知 | `pending` 保留原 body 与 idempotency key；`acceptanceUnknown` 锁定输入；`retryPending` 核对原请求 | `controllers/investigations.ts:96-97,249-256,257-279` | 创建/继续/取消三处共用机制，已具备；界面提示集中但可读性一般 |

## 3. 证据、审计与权限

| 项 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| 证据读取 | `GET /:id/evidence/:eid`，`raw=true` 遇到过期返回 410 `EVIDENCE_EXPIRED` | `routes.ts:131-138` | 界面只列来源/状态，缺“证据时效/采集质量/窗口”的可读摘要 |
| 证据过期 | 保留元数据与哈希绑定，清理原文 | `routes.ts:59-66`（保留策略） | 过期后如何影响结论与复测，界面没有分支说明 |
| 流事件 | `request.accepted/run.started/parts.operation/evidence.added/result.persisted/run.terminal/investigation.changed` | `contracts.ts:129-137` | 无“结构化补充请求/等待用户处理”事件 |
| 授权 | `chat:view`（平台调查另需 `config:view`）；写操作要求 operator（owner 或成员角色） | `apps/db-ops-api/src/investigations/authorization.ts:149,192-230` | — |
| 工具权限 | Profile allowlist + 实时 actor grant + 调查范围 + live tool policy | `contracts.ts:65-71`、`authorization.ts:265+` | 资源与平台调查不互相扩大，符合设计 |
| 审计 | 行动/审批/执行有独立记录；调查反馈带 actor/时间/版本 | `frontend/src/app/ui/components/investigation-feedback.ts:166-175` | 缺少调查级“交接/分享”审计入口（设计为后续项） |

## 4. 发起与少输入现状（关键缺口）

| 环节 | 现状 | 证据 | 与目标差距 |
|---|---|---|---|
| 创建标题 | 必填 `investigationTitle`，为空拒绝提交 | `frontend/src/app/ui/components/investigation-create.ts:131` | 目标：由来源/对象/场景生成，可改 |
| 创建目标 | 必填 `goal` 自由文本 | 同上；后端 `http-contracts.ts:9` | 目标：来源完整时必填自由文本 0 项 |
| 调查类型 | 下拉 `Ops（资源只读调查）/System（平台只读调查）` | `investigation-create.ts:173` | 目标：来源自动决定；自主发起用中文字段对象类型，不暴露 Profile |
| 资源选择 | 名称搜索 + 类型筛选 + 多选；截断时提示前 500 项；高级按 ID 补充 | `investigation-create.ts:14-72,175-181` | 目标：默认带入来源资源并标主资源；已选跨页保持；服务端搜索 |
| 时间范围 | 两个 `datetime-local`，可空，成对校验 | `investigation-create.ts:182` | 目标：事件/历史/资源带入绝对时间并显示时区；预设 15m/1h/24h |
| 继续排查 | 自由文本 textarea + 提交按钮，文本为空禁用 | `investigation-detail.ts:93-98` | 目标：推荐下一步可点选，生成可见请求文本；自由补充保留 |
| 结构化补充 | 无独立交互；反馈组件覆盖评分/外部处理/人工根因/恢复/关闭 | `investigation-feedback.ts:15,89-110` | 目标：补充用选择/数值/“不清楚”，不编造选项值 |
| 行动草案 | 手填结果版本(数字)、目标服务器(ID)、预计影响(自由文本) | `frontend/src/app/ui/views/operations-actions.ts:86-99` | 目标：从结果版本带入、目标从授权对象选择、影响由动作+范围+证据生成草案 |
| 审批绑定 | 计划打开时自动发现并带入审批号；仍显示“审批记录号”输入；备注必填 | `operations-actions.ts:59-62,136-139` | 目标：精确绑定服务端审批，常用理由可选，其他补文字 |
| 计划/报告查找 | 已有列表与分页；报告历史版本用数字输入 | `operations-actions.ts:86-95,234` | 目标：名称/对象/状态/时间列表为主，版本带时间与摘要 |
| 人工关联/拆分 | 自由文本“依据”必填 | `frontend/src/app/ui/components/investigation-operation-context.ts:100-104,123` | 目标：原因分类 + 现有关系/变更证据选择（后续增强） |

## 5. 行动闭环：计划、预检查、审批、执行、验证

| 项 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| 行动计划 | 不可变内容版本 + `contentHash` + 有效期；来源绑定 `investigationId/resultVersion` | `operations-actions.ts:119-134` | 草案创建仍依赖手填三项（§4） |
| 预检查/验证标准 | 计划含 `preconditions`、`verifier`（执行前/就绪/观察/间隔/额外重启上限） | `operations-actions.ts:127-129`；后端 `apps/db-ops-api/src/operations/contracts.ts` | — |
| 独立审批 | 作者/提交者不能自批；批准绑定当前版本与摘要；改版使旧批准失效 | `operations-actions.ts:135-139` | 审批入口分散在 `/approval` 与计划内，缺少统一“需要你处理”投影 |
| 显式执行 | 批准不自动执行；`execute` 需 `approvalId` + `requestKey`；未知不重发 | `operations-actions.ts:187-192,218-227` | — |
| 执行状态 | `queued/prechecking/dispatching/succeeded/failed/outcome_unknown/cancelled` | `apps/db-ops-api/src/operations/contracts.ts:23` | — |
| 效果报告 | 不可变报告 + 版本；`pending/observing/passed/failed/inconclusive` | 同上 `:24`；`operations-actions.ts:229-235` | 调查侧无对应的三类“恢复结论”字段（§6） |
| 结案/重开 | 人工关闭需验证；重开使旧确认失效 | `operations-actions.ts:204-208,237`；`investigation-feedback.ts:99-108` | 关闭仅一条 `problemStatus`，无“未改善/证据不足”记录类型 |

## 6. 恢复验证与审计边界

- 已有：`InvestigationRecoveryVerification`（method/窗口/证据/验证人/时间）与关闭校验；`resolved` 必须带验证（`contracts.ts:73-87,181-186`）。
- 已有：行动效果报告区分 `passed/failed/inconclusive`（`operations/contracts.ts:24`），可映射“恢复/未改善/证据不足”。
- 缺口：调查级没有独立的“未改善 / 证据不足”记录类型；当前只能通过 `not_applicable/unconfirmed` 或人工备注表达，无法形成可复测的三类结论历史。
- 已有：执行成功与业务恢复分开判断（`operations-actions.ts:219-232` 文案与绑定校验；`contracts.ts:181-186`）。
- 缺口：复测必须由“后续实际观测 + 明确窗口 + 副作用”构成，但行动报告是唯一结构化来源；资源/平台调查没有对应的复测记录入口。

## 7. 事件与自动上下文

| 项 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| 数据库告警→调查 | 手动/自动分流，`legacy` 与 `investigation` 两条 lane；同一告警有并发锁与历史去重 | `apps/db-ops-api/src/investigations/alert-bridge.ts:64-122` | 前端事件详情未展示“为何派生/未派生调查” |
| 告警上下文 | 从 `tags` 提取 `observed_from/observed_to/metric/value/threshold/quality`；窗口无效则退回发生时刻 | `apps/db-ops-api/src/investigations/resource-event-bridge.ts:23-47` | 不携带“返回位置”，事件→调查后无法一键回到原事件 |
| 平台异常→调查 | 组件/来源/原始事实持久化后再准入 | `apps/db-ops-api/src/investigations/system-event-bridge.ts:31-53` | `system-events` 仅在已有 `investigationId` 时显示“打开调查”（`frontend/src/app/ui/views/system-events.ts:58`），无自主“发起调查” |
| 预算/去重/冷却 | 服务端预算域、并发上限、每资源并发、自动请求/小时、日 token/成本 | `apps/db-ops-api/src/investigations/budget-configuration.ts:7-9,20-40`；`trigger-policy.ts:26` | 前端不展示“因预算/冷却未发起”的可读原因 |
| 查看不调模型 | 列表/详情/证据/刷新均为只读 HTTP；创建/继续才创建 Run | `routes.ts:107-174`；`resource-diagnosis.ts:251` 明示 | 尚无“打开调查详情不触发自动分析”的集中策略文案 |

## 8. 现有入口与历史

- AI 工作空间列表/详情：`/investigations`（`frontend/src/app/ui/navigation.ts:87`），深链接 `?investigation=`、`?resource=type:id`、`?query/state/profile`。
- 资源详情关联调查：`resource-investigation-links`（`frontend/src/app/ui/components/resource-investigation-links.ts:52-62`）。
- 跨资源诊断：`/resource-diagnosis`（`frontend/src/app/ui/views/resource-diagnosis.ts:295`），含当前证据/规则评估/关联资源/分析结果四页签与旧分析链接。
- 事件中心：`/events`，含活动告警/聚合事件/规则与策略/通知投递/平台异常（`frontend/src/app/ui/views/event-center.ts:7`）。
- 关注事项：`/attention`，实为告警事件列表（`frontend/src/app/ui/views/investigations.ts:237-334`），**不是**调查待办。
- 行动中心：`/operations-actions?sourceInvestigation=&resultVersion=`（`operations-actions.ts:50,126`）。
- 案例库：`/operations-knowledge?sourceInvestigation=&resultVersion=`（`frontend/src/app/ui/views/operations-knowledge.ts:93,142`）。
- 对话转调查：`chat-investigation-convert`（`frontend/src/app/ui/components/chat-investigation-convert.ts`）。
- 旧 AI 诊断：实例详情 `instance-diagnosis-modal`（`frontend/src/app/ui/views/instance-detail.ts:571`）、告警详情“开始分析”（`frontend/src/app/ui/components/alert-detail-modal.ts:117`）、历史 Analysis 只读兼容（`apps/db-ops-api/src/investigations/legacy-analysis-bridge.ts:23-40`）。

## 9. 盘点结论

1. **可复用的真实基础比设计文案假设的更完整**：三状态、结果版本、证据绑定、根因验证、idempotency/未知提交、审计、行动计划/审批/执行/效果报告都已存在。
2. **少输入的最大缺口集中在“输入契约”**：创建必须 `title+goal`，继续必须自由 `message`，行动草案必须手填结果版本/目标/影响，审批理由与证据 ID 均需手输。不是前端隐藏字段能解决，需契约层结构化上下文。
3. **“需要你处理”目前不存在**：`/attention` 是告警事件页，统一审批在 `/approval`，验证在调查详情内，三者没有投影到 AI 工作空间首页。
4. **跨资源诊断是独立门户**，与“取消独立跨资源诊断、共用调查框架”的目标冲突；应保留其只读证据能力与深链接，但把调查作为唯一持续工作载体。
5. **三类复测结论只到行动报告层**，调查层缺“未改善/证据不足”的结构化记录。
6. 以上缺口都需要在真实 P1 证据（MAX-238/239/240）可用后做真实闭环验收；本轮不宣称任何一项已通过业务验收。
