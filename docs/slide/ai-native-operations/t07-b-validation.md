# T07-B：内部持久事件、聚合与 admission

2026-10-12；MAX-146；调度 v1.2.2。消费 main `3eb7fa744c261fedb4e6f156e140c6199b9b145f`，前置 #149 / #150 / #152 已父核验；复用 #145 的 outbox 事务释放与稳定 ID。仅内部 typed service，生产数据库/服务器/网络/平台 hook、HTTP、Worker、executor 和模型调用均未接入。

## 有界复核与实施计划

读取实施基线第 8 节、menu addendum、T02/T03/T07-A 当前源码/验证与父 parent-review.md。实际消费：contracts 的严格 event/subject/Profile schema；store 的同连接 create/admit；T03 实时主体/全部资源授权和冻结 authority/message；outbox 的单事务 append；ledger 的域锁、全部资源、manual/automatic 配额与 unknown 保留。未扩大为全领域 clear。

沿用已批准方案，在同一 MySQL 事务内锁定投递事实与问题聚合。内存聚合不能跨进程；固定时间桶会在边界重复建调查。采用唯一(source,sourceEventId)和不含时间桶的 policy/version/scope/subject/error/callsite/release/commit 指纹，配合当前读行锁。阈值窗口使用数据库接收 UTC 时间；发生时间独立保留，不能由生产者篡改接收时间来重置配额。

1. `trigger-policy.ts`：绑定可信来源、policy与禁登录服务主体；严格拒绝输入的actor/grants/policy/source/id/receivedAt/fingerprint；原 envelope schema 与calendar验证；origin/HTTP/verified/kind/scope排除；全部资源边界与不可变策略hash。
2. `116_operational_events.sql`：新增严格OperationalEvent v1事件envelope、独立classification字段、聚合、资源cooldown、唯一关联；MigrationRunner自动发现，无旧迁移或共享runner修改；精确二进制source/key，所有列注释。投递hash不匹配或同version策略变更fail closed，不产生半份事务。
3. `event-ingest.ts`：投递事实→锁聚合→live授权→关联已开放调查，或阈值/cooldown→同连接create/admit/message→预算→关联→提交。全部需要的资源cooldown跨指纹/version/release共享。closed/archived后新调查引用旧ID，不重开旧结论。开放调查只关联，不自动为每个事件创建新Run。
4. `session-bridge.ts`：仅提取可信`createOnConnection`；HTTP/普通Chat原create行为、原主体、冻结authority及消息幂等算法保持。额度不足通过同连接savepoint回滚新Session/message/create-key/request/job/outbox/reservation，事件和suppression保留；基础设施故障回滚完整事务，由生产者同键重试。域锁/配置与cooldown初始化在配额保存点外保留，避免拒绝后删除锁行的间隙锁风暴；它们不占token或并发。仅对MySQL死锁做至多3次有界事务重试，无外部调用。
5. `budget-ledger.ts`：共享request整次执行receipt，精确重用与严格domain/lane/Profile/资源/command校验；支持从持久allocation读取原token/cost/prices而非executor重算。既有ledger行为保留；unknown非零、终态才结算契约沿用T07-A。
6. 真实隔离MySQL8.4及正式迁移验证10k/重投/跨窗/closed/区隔/阈值/cooldown/配额/撤权/回滚/进程恢复/迁移回退；unit只用于严格输入与hash。相关调查模块、typecheck/contracts/security scan/lint与独立PR准确headCI。父独立核验和T04共同消费仍保留。

## T04 精确消费交接

#154 `d466cffa0f82bcb295d705dfe759a66a941fce36` 仍使用`execution:<runId>`。此分支不修改executor。T04必须在自己的PR中：

- 保持原actor/冻结authority的实时授权、request/job/Session锁序、lease/fence。调用账本之前不能使用事件/model提供的主体或budget参数。
- 自动初次request已在入队事务取得receipt，operation固定`request:<requestId>`，在`request_snapshot.budgetReceipt`中持久化schemaVersion、requestId、reservationId、operationId、domain、mode及commandHash。
- 调用`reuseExecutionInTransaction(connection, requestId, {domain,mode,profile})`，其中domain/lane/Profile来自独立可信配置与request用途。返回原持久reservation，不生成新allocation，不拿`REQUEST_ACTIVE`作为执行失败。helper验证完整receipt/冻结Profile/全资源hash及原command，缺失或失配拒绝，不补造receipt。
- 尚未预留的手动request使用`reserveExecutionInTransaction`并冻结receipt，自动与手动共用同一domain和policy。不得用新domain绕开共享全局/资源quota；人工lane由可信入口判定，不能由model/event选择。
- Runtime token ceiling使用返回的`reservedTokens`；发送前提交`markSent`，只有首次dispatchAllowed=true才发送；sent/unknown/settled不可重发。整次执行终态合计usage结算，任一未知调用传null，继续占非零token/cost/并发槽。
- 排队取消的receipt核销和已发送unknown恢复归T04 owner；不能仅清request活动标记就释放未知预算。父核验T04适配及共同真实SQL/真实Provider证据前，production auto-trigger保持关闭。

