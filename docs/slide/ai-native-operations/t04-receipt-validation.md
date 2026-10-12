# T04-B：request 预算收据联合消费

2026-10-12；MAX-145；父调度 v1.2.3。在原 PR #154 上增量消费 T07-B #155 / main `e88879af774f8f945d72c6f6e1072d214032fb29`。既有实现和验收历史保留在 `t04b-validation.md`；本文件记录当前差异。生产 hooks/自动触发仍关闭。没有真实模型调用、生产操作、付费设施或子代理。

## 实现与消费边界

- 在原 Session → Investigation → Request → Job → Run 门禁内，自动 request 必须 `reuseExecutionInTransaction`；手动 request 有收据时同样复用，没有时才用 `reserveExecutionInTransaction` 首次预留。operation 固定为 `request:<requestId>`，不再生成 `execution:<runId>`。domain 取 executor 的服务端配置，lane 取持久 admission 主体种类，Profile 由持久 id/version 解析；HTTP、事件及模型不能提供这些选择。
- 保留收据的 allocation ID、reservedTokens、cost 与 prices；没有重新计算自动 admission 的额度。Runtime 的整次 token ceiling 和单次输出上限使用 reservedTokens。每个新的 provider intent 在同一真实事务内再次校验完整收据、实时权限与 owner/fence。缺失、篡改、错 domain/lane/Profile、资源 hash 变化均拒绝，不创建第二份 allocation。
- `markSent` 是整 request 首次 dispatch 的门禁，必须返回 dispatchAllowed=true 才进入首次外部调用。同一次执行的后续已知模型轮次在这个 sent allocation 内登记独立 durable intent，不重新获取整 request 的发送许可。恢复遇到未确认 intent/工具不重放；已确认工具的恢复仅发新的模型轮次，不重复原调用。此处沿用 T07 的整次执行收据解释，需父新 head 审查核验，不能把 sent 账本行本身当作重放许可。
- Run 持久终态后才累计结算，未知调用传 null，保留非零 token/cost/槽位。Worker 在 Runtime checkpoint 尚未创建时因撤权/取消拒绝 request，则在原绑定与当前 lease 校验后核销验证过的 unsent 收据；已有 sent 收据保持 unknown。损坏收据的核销验证失败会报错并保留原 allocation，不能猜测退款。
- SQL-only executor 事务对 ER_LOCK_DEADLOCK 最多执行三次，每次 rollback/release，外部 provider/tool I/O 不在重试闭包内。真实 SQL trigger 验证首次手动 reserve/收据/checkpoint 写失败一起回滚，随后同 request 可重试。

本次产品源码仅改 `investigations/executor.ts` 和其直接 `execution-recovery.mysql.test.ts`。未改 ledger/event/bridge/store/迁移、auth/Profile、canonical、前端或共享 Review 矩阵。

## 验证

隔离 MySQL 8.4.10，随机 schema，生产 MigrationRunner（含116），正式用户/受限服务身份、JWT、WS 和 Chromium。Provider/工具是明确 fixture，不能替代真实 Provider/生产工具验收。

RED：真实 event-ingest 入队已有 receipt，旧 executor 报 `INVESTIGATION_BUDGET_REQUEST_ACTIVE`，自动执行和已预留手动执行失败；原 small receipt 未能进入受限 Runtime。新增测试先证明这个实际 SQL 缺口，再实施适配。初轮新增夹具对 VARBINARY operation_id 的字符串断言已更正为显式 CAST；失败日志不计入通过证据。

执行模块单独验证59项，包括原31项、收据联合差异与自动/手动各九个真实 SIGKILL 窗口。最终模块 gate 以交接附件的当前 head 原始日志为准；同时运行 API typecheck、contracts、focused lint、secret scan 和安全 Agent gate。安全测试与模块 gate 存在重叠，不相加。

```bash
AGENT_RUN_TEST_MYSQL_PORT=<isolated-port> AUTH_TEST_MYSQL_PORT=<isolated-port> \
BUDGET_TEST_MYSQL_PORT=<isolated-port> TRIGGER_TEST_MYSQL_PORT=<isolated-port> \
INVESTIGATION_TEST_MYSQL_PORT=<isolated-port> T04_BROWSER_TEST=1 \
pnpm --filter slide-api exec vitest run src/investigations \
  src/adapter/__tests__/investigation-canonical.mysql.test.ts \
  src/adapter/__tests__/canonical-store.mysql.test.ts \
  src/adapter/__tests__/agent-run-recovery.mysql.test.ts \
  src/adapter/__tests__/agent-run-service.test.ts \
  src/adapter/__tests__/direct-adapter.test.ts \
  src/adapter/__tests__/runtime-lifecycle.test.ts \
  src/workflows/register-workflow-handlers.test.ts --hookTimeout=120000 --maxWorkers=2
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm security:agent
pnpm security:scan
pnpm exec oxlint apps/db-ops-api/src/investigations/executor.ts \
  apps/db-ops-api/src/investigations/execution-recovery.mysql.test.ts
git diff --check
```

