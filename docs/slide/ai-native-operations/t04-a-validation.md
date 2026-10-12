# T04-A：Run 保存、完成/取消恢复与 WS key 一致性

2026-10-12，MAX-145，调度 v1.2 的独立有界基线修复。基线为最新 main `8d9f67b5126c59f7565de0ef9cf663191cdbfd62`；分支 `codex/t04-a-runtime-repair`。已回读 T02-C #149、完整 T03 #150 的 merged/merge/main 与当前 head CI。原托管工作树包含其他本地快照与规则变更，保持原样，在独立工作树实施。

本轮只修改 `adapter/agent-run-service.ts`、`adapter/direct-adapter.ts` 及直接相关测试和本文。未修改迁移注册、server、canonical-store、预算 ledger、auth 桥接或共享 Review 台账。T07-A 仍独立持有迁移/ledger。没有子代理、付费模型调用、新设施或生产操作。

## 当前候选裁定

|候选|实际依据与裁定|
|---|---|
|FINAL-2384|真实 MySQL 的 finish(false/0/空字符串) 回读 NULL，确认并修复。仅 null/undefined 表示缺失；false、0、空字符串及其他合法 JSON 值原样保存。额外发现 mysql2 默认解码 JSON string 后 mapper 二次 JSON.parse，属于同一保存/回读契约；所有 Run 查询显式 CAST 为序列化 JSON，再统一解码。测试覆盖 getForActor、claim replay、findByIdempotencyKey，含文本、JSON 外观字符串、对象与空值。|
|FINAL-2385|暂存成功不是可信终态。取消 UPDATE 和 recoverCompletion 的 SELECT FOR UPDATE/事务竞争同一行：取消先提交则清除 result_json 暂存成功意图，state=cancelled，恢复不得插入回答；完成事务先持锁提交则取消返回 false，回答/统计/终态原子保存。保留六态与现有 CAS，不增新状态/迁移。|
|FINAL-0618|真实 WS 旧实现中带前缀取消后 Run 仍 running。send/cancel 复用同一普通 Chat key 解析；四种前缀/裸 key 组合均取消成功，wrong actor/session 保持运行。保留冒号后缀、actor/session ownership 与进程内 activeRun 限制。|
|FINAL-0083|有界确认其中的 authGeneration 缺口：真实 JWT/WS 的 chat.send SQL 重验证等待期间，第二 auth 帧关闭连接；旧 revalidation 返回仍恢复 _actorContext 并可入站。现在返回后检查 socket OPEN、authenticated 与相同 generation，关闭世代不能恢复或新建 Run/消息，provider 调用为 0。未将“所有 async 帧交错”一概判为漏洞，未引入会阻塞取消的整连接串行队列。|
|FINAL-0171|DELETE 后 singleton token 重置为 1 的 SQL 事实成立，但该 token 不被 AgentRun 或任何下游写入消费。WorkerLease.acquire/renew 只返回 boolean；server startup/readiness 使用 owner UUID，release/renew 限定 owner，WorkerStartup 租约丢失即 abort/停止，晚到初始化通过 step/disposeLate 处理。真实 SQL 验证正常释放/过期接管后旧 owner 不能 renew 或删除新 owner。workflow_jobs 的独立单调 fencing_token 由 MysqlWorkflowStore 维护，未从 singleton token 取值。因此排除“singleton token 重置破坏现有下游 fencing”这一阻塞主张，不宣称所有第三方迟到 I/O 已获完整生产保证；T04-B/T12 仍需验收各自 fence/恢复边界。|

## 可复现的验收

新增 `apps/db-ops-api/src/adapter/__tests__/agent-run-recovery.mysql.test.ts` 使用独立 MySQL **8.4** 容器、随机独立数据库、生产 MigrationRunner、生产 AgentRunService、ActorContextService/JWT、Chat/canonical persistence、实际 WebSocket 网络帧和 AgentRunner。SQL 与授权没有 mock；只对 DB pool 接入进行隔离注入。provider 为可控本地 fixture，不发送付费请求；事务 hook 只控制实际 SQL 前后的时序和模拟失联，未替换 SQL。

