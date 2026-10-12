# T04-B 调查执行与恢复验收

本次交付仅 MAX-145 / T04-B（父调度 v1.2.1）。实现已完成本地模块验收，**完整 T04 出口尚未满足**：当前环境缺少授权的免费真实 Provider，PR 当前 head CI、父独立 Review、普通 merge 和 main 包含关系另见 Issue 最终交接，不以本文或 fixture 验收代替。

## 范围与消费合同

消费 main `3eb7fa744c261fedb4e6f156e140c6199b9b145f` 的 T03 #150、T04-A #151、T07-A #152、T05-A #153。新增受限 `executeInvestigation`、Workflow handler 和 server 最小装配，组合现有 AgentRunner / ToolRegistry。普通 invoke/Chat 权限不扩张；无迁移、ledger、auth/Profile/bridge、Parts、source、frontend、watch/evidence 改动。

canonical 仅按 v1.2.1 临时独占合同提取共用 SQL writer/history mapper，新增调查同连接端口。锁顺序 Session→Investigation→Request→Job→Run；保留原 actor、request.message_id、真实 user-turn、active request、live authority、取消意图及未过期 owner/fence。事实复用完整 immutable payload、successor、容量、ordinal、Parts 和幂等算法；checkpoint 显式 Run/turn 冲突拒绝。写入后、返回前再次核对租约，不接受客户端授权布尔值。

Run 幂等 key 为 `investigation:<request UUID>`，不假定用户消息是 `run_<id>_user`。持久状态在现有 `agent_runs.result_json.investigationExecution`，含 request/job/fence、全执行 deadline、reservation、累计 usage、provider intent 和工具执行回执；不新增状态或数据表。完成 staging 与消息+Run+waiting 提交分离，final message 父节点是原 request.message_id；completed 不代表 resolved/closed。

## 权限、工具与预算边界

每 request 复用 requestAuthority；每模型发送、工具调用、checkpoint 和事实写入检查冻结上限与 live actor/member/resource/Profile/policy 的交集。合法 operator 可执行 service Session，service 不能继承用户 admin；保留最初 global instance grant 来源，实时撤权、Session version 变化、停用账号均拒绝继续。保留主体而非持有浏览器控制器。

工具取 Profile、当前工具策略、readOnly、内部 BACKGROUND_SAFE 的交集，不开放 source 工具或凭据/审批/命令/SQL。目标复用可信 resolver，冲突 aliases/name/host/sql/command 拒绝；输入 128,000 字节、数组最多 200 行、窗口最多一小时、输出 128,000 字节、工具 deadline 最多10秒，返回值脱敏。server range 与孤立 to 等窗口负例已验证。

T07 ledger 仅内部调用；一次执行预留32,000 tokens，Runtime 总量限制同预留，模型 context window 上限16,000，最多8次 Provider、20次工具、执行120秒。整个执行终态按累计 usage 结算，不逐轮退款；没有模型价格时 cost_status 保持 unknown。发送前 provider intent 同事务持久化，ledger markSent 后再次 live gate。发送后无确切当前 assistant checkpoint 确認的请求不重放；reserved 且已有 intent 也转 sent/unknown，不误退额度。

## 真实本地验收（fixture Provider 单列）

2026-10-12，本任务专属 MySQL8.4 容器，仅 localhost:61307；每测试使用独立随机数据库及生产 MigrationRunner，结束删库。无生产数据库/付费调用。下列13模块 **322 passed / 0 skipped**，包含新执行29、调查canonical18、原canonical35和既有Run/JWT/WS/bridge/ledger兼容组；计数不与安全组相加。

```bash
AGENT_RUN_TEST_MYSQL_PORT=61307 AUTH_TEST_MYSQL_PORT=61307 \
BUDGET_TEST_MYSQL_PORT=61307 T04_BROWSER_TEST=1 \
pnpm --filter slide-api exec vitest run \
  src/investigations/executor.test.ts \
  src/investigations/execution-recovery.mysql.test.ts \
  src/adapter/__tests__/investigation-canonical.mysql.test.ts \
  src/adapter/__tests__/canonical-store.mysql.test.ts \
  src/adapter/__tests__/agent-run-recovery.mysql.test.ts \
  src/adapter/__tests__/agent-run-service.test.ts \
  src/adapter/__tests__/direct-adapter.test.ts \
  src/adapter/__tests__/runtime-lifecycle.test.ts \
  src/investigations/session-bridge.test.ts \
  src/investigations/authorization.test.ts \
  src/investigations/budget-ledger.test.ts \
  src/investigations/budget-ledger.mysql.test.ts \
  src/workflows/register-workflow-handlers.test.ts
```

- 实际 Workflow→DirectAdapter→executor→AgentRunner→SQL 完成：两次模型、一工具，累计 usage60，消息唯一，原 actor/turn 不变，调查 waiting/unconfirmed。Provider 和工具为明确 fixture。
- Chromium 经正式 Fastify 调查路由/JWT 创建和入队，并连接正式 DirectAdapter WS 完成 auth；Provider 阻塞期间关闭浏览器，Workflow 随后继续并持久完成。没有替换认证/数据库/WS。此项不等于前端调查 UI/watch 验收。
- 确切子进程经生产 executor/SQL，在真实 COMMIT 后 IPC 暂停；父进程 SIGKILL 该子PID并等 exit，真实 MysqlWorkflowStore 获取更高 fence，新进程恢复。九窗口如下；所有终态重放均无新模型/工具/消息。

