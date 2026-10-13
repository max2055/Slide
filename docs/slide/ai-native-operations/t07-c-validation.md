# T07-C：设置策略、预算与持久用量事实

## 范围与消费端口

本阶段 MAX-146 为 T06 设置页面提供三个版本化只读端口，保留 T07-A/B 和 T04 共验成果。不改变账本写事务、schema、认证、Session、executor 或 Run，不注册策略或启动自动调查，不请求外部模型。T03-D #161 为直接前置；开发基线 main `8108807af8dc1900b9beace9d83725b9ecbd482e`。托管起始 `a108d61d` 与用户修改保留，正常合入 main；产品 PR 从 main 单独承载本阶段变更，私有 `.multica` 和历史工作树差异不进入 PR。

|GET 路径|live 权限交集|事实来源|
|---|---|---|
|`/api/investigation-policies`|`ai:view`|当前生产组合的注册状态|
|`/api/investigation-budget`|`ai:view` 且 `config:manage`|既有 `investigationBudgetConfiguration()` 与正式 `investigation_budget_domains`|
|`/api/investigation-usage`|`ai:view` 且 `config:manage`|正式 `investigation_budget_ledger` 和冻结 domain 币种|

沿用正式 `createVerifyToken`：每次验证真实 JWT、active 用户、Session version、角色到期及权限。读服务在同一 SQL 事务用 `ActorContextService.loadInvestigationActorFrom` 再载 live 主体，并取当前权限与入口冻结 caller ceiling 的交集；身份失效返回 401、权限不足 403。服务身份不能交互登录，带 resourceBoundary 的委派主体不能读取全局治理事实。普通 `ai:view`、`config:view`、资源 read scope 或调查 share 都不能读取跨资源用量。既有 admin/通配符管理语义保留。

管理权限仅用于**全局汇总**。不返回调查/资源/request/单笔 reservation 标识、成员、服务主体、domain key、冻结 request/authority/Profile 原始快照、prompt 或事件内容。此接口不提供账本明细；将来明细必须沿调查授权覆盖全部必需资源 scope，不能借本汇总接口的权限绕过。鉴权完成后才执行汇总与分页，因此拒绝时没有 total、groupCount 或资源存在性信息。

成功、无效查询、认证/权限拒绝和存储失败响应均 `Cache-Control: private, no-store`，无 ETag。只注册 GET；无写方法。禁止调用方指定 actor/domain/policy/version/state/resource。错误仅发布固定 code，不输出 SQL、数据库名或秘密。数据库或有效配置不可读时为 503 `GOVERNANCE_UNAVAILABLE`，不会生成零用量假象。

## 策略事实

当前 main 的 `MysqlInvestigationEventIngest` 和 `TriggerBinding` 是可信内部 source-bound 服务端口，生产组合没有注册实例、预置配置加载器或启用开关。因此当前公开 `InvestigationPoliciesResponse` 返回 `configurationStatus=not_configured`、`integrationStatus=not_connected`、`source=production_composition`、`items=[]`，明确 `originBoundary=investigation_engine_persist_only`。此 origin 是内部已实现规则，不表示生产 hook 已连接。

不复制建议初始策略、测试 binding、历史事件/聚合或冻结账本配置来冒充已注册策略；本端口读取不产生任何注册行为。尚无真实注册事实，故不返回虚构的版本、资源范围、阈值、窗口、cooldown 或启用状态。生产桥接仍属 T08/T09/T10，未来接入时必须从实际可信注册源扩展此公开 schema 与投影。当前空数组类型为 `never[]`，T06 应展示“尚未配置/未接入”，不能硬编码演示策略。

## 有效预算事实

`InvestigationBudgetResponse` 投影现有加载器的 currency、全局并发、手动保留、每资源并发、自动每小时频率、自动/全部每日 tokens、每日成本额度、每执行 `reserveCostMicros`。保留既有环境加载 `INVESTIGATION_DAILY_COST_MICROS` 与 `INVESTIGATION_RESERVED_COST_MICROS`，不建立第二份配置或复制夹具参数。

`persistedPolicy` 是当前配置 domain 的正式冻结 admission 快照，未初始化为 null；`admissionStatus` 为 uninitialized/matching/conflict。matching 同时校验配置内容与 ledger 使用的 SHA256 policy hash；配置不匹配或冻结 hash 冲突不被描述为有效可 admission。读取不初始化 domain、不 reserve、不 repair 冲突。两个金额是额度，均不是供应商收费。无效额度/配置返回 503。

`window=UTC_admission_day_and_hour` 对应现有 admission 时间口径，unknown 跨日保留的 ledger 逻辑不变。`automaticTriggerStatus=not_connected`；Profile 的七项 frozen 上限从 `/api/investigation-profiles` 读取，`profileLimitsSource` 为该接口引用。本端口不宣称 Provider、设备或每个工具已经就绪。

## 用量、成本与分页

`InvestigationUsageResponse`：`window=all_history`、`accessScope=global_config_management`。不支持按事件、调查、主体、资源筛选，避免产生资源存在性探针。顶层 `total` 是全部持久 reservation 行数；`counts` 分别包含 reserved/sent/settled/unknown/cancelled。knownUsageCount 仅统计 usage_snapshot 非 null；unknownUsageCount 统计 unknown/settled 的缺 usage；pendingUsageCount 统计已 sent 未取得 usage。未发送 reserved/cancelled 的数量由对应 state 明示，不算 known usage。