测试退出等待本轮 handler/provider 结算，关闭 socket/adapter/连接，删除独立数据库与临时 runtime 目录。容器仅为本任务新建，验收结束停止。默认全量单测未提供端口时该 MySQL suite 按仓库惯例 opt-in；下列实际资格验证提供端口，**没有 skip**，默认 skip 不计为验收。

```bash
AGENT_RUN_TEST_MYSQL_PORT=<isolated-port> AGENT_RUN_TEST_MYSQL_PASSWORD=<test-fixture> \
  pnpm --filter slide-api exec vitest run src/adapter/__tests__ \
    src/lifecycle/worker-startup.test.ts src/workflows/worker-runtime.test.ts
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm security:agent
pnpm security:scan
pnpm exec oxlint apps/db-ops-api/src/adapter/agent-run-service.ts \
  apps/db-ops-api/src/adapter/direct-adapter.ts \
  apps/db-ops-api/src/adapter/__tests__/agent-run-service.test.ts \
  apps/db-ops-api/src/adapter/__tests__/agent-run-recovery.mysql.test.ts
git diff --check
```

|证据|结果|
|---|---|
|RED：新 MySQL/WS 19项对原生产代码|8 failed / 11 passed / 0 skip；false/0/空字符串、cancel 留暂存结果两项、前缀取消两项、晚到 auth 恢复分别按预期失败。checkpoint `01378f7f1cc10e1e1ddabfa77ca0dbf754f2e894`。|
|首轮最小修复|28 passed / 1 failed；空字符串触发 JSON 二次解析，按根因统一读取序列化 JSON。测试 observer 的 TS listener 类型另修正，未改变业务断言。|
|完整触达模块回归|17 文件 **193 passed / 0 failed / 0 skip**，含新 MySQL/WS **25项**、运行生命周期、memory/display/adapter、WorkerStartup 与 Workflow。|
|安全回归|security:agent **187 passed / 0 skip**；代码未改变工具/ACL/invoke 权限，后续 mapper/cleanup 小修由完整触达模块回归覆盖；security:scan passed。|
|静态检查|API typecheck、contracts:check、git diff --check passed；focused lint 0 error，新测试 0 warning，DirectAdapter 原有 NoopHook/RuntimeCheckpoint 两项 unused import warning 未作无关清理。没有另行测量覆盖率。|

各组有重叠，不相加冒充独立案例。修复代码 GREEN checkpoint `66315ecb0527b55e9edc4bed688f779006270704`；最终 PR head、CI、merge/main 包含关系在 MAX-145 最终交付附件记录，不能用旧 head 检查代替。

实际场景包含：新 service 恢复 staging 只生成一条回答；取消先提交和 completion 先持行锁两种竞争（performance_schema 验证真实锁等待）；回答事务 SQL trigger 故障回滚后取消；commit 已成功但 acknowledgement 丢失后幂等恢复；四种 send/cancel key 组合；错误 actor/session；关闭全部连接后已接纳 Chat 继续完成、重连同幂等 key 返回同一 Run/两条 user+assistant 消息且 provider 只有一次调用；失效 auth 世代不得新建执行；singleton 旧 owner 隔离。

## 兼容与阶段边界

新语义只修正合法值丢失和取消暂存结果矛盾。未改变旧 invoke 的工具/权限范围、普通 Chat read share、公开契约或 schema。没有覆盖历史已 cancelled 且残留 completionPending 的数据，也未运行生产清理/迁移。T04-B 消费当前修复后的写入/恢复语义。

普通 Chat 的 WS 取消仍使用本进程 activeRuns；这不是跨 Worker durable cancel intent。provider 是 fixture，staging 和 lost-ack 使用真实 SQL 上的故障注入/重建 service，**未宣称真实 provider 或 SIGKILL Worker 全链路验收**。没有前端修改，socket disconnect 验证不冒充真实浏览器 E2E。

本出口仅 T04-A。T04-B 的受限 executor、只读工具、provider intent、job fencing、unknown 不重放、跨 Worker 取消及实际崩溃/provider/浏览器链路仍未实施；需要父任务独立核验 T04-A 正常合并、T07-A ledger 已合并、T05 FINAL-0614 有界修复并核验后再调度。共享 Review 对齐/父 phase 台账由父任务据本交付独立回读更新；本子任务结束保持 in_review，不自动启动 T04-B，不标完整 T04 done。实际 token/费用遥测不可用，未设置硬预算。