|退出窗口|恢复|累计fixture模型/工具|预算|
|---|---|---|---|
|Provider选择前，尚无intent|completed|2 / 1|settled|
|intent COMMIT后、物理发送前|partial|0 / 0|unknown，保留32k|
|物理发送后、响应返回前|partial|1 / 0|unknown，保留32k|
|响应usage已保存、当前响应checkpoint尚未确认|partial|1 / 0|unknown，保留32k|
|工具running已保存、结果返回前|partial|1 / 1|unknown，保留32k|
|工具结果已COMMIT、tools_completed未保存|completed|2 / 1|settled，工具不重复|
|final_response候选已保存、terminal未确认|partial|2 / 1|unknown，保留32k|
|terminal response_ready已保存、stage前|completed|2 / 1|原回答直接stage，无新模型|
|completionPending staging后|completed|2 / 1|原回答直接commit，无新模型|

- 实时撤权、viewer downgrade、service原主体、global grant keep/revoke、Session version/停用账号、无Run时取消/撤权、过期/旧fence、迟到Provider I/O、不重复并发与跨executor同fence拒绝、预算拒绝、missing usage、Provider exception、完成/取消竞争唯一终态；canonical rollback、lost-ack、payload冲突和游标均通过。
- `pnpm --filter slide-api typecheck`、`pnpm contracts:check`、`pnpm security:scan`、新增六文件oxlint（0warning/0error）、`git diff --check` 通过。`pnpm security:agent`：17模块187 passed/0skip，含普通DirectAdapter；与322项有重叠，不累计为509项。
- 开发RED已经定位：预算/context配置初期阻止首次调用；恢复Parts生成边界在新attempt下冲突已修复。测试夹具问题包括列名/清理顺序、COMMIT暂停点覆盖与错误解析终态SQL、未插入的global wildcard权限、构造后修改冻结policy、users.status错误枚举，均已修正。以上失败不作为GREEN证据或额外测试数；最终GREEN对应下面源码hash。

## 当前Review裁定与限制

FINAL-2384/2385/0618/0083 的既有修复由当前 Run/WS/Chat 回归消费；FINAL-0171 未把 singleton startup token 当作下游 fence，新 executor 使用单调 workflow_jobs.fencing_token，真实接管/旧fence拒绝证据覆盖本路径。FINAL-0614 复用既有算法和35项回归，不重开旧算法问题。FINAL-0084 的调查watch/late projection和source/evidence后续能力未列作本次clear；父共享Review矩阵未修改。此为主代理有界代码/调用链自查，父独立领域核验尚待完成。

当前worktree没有 `.env`/`apps/db-ops-api/.env`，localhost:11434/api/tags连接拒绝；已询问授权的免费测试 Provider 地址/模型/调用上限，没有调用其他模型或读取生产凭据。**未完成免费真实 Provider 链路，因此不能普通merge或宣称完整 T04 验收通过**。CI可以验证仓库门禁，但不能替代此项。最小补充为配置好的授权免费测试Provider与有限调用上限（凭据通过环境，不写Issue/日志）。全仓最终集成gate仍归T12。

平台起始 `1b941306` 及托管历史保留；PR只携本次获准文件，独立main基线分支再合回托管任务分支，不reset。实际token/费用遥测不可用，无硬预算；fixture usage为测试账本证据，不能冒充本Agent资源用量。

## 当前源码 SHA-256

```json
{
  "apps/db-ops-api/server.ts": "6073dfd6c0b6d8496dcf914f8e0368af1d5e4f545518a11ff7c580e3d14ec646",
  "apps/db-ops-api/src/adapter/agent-run-service.ts": "1860081f5dabe2718521ad74138a211f79f6ba16db148740f594d9f1762bbabe",
  "apps/db-ops-api/src/adapter/canonical-store.ts": "984971c964f4bafb4171adc02d8413d6c1e646913b0f21a7f5f3da17f1466c24",
  "apps/db-ops-api/src/adapter/direct-adapter.ts": "1e131cdcf8e525e5ebf2af88e1c7b1f7a95d726aa556f5a985012fec00440608",
  "apps/db-ops-api/src/adapter/types.ts": "9dbbfe74fed4f5b6ca4df5f789bf31a3eccf49808be9eabd4ab4a73cdf398d09",
  "apps/db-ops-api/src/workflows/register-workflow-handlers.ts": "4e46d24232afebf1482b29cf484d0465a12dbf1597d8dd243e8faa9c09a54917",
  "apps/db-ops-api/src/adapter/__tests__/investigation-canonical.mysql.test.ts": "5b7563edb5bea7b6fd706f651108378a60822d53ac8ff89926965749f3105005",
  "apps/db-ops-api/src/investigations/executor.ts": "72455d42db059fe982b705e3c5d515a5117ce9731744d52f97c7f8872c6f1ef6",
  "apps/db-ops-api/src/investigations/workflow-handler.ts": "4efbabe26cf94a2769afc4923d76e98a95e19c9c32f851b3d2e873eeb4b656a9",
  "apps/db-ops-api/src/investigations/executor.test.ts": "4463f217ddc42a579b40f076ba09e4e753a3db599a84ddb8bb28fecbb277d468",
  "apps/db-ops-api/src/investigations/execution-recovery.mysql.test.ts": "cc35a3e9fca01b0ed1fb7b1f35fec0238d02c9ab7a6fc1f7ca6626edddd288a9",
  "apps/db-ops-api/src/investigations/execution-recovery-child.ts": "ce381e72d712c4e00a40f08fe6bb1593baf6453860b9235fa265723a69d6b350"
}
```