初轮18模块并行中既有 routes.test.ts 的真实TCP/迁移重跑测试超过默认5秒，其他495项通过；分类为并行共享MySQL负载问题。最终降低 runner 并发重跑，无跳过、无业务测试超时配置修改。通过数量和当前源码/日志 SHA-256 在本次交接附件记录。

|验收点|证据与边界|
|---|---|
|实际联合消费|event-ingest → receipt → Workflow handler → DirectAdapter → executor → Runtime → SQL，只有一个 request allocation；两轮 provider/一工具累计60 tokens，按原prices结算1 micro；终态重放不再调用|
|原小额收据|1-token 自动 receipt 无法容纳 prompt，Runtime 在外部调用前返回 partial；provider/tool计数均0，unsent allocation核销为0|
|严格失败|缺receipt、allocation ID/commandHash/domain/lane/Profile被篡改、资源变化、全scope撤权、过期/旧fence拒绝；不创建第二份allocation；工具I/O中篡改receipt会阻止下一模型轮次|
|共用配额|自动admission占额时手动executor分别被GLOBAL_CONCURRENCY或RESOURCE_CONCURRENCY拒绝；原自动request仍可消费自己的receipt|
|真实退出恢复|手动及自动各九个COMMIT/I/O窗口SIGKILL，新Worker更高fence；sent unknown保留32k/1m成本，无重复模型/工具/消息/扣款；已确认工具、response_ready和staging恢复保留原事实|
|无checkpoint的已发送收据|markSent第二次dispatchAllowed=false；executor不启动Runtime，持久partial/unknown，非零token/cost保留；重放无外部调用|
|兼容|原actor/user-turn、live ACL、Chat、canonical/Parts、浏览器关闭继续、取消与完成竞争；原324项证据中的相关模块重跑|

## 尚未完成：排队取消收据核销

独立真实 SQL RED 使用未claim的实际 event-ingest request，再调用现有 `bridge.storeFor(service).cancel`。job 确已 cancelled，Worker claim 返回 null，未生成 agent_run；但原 receipt 仍 reserved，chargedTokens=32000、chargedCostMicros=1000000。失败复现脚本与日志作为 Issue 附件，未把这个 RED 放进已通过 gate 或用 skip 隐藏。

根因：`store.ts:cancel` 的 queued/retry 分支直接取消 job 并清 active request；executor/Workflow handler 没有获得租约，不能调用自己的拒绝/终态核销逻辑。ledger 当前 `cancelUnsent` 独立开启事务，不能直接塞进已经锁住收据的取消事务；也不能复制一份 ledger SQL writer 或靠事务外查询判断是否发送。仅在本任务文件里增加无人调用的 helper 不能完成验收。

最小协调方案（未实施）：

1. T07 owner提供同连接 `cancelUnsentInTransaction(connection,id)`，复用现有 transition/domain-lock writer；reserved核销为0，sent/unknown不得退款，lost-ack/重复取消幂等。
2. admission/cancel owner在 `MysqlInvestigationStore.cancel` 的 queued/retry分支增加服务端可信同连接 hook，在原 Session → Investigation → Request → Job锁和live cancel授权内调用；不接受客户端 authorized或budget参数。
3. 通过 SessionBridge/server装配该hook，以独立domain、persisted request用途/Profile验证原receipt；保持普通Chat和无receipt手动request兼容。request取消意图、job取消、active标记和unsent核销同事务提交。
4. 增补queued/retry取消、claim/markSent竞态、rollback/lost-ack、sent unknown不退款的真实SQL和HTTP验证。

这需要父调度放行/协调当前禁止的 store、bridge、ledger 端口及API装配；本轮未越过文件所有权，不能宣称排队取消验收通过。

## 完整出口与交接

后端 `.env` 仍缺失，本地 Ollama :11434 连接拒绝，未提供授权免费Provider的地址/模型/有限调用上限。未读取生产凭据或调用旧停用Anthropic配置。PR #154继续draft，完整T04保持blocked；当前源码差异须父独立Review，真实Provider、排队取消、普通merge/main核验仍未完成。已有旧head绿色CI/父审查不替代本次新head。

起始托管提交与既有用户历史通过普通merge保留，交付独立PR增量历史合回平台任务分支；不reset、不force、不自动推进后续阶段。精确run `01a1306c-0602-7844-b8cc-ae872f6e4cf3` 已有一次性completed/failed/cancelled交接唤醒；不重复注册或提前rerun父。实际Agent token/费用遥测不可用，无硬预算；fixture usage不是Agent用量。
