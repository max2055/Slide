# T04-B：排队取消预算核销验证

2026-10-12；MAX-145；父调度 v1.2.5；继续 PR #154。本文覆盖旧 `t04-receipt-validation.md` 中“排队取消未实施”的当前状态，保留该文的历史 RED。产品范围仍为 V1.1；生产自动触发关闭，未调用真实/付费 Provider，未启动后续阶段或子代理。

## 缺陷与修复

实际 event-ingest 产生一个自动 request 和 reserved allocation。原 JWT HTTP cancel 返回202，Job已cancelled、Worker不能claim且没有Run，收据仍占32,000 tokens与1,000,000成本微单位。正式 `execution-recovery.mysql.test.ts` 的新HTTP测试先实际运行并捕获此业务RED；focused RED为1 failed/59 filtered，不能当完整gate。

修复从原 HTTP cancel → SessionBridge.storeFor → Store.cancel 实际事务进入服务端hook。保持 Session → Investigation → Request → Job → Run → domain/ledger锁序及同连接live cancel授权。取消意图、Job终态、active request标记、unsent token/cost核销一起COMMIT；未引入嵌套事务、外部I/O或第二份ledger SQL writer。

- Bridge核验持久request的调查/Session、原actor/authority、Profile及Run绑定、lease/fence。预算domain来自独立服务端配置，lane来自原request.actor_kind，不能由取消者、HTTP body或模型提供。合法用户operator代取消service request时仍使用automatic lane。
- 已有receipt使用T07 `reuseExecutionInTransaction`验证原operation、allocation、command/profile/resource hash。自动缺receipt或任意lane已存在allocation却缺receipt均fail closed。只有可信无receipt且无allocation的手动request保持兼容。Store未接可信hook时对service/receipt/已有allocation拒绝提交。
- Ledger同连接 `cancelUnsentInTransaction`复用现有domain/row-lock mutation与唯一reserved取消writer；sent不接受该退款transition。只有没有任何持久Run且allocation=reserved的request才证明未发送，可核销为0。
- queued和retry分别测试。retry若有旧Run，即使allocation仍reserved，也保守保留token/cost/并发并转unknown；sent/unknown同样不退款，不重放。此保守策略可能保留实际未发送的旧Run额度，须有可信终态收据后再结算。known-settled/cancelled维持原账目，HTTP hook不抢Run终态owner；running分支只登记取消意图。
- HTTP默认Bridge与server Workflow executor调用同一 `investigationBudgetConfiguration()`；default route真实JWT/SQL测试不注入Bridge，证明默认生产装配不会漏hook。配置数值与原server预算保持一致。API契约无变化。
- cancel SQL遇ER_LOCK_DEADLOCK最多三个完整事务，每次rollback/release。真实SQL trigger注入1213验证三次上限和零部分提交；没有外部I/O重试。

本次增量仅store.ts、session-bridge.ts、budget-ledger.ts、server.ts最小装配、直接execution测试及本验收文档/历史指引。未改event、auth/Profile、迁移、前端、source/platform/watch/result或共享Review矩阵。共享文件按父临时所有权授权使用，父核验后归还。

## 当前候选验证

隔离run-owned MySQL8.4.10，随机schema，正式MigrationRunner和迁移116。真实JWT HTTP、授权/撤权、SQL事务与竞争，真实WS/Chromium与SIGKILL；Provider与工具明确为fixture。没有读取生产凭据或使用停用的旧Anthropic配置。

|验证|结果|
|---|---|
|完整受影响gate|18模块530 passed，0skip；execution模块93项，其中本轮新增34项|
|取消矩阵|queued/retry自动；手动无receipt/已reserved；共享operator；重复cancel及COMMIT lost-ack；原主体lane|
|失败关闭|缺失/篡改allocation、commandHash、domain/lane/Profile/resources/actor；manual receipt移除；viewer与全部scope中的撤权；retry有效lease/未来fence；默认hook缺失|
|事务与竞争|真实SQL refund后Job/marker失败全部rollback；有限SQL deadlock重试；claim与markSent竞态；sent/unknown无Run仍保留额度|
|旧Run/恢复|retry的reserved/sent/unknown/settled/cancelled分别检查；旧durable intent不退款或重放；原自动/手动各九个SIGKILL窗口、canonical/Chat/Runtime、浏览器关闭继续全部重跑|
|Agent安全gate|17模块187 passed，0skip；与上面模块有重叠，不相加|
|静态检查|API typecheck、contracts:check、security:scan、focused oxlint、git diff --check通过|
|真实Provider|未执行：后端.env缺失，环境无Provider配置，本地Ollama11434连接拒绝；仍需授权免费地址、模型与有限调用上限，凭据只通过运行环境|

原始日志、当前源码SHA-256、准确PR head/CI和交接run由本次Issue交付附件提供。源码未变的检查复用有效证据；格式调整仅触及新增测试。未把focused filtered计数当完整gate，也未将fixture usage作为Agent token用量。

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
```

## 交付边界

取消预算RED已关闭。完整T04仍需授权免费真实Provider验收、父对新head独立审查、正常merge及main核验，PR保持draft，不宣称完整done。旧headCI/父核验只代表旧版本，不能代替当前head。保留托管起始提交、既有PR/用户历史，不reset、不force。

精确run `01a1309b-266a-71a2-9648-ad4da4b95449` 已有一次性终态交接规则 `01a1309c-2211-7b78-b44e-f95a368e4561`，completed/failed/cancelled只触发交接，不证明验收；退出前不提前rerun父，不重复订阅。家族与后续phase保持既定调度。实际Agent token/费用遥测不可用；无硬预算；无付费模型/生产操作/新任务/子代理。
