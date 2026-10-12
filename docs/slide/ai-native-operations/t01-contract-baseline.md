# T01 契约与基线实施记录

> **Execution:** 按 MAX-142 的 baseline-only 授权执行；复用已批准的 V1.1 方案和 R00 矩阵，不放行未决领域、不派生代理。

**Goal:** 固定可复用、可验证的调查契约及 40 样本索引。

**Architecture:** TypeBox 是新契约的唯一 schema 源；现有 contracts 管线生成 OpenAPI components 与浏览器类型，暂不声明调查 HTTP routes 已实现。纯校验函数拒绝非法状态、引用和关闭依据；权限解析、持久化、工具执行及业务状态更新由后续责任任务实施。

**Tech Stack:** TypeScript、TypeBox、Vitest、pnpm 11.19.0。

## 实施步骤与验收

1. 新增 `apps/db-ops-api/src/investigations/contracts.test.ts`，先运行确认新模块缺失。覆盖 resource/platform union、三层状态、未知结果、错误码、UTC 窗口、事件及 Profile 上限、v1 原样读取、证据引用/关闭依据与普通 read share 不授 append。
2. 新增同目录 `contracts.ts`：纯 schema 与校验。保留六态 Run；queued 只属于 admission/job。Parts payload 直接引用共享 ProjectionFrame，校验复用 `validProjectionFrame`。有证据 ID 不代表当前用户可访问；校验引用使用服务器传入的当前调查可见/未过期 ID 集合，不能信任模型提供的集合。
3. 扩展 `src/contracts/public-api.ts`、`generate-public-api.ts`，用同一 schema 生成新增类型，运行 `pnpm contracts:generate`、`pnpm contracts:check`、前后端 typecheck 及 public-api tests。旧 schema 和路径保持兼容。
4. 在 `docs/slide/ai-native-operations/evidence/t01-samples.json` 冻结 12/6/6/8/8 的 40 样本，每例有合成脱敏快照、允许事实、支持/反面证据、不可宣称结论、下一步、硬安全项及后续 owner。索引是 T11 runner 的输入，不冒充模型评估结果。
5. 本文件记录生产位置、R00 confirmed/pending → 契约负例/文件 owner/后续测试映射；另交 `t01-validation.md` 记录当前源码的分类结果。指定验收命令为 `pnpm --filter slide-api exec vitest run src/investigations/contracts.test.ts src/analysis/analysis-envelope.test.ts src/adapter/__tests__/agent-run-service.test.ts`。
6. 运行直接相关 Chat、Analysis、告警、Workflow 与前端现有测试建立基线。既有失败只分类；不修改其他任务模块。提交独立 main PR，收集当前 head CI/审查并正常合并后验证 main 包含 merge SHA。权限/人工 Review 阻塞则交付具体证据，不宣称完成。

停止条件：契约、样本、位置及分类验证材料可审阅并经过 PR 门禁；新调查真实 MySQL/provider/WS/浏览器业务验收归 T02–T12，T01 不替代。

## 契约使用边界

`contracts.ts` 的 `InvestigationSchemas` 是生成源；公开文档只增加 components，不新增尚未实现的 HTTP 路径。新客户端类型由 schema 渲染，Parts 使用现有 `ProjectionFrame` 类型及 `validProjectionFrame` 校验；其 OpenAPI payload 的 `x-typescript-type` 明示共享运行时校验，JSON shape 校验不能替代它。

后续入口必须调用语义校验，不能仅调用 `Value.Check`：它只检查 shape，不能证明日期有效、窗口顺序、引用归属、终态不可改写或 resolved 依据。`validateInvestigationRunTransition` 仅供已有 Run owner 使用，不写库、不持有状态；partial/outcome_unknown 的终态不能改为 completed。修复 staging 仍由既有 Run owner 在 running 时完成。

`validateInvestigationResult`/`validateInvestigationClosure` 接受的 evidence ID 集合必须由服务器从当前调查、当前授权和未过期快照取得；默认空集拒绝绑定引用。方法、窗口、确认人和确认时间的格式/引用有效不代表业务真相；确认人及验证记录来自授权的人类/实验服务事实，模型不能用这两个函数自授确认权限。`bound` 仍只属于旧 envelope 的引用绑定，不能转为 rootCauseVerification=verified。V1 读取返回原对象，不补造新 facts、confidence 或根因验证；Markdown 只作 legacy 视图。