这里的fixture consumer验证SQL契约，不代表真实Provider或完整T07跨owner出口。T08/T10/T09生产事件桥接、T05事实流、T06UI、T12最终完整gate不在本阶段。

## 事件查询与回退边界

`get(eventId)`为绑定来源的内部端口，读取真实持久envelope/disposition/suppression/调查及closed前驱引用；返回前重查服务主体和全部required资源scope。其他来源返回null，越scope/撤权不可读取。不会跟随rawRef或暴露通用触发API。origin=investigation_engine、unverified、HTTP<500和非支持kind只保存事实，无job/model。

应用回退停止新admission，保留116新增事实/关联/cooldown与114预算；不提供破坏性down，不在旧链路重放已接受或unknown执行。测试验证pre116升级、重复启动和旧迁移目录启动保留事件及unknownreceipt。生产迁移不属本轮。

## 验证记录

初轮真实SQL定位并修复：mysql2.execute使用预处理协议不支持SAVEPOINT，改用同连接query；BIGINT布尔表达式返回字符串0，使用数值判断；夹具正式用户状态是inactive；MigrationRunner第二参数是目录字符串。真实并发满额进一步暴露保存点回滚首次cooldown插入产生supremum间隙锁冲突，通过保存点外持久域锁/cooldown初始化修复。共享MySQL并行正式迁移使既有store默认10s hook超时，最终模块命令显式hookTimeout=120000；未跳过失败或放宽校验。

最终内联审查补充严格回读契约：内部stableErrorCode/callsite/httpStatus独立保存到classification，不能扩展既有strict OperationalEvent v1 envelope；真实回读仍用现有validator通过。

当前产品源码验收：隔离MySQL8.4.10，随机schema，正式MigrationRunner；调查模块9文件 **241 passed / 0 skip**；迁移runner/outbox focused 2文件 **25 passed / 0 skip**。两组用途不同，不冒充全仓/T12验收。API typecheck、contracts、秘密扫描、6文件lint、diff检查通过。

```bash
TRIGGER_TEST_MYSQL_PORT=<isolated-port> BUDGET_TEST_MYSQL_PORT=<isolated-port> INVESTIGATION_TEST_MYSQL_PORT=<isolated-port> AUTH_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-api exec vitest run src/investigations --hookTimeout=120000
pnpm --filter slide-api exec vitest run tests/migration-runner.test.ts src/workflows/outbox-service.test.ts
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm security:scan
pnpm exec oxlint apps/db-ops-api/src/investigations/{event-ingest,trigger-policy,budget-ledger,session-bridge,trigger-policy.test,trigger-concurrency.mysql.test}.ts
git diff --check
```

|验收|真实证据|
|---|---|
|两层幂等/聚合|10,000不同delivery仅1开放调查/初次request/job/message/outbox/receipt，10k关联；100同源同键仅1事实，payload冲突和大小写区隔；跨窗口仍同调查|
|生命周期/边界|closed后受cooldown约束，新调查携旧ID引用；资源、policy version、release、callsite、全部resource scope分别区隔；platform system Profile与组件资源quota|
|抑制/满额|threshold重投不计数、窗口重启；30policy并发共享cooldown仅1admission；20跨资源满额并发仅1allocation、10global拒绝且无孤儿；manual保留、资源并发、token、cost、hourly frequency实际抑制并可get查询|
|receipt/记账|100同request预留重用同ID，manual/automatic共享域额度，错误domain/lane/allocation、篡改和缺receipt拒绝；独立进程get事件与unknown账本，unknown保留100token/100micro，无重发；20重复known结算仍50token|
|权限/递归|真实禁登录服务identity、JWT签发/普通登录加载拒绝；全部实例/服务器/网络scope冻结；删除related instance grant、inactive及重复投递实时拒绝；engine origin/unverified/HTTP403/scope越界保留事实而不admit，agent_runs为空|
|原子/迁移|request/message/job/outbox/ledger/link六处SQL trigger注入整事务回滚，同源重试恢复；额度拒绝仅事件/suppression，无create/admissionkey孤儿；fresh/repeat/pre116 upgrade和旧目录保留事件/unknown、全部列注释；原HTTP/Chat/Session bridge模块全通过|

按requesting-code-review做有界内联审查：授权与冻结天花板、锁顺序/当前读、savepoint隔离、投递冲突/稳定hash、原message/queueowner、receipt复用/发送防重/未知保留及迁移回退。确认的SQL协议、布尔类型和拒绝间隙锁问题已修复并验证；未发现本范围剩余源码blocker。无独立子代理Review；父独立phase核验和T04集成门禁保留。

最终当前源码hash及PR/head/CI/merge事实在本Issue交接附件记录。实际token/费用遥测不可用，无硬预算；无付费设施、生产操作或模型调用。
