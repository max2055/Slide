# MAX-242 旧入口与深链接兼容表

原则：取消**独立**跨资源诊断主线、把调查作为持续载体，但既有页面、深链接与历史记录必须继续可用；不因新入口删除旧入口，不新增运维工作台。表中的“本轮处理”均为设计要求，本轮未改产品代码。

## 1. 页面与路由

| 旧入口 | 当前实现与深链接 | 本轮保留 | 设计要求 | 兼容风险 |
|---|---|---|---|---|
| AI 工作空间 | `/investigations`；`?investigation=<id>`、`?resource=type:id`、`?query/state/profile` | 保留为唯一调查入口 | 新增发起区、需要你处理、继续列表；`?investigation` 仍直达详情 | 现有筛选参数语义不变 |
| 关注事项 | `/attention`：告警事件列表（非调查待办） | 保留 | 不改成调查待办；“需要你处理”不替代它，仅引用原调查/审批/验证 | 若改造为待办会改变既有语义，禁止 |
| 事件中心 | `/events`，含 `?view=active/aggregate/rules/notifications/system` | 保留 | 事件详情新增“发起/打开调查”，携带对象、窗口、来源与返回位置 | 旧 `view` 参数必须继续生效 |
| 平台异常 | `/events?view=system`（`system-events-page`） | 保留 | 无调查时可发起调查；有 `investigationId` 时“打开调查”保留 | 不与事件中心重复建状态 |
| 跨资源诊断 | `/resource-diagnosis`（当前选择资源 + 四页签：当前证据/规则评估/关联资源/分析结果） | 保留只读证据浏览 | 不再作为独立诊断主线；新增“带入 AI 调查（对象/窗口/返回位置）”；旧分析结果只读兼容 | 删除页面会破坏深链接与历史证据入口 |
| 资源详情（库/服务器/网络设备） | 详情内 `resource-investigation-links` → `/investigations?resource=type:id`、`?investigation=` | 保留 | 新增“发起调查（常见场景）”入口；关联调查列表保留 | 多个详情页共用组件，改一处需回归三类资源 |
| 实例 AI 诊断弹窗 | `/` 实例详情 → `instance-diagnosis-modal`（旧 `ai_analysis`） | 保留历史查看 | 不补跑旧分析；新入口引导调查；`legacy-analysis-link` 只读兼容 | 旧 result 的 owner/权限不可被新调查替代 |
| 告警详情“开始分析” | `/alerts` → `alert-detail-modal`（旧触发） | 保留 | 语义不变；是否派生调查继续由服务端 lane 决定（legacy/investigation） | 前端直接改走调查会绕过既有锁/去重/预算 |
| 行动中心 | `/operations-actions`；`?plan=`、`?sourceInvestigation=`、`?resultVersion=` | 保留 | 草案从来源结果带入；旧的打开计划入口保留 | 手输计划 ID 保留为高级入口 |
| 案例库 | `/operations-knowledge`；`?sourceInvestigation=`、`?resultVersion=` | 保留 | 从确切结果版本整理候选；旧的查看来源调查链接保留 | 案例不得反写调查事实 |
| 统一审批 | `/approval` | 保留 | 审批详情引用计划版本；调查/首页投影同一记录 | 不复制审批状态 |
| 审计中心 | `/audit` | 保留 | 调查/行动/执行审计关联展示 | 不新增第二套审计 |
| 报告 | `/reports` | 保留 | 报告不是调查真相源；调查结果版本与报告版本分别展示 | 不合并两套版本号 |
| SQL 审计 AI 分析 | `/sql-console` 审计页（`ai_analysis`） | 保留 | 用户操作来源，可显式转为调查；不自动并入 | 旧记录归属原 principal |
| 对话 | `/chat`；“转为调查”按钮 | 保留 | 原对话作来源引用；工作空间成为后续唯一入口 | 不复制两套执行会话 |

## 2. 深链接参数契约

| 参数 | 位置 | 语义 | 本轮要求 |
|---|---|---|---|
| `investigation` | `/investigations` | 直达指定调查 | 保持；无效/无权时显示明确空态，不静默回列表 |
| `resource` | `/investigations` | 按资源过滤（可多值） | 保持；多值合计不得伪造全局总数 |
| `query/state/profile` | `/investigations` | 名称搜索/生命周期/Profile 过滤 | 保持；新增“类型/场景”筛选不得改写旧参数 |
| `plan` | `/operations-actions` | 打开计划 | 保持 |
| `sourceInvestigation` + `resultVersion` | `/operations-actions`、`/operations-knowledge` | 行动草案/案例候选来源 | 保持；改为带入而非要求手输 |
| `view` | `/events` | 事件中心子页签 | 保持五个旧值 |
| `tab`/`id`/`networkDeviceId` | `/` | 资源详情定位 | 保持（`resourceDetailUrl` 现有映射） |

**返回位置**：新增统一 `returnTo`（同源相对 URL + 必要视图状态）随调查创建/打开传递；返回时恢复原页面与筛选。`returnTo` 必须校验为站内路径，禁止外部跳转；无权时回退到 AI 工作空间列表并说明。

## 3. 历史兼容

- 旧 `ai_analysis` 结果：只读展示，不补跑、不重绑证据；新调查可引用其记录链接，但不把旧结论改写成当前事实（现有 `LegacyAnalysisBridge` 语义）。
- 旧结果 v1（AnalysisEnvelope）与 legacy markdown：继续按 `readInvestigationResult` 兼容读取。
- 旧调查记录：`legacyAnalysis` 字段继续展示；关闭/归档状态不因新设计自动改变。
- 旧审批/执行记录：保留原版本与内容摘要，不因计划列表改版而失效。

## 4. 迁移顺序（建议后置到实现阶段）

1. 先加“来源带入 + 返回位置”，各旧入口改为带上下文跳转（不删页面）。
2. 再给 `/resource-diagnosis` 增加“带入 AI 调查”，把调查作为持续入口。
3. 再把 `/attention` 与首页“需要你处理”并列，验证不产生第二套待办。
4. 最后评估是否隐藏旧诊断入口的“新建”按钮；删除页面与非兼容参数变更不在首版。

任何一步都不允许：删除旧深链接、改变 `?investigation` 语义、把事件列表复制进工作空间、或让旧 AI 诊断绕过调查直接执行变更。