Profile 固定 `system`/`ops` 分支，使用现有 `chat/sql_analysis/fault_diagnosis/health_check` 场景路由，拒绝任意场景、凭据和通配工具。必须有有限正整数预算及只读约束；工具名在 allowlist 中仍不等于工具安全，T03/T04 须实施实时交集、SQL boundary、输出/时间/host 限额。T01 的权限常量是执行合同，尚非 live authorizer。服务主体不能继承 admin，普通 Chat read share 不授 append，多资源调查必须覆盖全部必需 scope。

## 现有数据生产位置

以下定位对应 main `730b0bc1564efd72c21066d73e560db28288e434`（R00 仅增加材料/规则；源码仍等同 Review `fb0766d6`），不是新调查链路已可用的声明。

|链路|生产 / 持久化位置|现有事实与后续 owner|
|---|---|---|
|普通 Chat 输入/运行|`apps/db-ops-api/src/adapter/direct-adapter.ts:587` chat.send；`adapter/agent-run-service.ts:20` claim、`:53` complete、`:77` recoverCompletion|Chat 的 WS/session 锁及六态 Run；T04 增加调查受限委托，T06 继续观察|
|Chat 消息|`apps/db-ops-api/src/chat-database-service.ts:131` createSession、`:279` addMessage；`adapter/agent-run-service.ts:107` 完成消息事务|chat_sessions/chat_messages；owner/read-share 边界不放宽；T03 提供窄 append，T05 复用持久化|
|Parts 事实/展示|`adapter/canonical-store.ts`、`adapter/message-projection.ts:72` observe；`packages/agent-core/src/message-projection.ts:23` ProjectionOperation|唯一共享 Parts/reducer，T05 处理事实版本；不新造工具状态|
|Analysis 入队|`apps/db-ops-api/src/ai-agent-bridge.ts:103` dispatchOrReuse→enqueue；`analysis/analysis-dispatch-store.ts:110` admission 事务|ai_analysis + analysis_dispatches/attempts + outbox_events/workflow_jobs；快照、配置及授权版本冻结；T08 保留单执行 owner|
|Analysis 执行/完成|`analysis/analysis-dispatch-handler.ts:37` engine.invoke；`analysis/analysis-dispatch-store.ts:218` completeEnvelope；`adapter/direct-adapter.ts:1305` runInvoke|旧后台仅 analysis completion 工具；v1 schema 不接收 platform；T04 新入口不扩权旧 invoke|
|旧 Analysis 记录|`apps/db-ops-api/src/ai-analysis-database-service.ts:75` createAnalysis、`:126` updateStatus；`analysis/analysis-envelope.ts`|旧状态含 unknown，结果原样读取；T08 实施只读兼容和唯一 link|
|数据库告警|`apps/db-ops-api/src/alert-evaluator.ts:335` evaluateAllRules；`alert-engine.ts:100`/`:286` 调度/创建；`alert-database-service.ts:110` createAlert|写 alerts；T08 接统一调查，不双发模型|
|服务器告警|`apps/db-ops-api/src/server-alert-evaluator.ts:71` evaluateServerRules、`:203` createAlert；`alert-engine.ts:173` 调度|同一 alerts 表，以 target_type/server_id 定位；T10 接入口/真实夹具|
|网络告警|`apps/db-ops-api/src/network-devices/network-device-alert-evaluator.ts:154` evaluateNetworkDeviceRules、`:312` persistAlert；`alert-engine.ts:193` 调度|同一 alerts 表，以 network_device_id 定位；缺采集不等于正常/宕机，T10 验证|
|平台观测|`apps/db-ops-api/src/platform/runtime-events.ts`、`structured-log-evidence-adapter.ts`、`platform-observation-service.ts`|进程内日志/队列观测不是 operational_events 持久存储；T07/T09 保留 occurrence/origin 和版本证据|

## R00 确认发现 → 契约负例、文件所有权及后续证据

未重开 Review 或重复实施修复；[R00 矩阵](review-alignment.md) 与 [逐项账本](evidence/candidate-ledger.json) 继续作为准入源。