`reservedTokens` 为历次预留 token 总额（含已取消/已结算）；`outstandingTokens` 为 reserved/sent/unknown 当前保留额度；`settledTokens` 为 settled 的已知 input+output。cachedInput 是 input 子集，不能再次加到吞吐。该统计是账本状态事实，不是运行状态或 Provider 成功计数。

`costs[]` 逐币种包含历史 `reservedCostMicros`、保守 `outstandingCostMicros` 和 `estimatedSettledCostMicros`。outstanding 包含 active reservation 的保留金额，以及已知 token 但缺费率的 settled 金额；estimatedSettled 只统计有费率且 cost_status=known 的 settled 金额。不同币种不合并。所有费用字段单位均是该币种的百万分之一；`costSemantics=rate_estimate_not_provider_invoice` 表明已结算费用仍是 frozen 配置费率估算，绝非供应商实际发票。

`items[]` 是按 currency/state/mode 分组的汇总，不是单笔账本。每项有 count、三个 usage 可用性计数、knownInputTokens/knownCachedInputTokens/knownOutputTokens 已知小计、相同 token/金额字段和 unknownCostCount。某组既有已知 usage 也有 unknown 时，已知小计的零或正值不能当作整组总使用量；必须同时呈现 unknown/pending 与保守保留额度。unknownCostCount 同时覆盖 unknown usage 和缺费率，不能以“known tokens”推断“known cost”。cancelled 的零扣款与未发送状态不冒充供应商返回零 usage。

分页仅接受 limit（默认20，1–50）和 offset（默认0，0–200000）。SQL 先在已鉴权事务中按 currency/state/mode 汇总所有组，再分页；`groupCount` 是组数，`nextOffset` 指向后续组，不能将 total 用作组分页长度。币种为严格三字符 ISO 风格代码，最多 17576 × 5 states × 2 modes = 175760 个理论组；正常平台只有少量配置币种。跨 HTTP 请求并发结算可能改变组和页，当前接口不提供跨请求快照稳定性。请求同一页的 totals 与 items 来自同一汇总 SQL，保持一致。

公开 schemas 注册到 `PublicApiSchemas`；OpenAPI 与 `frontend/src/api/generated/public-api.ts` 由 TypeBox 生成，没有手工维护另一份数据类型。T06 按授权展示事实，401/403/503 时清理旧缓存并显示相应失败/不可用状态；本后端验收不替代 T06 浏览器和 T12 全量 V1 gate。

## 验证与交接门禁

真实测试接入既有 `scripts/qualification/run-auth-boundary.sh`，由 CI recovery-qualification 执行；隔离 mysql:8.4、正式 MigrationRunner fresh/repeat、真实 ledger 写端口准备夹具、真实 JWT/TCP HTTP。普通 unit suite 无隔离端口时的 skip 不算此验收，最终 evidence 使用该真实 gate 的 0 skip 日志。

覆盖五种 ledger state、同组已知 usage/缺费率、unknown 保留、双币种、cached input 子集、重建读服务后持久恢复、先授权再计数/分页、同 JWT 撤权/恢复、角色删除/到期、用户禁用/Session 撤销、服务禁登录、bounded/caller ceiling、只读方法、非法查询和 SQL 注入、存储失效、无效配置与冻结 hash 冲突。读前后逐表完整行值比对包括 ledger/domain/resources/request/investigation/chat/job/outbox/events，证明没有读侧写入。夹具不执行 Workflow 或 Provider。

独立父 Review 为合并前置；本阶段提交准确 head CI 后停 in_review，不能自行把父验收或 V1 全量 gate 标为通过，不能启动其他 phase。无新增外部模型请求、生产操作、新设施、Issue 或子代理；T04 累计 5/6 停发预算不转授。实际 agent token/费用遥测不可用，无硬预算。

### 本地最终证据

|命令 / 检查|结果|
|---|---|
|`bash scripts/qualification/run-auth-boundary.sh`|9 文件、183 项通过、0 skip；新增11项真实MySQL/JWT/HTTP及1项公开契约；隔离容器与测试数据库收尾|
|调查账本/策略/契约/executor/result/evidence/stream 与公开 API 模块 focused run|8 文件、91 项通过、0 skip；不将此 unit gate 当作真实 SQL 证据|
|`pnpm security:test`|35 文件、334 项通过、0 skip；授权负例另由真实SQL gate验证|
|前后端 typecheck、`contracts:check`、`security:scan`、`qualification:matrix`|通过|
|全仓 lint|0 errors，263 既有 warnings；新增四个源码/测试文件0 warnings/0 errors|
|`git diff --check`|通过|

初始 RED 为新增 SQL 夹具缺冻结 Profile/hash、快照表名错误，均修正为正式迁移与 ledger 契约；TypeBox Value 的 UUID format 未注册，改用与现有调查契约一致的明确 pattern。公开操作清单同步三个新增 GET。分页调整误触夹具费率后恢复，最终164 micro估算断言通过。没有修改产品授权、schema 或写路径来放宽测试。

最终代码 hash、准确 PR head/CI 与本地真实日志随 Issue 单次交付附上，父审查和普通 merge/main 包含证明仍是后续验收项。先前 A/B 已合并证据不被本阶段覆盖。