|发现 / 门禁|T01 合同及负例 / 样本|唯一修复 owner / 后续真实验证|
|---|---|---|
|FINAL-0026，blocked|503 QUEUE_UNAVAILABLE 表示未接受；request.accepted 只引用已提交 job；T01 不 mock 事务释放成功|T02 / outbox-service.ts，begin 失败释放复现；T04/T07 消费修复|
|FINAL-0300，blocked|event source/sourceEventId 与 request/job 稳定 ID；同一事件不得重投计数|T02→T07 / outbox-service.ts；真实 MySQL 重复 append 返回实际行 ID|
|FINAL-0126/0127，blocked|all_required_scopes、live 四层交集；NG-03/05；已有 require-instance-access 测试不证明新身份安全|T03 / auth/require-instance-access.ts；受限服务主体、撤权、所有资源交集/真实查询|
|FINAL-2384，任务内修复|保存合法非成功 payload，不把 false/0 当缺失；PL-05/DB-12 不能推断 success|T04 / agent-run-service.ts；false/0、明确 NULL 语义测试|
|FINAL-2385，blocked|唯一 terminal，unknown→completed 拒绝；Run guard 只允许 running 转终态|T04 / agent-run-service.ts；MySQL staged completion/cancel 竞争与无重放|
|FINAL-0618，blocked|取消是 request 意图，不能由 WS 断开代替；queued 属 job|T04 / direct-adapter.ts；前缀/裸 session WS 真实取消；T06 消费|
|FINAL-0614，blocked|Parts 复用完整 ProjectionFrame；resultVersion 不覆盖旧结论；NG-02|T05 / canonical-store.ts；同 ID 完整 metadata/Parts 不一致拒绝或明确版本更新|
|FINAL-1117，任务内修复|发生/接收/采集时间区分；PL-08 相同窗口才可比较|T09 / platform-observation-service.ts；from/to 全链路对齐|
|FINAL-1118，blocked|run.terminal 用六态事实；partial/outcome_unknown→unknown，取消不统称 failed；PL-05|T09 / runtime-events.ts；逐终态映射、防成功误摄入|
|FINAL-1127，任务内复现|platform 主体与完整 Commit/缺口区分；PL-04 不能回退 main|T09 / source-snapshot-service.ts；保留名裁定；改同步时跑真实 sync/manifest/重复同步|

## 六个 pending 领域的移交

|领域 / 尚缺证据|T01 合同与样本|后续测试 / owner；门禁保留|
|---|---|---|
|auth/actor/session：share、撤权、枚举/计数、工具/Profile 交集|NG-03/04/05/07；权限规则常量；Profile 不接收 authority/apiKey|T03 服务身份/Session/实时权限；T02 先隔离事务；T06/T10/T11 内容深链；T12 安全总验收|
|Adapter/Run/Projection：FINAL-0083/0084/0171、Parts 版本、恢复/预算|共享 frame 校验、终态 guard、DB-12/PL-05；现有 WS/reducer 基线|T04 re-auth/send、MySQL/WS/provider/fence；T05 late frame/client reducer/事实；T06 刷新；T12 crash gates|
|Workflow/outbox：租约、去重、cancel、预算持久唯一|accepted/job ID、origin、unknown 不记零；PL-03/06、NG-08|T02 关闭 0026/0300 后 T04 恢复、T07 admission/reservation/settlement；T12 并发/故障注入|
|Analysis/告警：FINAL-0106、legacy 归属、并发唯一、服务器/网络|v1 原样读取，resource/platform 分开；DB-08/09、NW-02、NG-02|T08 legacy retry/权限/单 owner；T10 SSH/SNMP 真实资源夹具；T11 关闭验证；T12 全链路|
|platform/source：部署 Commit、egress、持久事件、防循环|完整 Commit、origin、UTC；PL-01–08，NG-06|T09 匹配部署及模型 egress、真实同步；T07 持久事件；T05 引用；T12 自身故障|
|前端/Chat：现用并发附件/greeting/cache、路由、撤权、窄屏|三个独立状态、typed stream watermark、read share 无 append；NG-04/05|T06 真 WS/断线/1600/1024/390/键盘，T08/T10 往返深链，T11 反馈；T12 浏览器总 gate|

其余 needs-evidence 逐项 ID 和源码范围继续留在 R00 账本，不因本次契约测试通过自动 rejected 或 clear。文件触达顺序仍是 outbox T02→T07、Run/Adapter T04→T05→T06、source T09；本任务只拥有契约、生成管线及本基线材料。

## 40 样本移交

[t01-samples.json](evidence/t01-samples.json) 固定数据库 DB-01–12、服务器 SV-01–06、网络 NW-01–06、平台 PL-01–08、拒绝/缺口 NG-01–08。每例有独立 synthetic_redacted 快照和稳定 evidence ID、允许事实、支持/反面引用、禁止结论、下一步、责任任务及硬安全期望。索引内部校验验证数量、ID 唯一、subject 和引用存在；不验证模型输出。

全部 runnerStatus=not_evaluated。快照为可公开审阅的合成基线，未取生产记录、未调用付费 Provider，不冒充真实 MySQL/SSH/SNMP 资源夹具。T11 可按 sample ID 加 runner 结果和盲评；T08/T09/T10 另补对应真实夹具。硬项越权/泄露/伪造绑定/unknown→success 期望均为 0；帮助度≥80%、事实支撑≥90% 是后续试点目标，尚无达成证据。
