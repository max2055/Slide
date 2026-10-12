# T02 隔离 admission 事务候选与剩余门禁

日期：2026-10-12。此候选仅为 MAX-143 被放行的隔离 store/事务工作，不是完整调查 API 或当前平台已有能力。分支 `codex/MAX-143-investigation-store`，基于修复已合并的 main `1a3940e2ef79b9529a9f394d074a47e89d36be3d`。

## 前置修复的关闭证据

FINAL-0026/0300 修复 [PR #145](https://github.com/max2055/Slide/pull/145)：head `5687ddc475fd3f1bff0a408343b89d49fb0ed004`，merge `1a3940e2ef79b9529a9f394d074a47e89d36be3d`。head 的[8项CI](https://github.com/max2055/Slide/actions/runs/38193370389)全部通过；正常 merge，未使用admin/force；fetch后两SHA均进入main。此证据仅关闭两项outbox触发条件，其他confirmed/pending不变。

## 隔离候选的范围

`investigations/store.ts` 提供对已存在调查的 `admit` 事务内核，使用修复后的 OutboxService：

- actor kind/id + 精确UTF-8键字节先锁定，再锁调查；锁顺序一致。独立key reservation复用现有Analysis的持久key锁模式；输入hash固定调查ID、message和expectedVersion。
- 相同键/hash返回同一request/job及接受版本；不同hash返回409；不同键竞争同Session时仅一个活动request。调查到Session唯一约束目前在隔离schema夹具验证。
- request拥有冻结Profile/scope/Session快照，Workflow payload只持有调查/request ID；队列态属于job，不虚构Agent Run。
- request、outbox、job、活动指针与version原子提交。唯一入队owner沿用报表/Analysis的事务交付模式；三处真实SQL失败均回滚全部。
- authorizer是必须由服务器注入的事务端口，幂等重试也调用；缺端口或连接池时fail closed。该端口尚无T03真实实现，不默认授admin，不从模型/HTTP输入接收回调。

本分支**没有生产migration注册、HTTP routes/server装配、Chat Session创建/转换/追加、Profile执行、Worker执行或完整CRUD**。新schema只存在于测试fixture。代码尚未接入业务入口，应保留草稿PR，待领域准入后补正式迁移与完整功能PR；不能以本候选满足完整T02的合并/验收门禁。

## 当前验证

RED `d6a9d218`：新增测试引用缺失store模块，确认缺实现的导入失败；没有将此记录为已执行MySQL断言。GREEN `e3a158fd`：实现后**6文件94项通过、0失败、0skip**（新隔离admission 22项 + 契约28项 + outbox/worker/report 44项）。真实独立MySQL8.4.10、随机隔离schema，无生产表读写或模型调用。

```bash
INVESTIGATION_TEST_MYSQL_PORT=<隔离端口> INVESTIGATION_TEST_MYSQL_PASSWORD=<测试凭据> \
REPORT_TEST_MYSQL_PORT=<同一隔离端口> REPORT_TEST_MYSQL_PASSWORD=<测试凭据> \
pnpm --filter slide-api exec vitest run \
  src/investigations/store.mysql.test.ts src/investigations/contracts.test.ts \
  src/workflows/outbox-service.test.ts src/workflows/outbox-service.mysql.test.ts \
  src/workflows/worker-runtime.test.ts src/workflows/report-recovery.mysql.test.ts
pnpm --filter slide-api typecheck
pnpm exec oxlint apps/db-ops-api/src/investigations/store.ts \
  apps/db-ops-api/src/investigations/store.mysql.test.ts
bash scripts/qualification/run-report-recovery.sh
```

typecheck、focused oxlint与diff检查通过。初次typecheck发现夹具对非generic execute传了类型参数，已修正并重跑。现有隔离qualification脚本加入store测试，并支持原REPORT测试环境变量；本地该脚本**3文件42项通过、0skip**。CI通过此脚本实际执行SQL fixture，而不只是默认跳过环境测试。

22项覆盖：100同键唯一request/job/outbox；100不同键只有一个活动请求；3种hash冲突；version conflict；3处真实trigger故障全回滚及重试；SQL夹具grant撤销后幂等重试也拒绝；Session唯一；键空白/actor namespace隔离；缺authorizer/pool fail closed；未知调查回滚；关闭/归档拒绝；6类非法输入。

grant测试使用SQL-backed **测试授权表**，只证明必调端口的控制流，不是现有JWT/Actor/RBAC/多资源/Profile/Session授权验收，也不把它当作auth领域clear。schema夹具唯一约束不替代正式migration/升级验收。尚未验证授权先于列表count/limit、patch版本竞争、真实Session append或公开HTTP链路。

## 恢复条件

MAX-140协调T03/MAX-144的FINAL-0126/0127有界修复与auth/actor/session领域准入，避免T03完整任务依赖T02而T02 HTTP又被授权门禁阻塞的循环；再明确正式schema、Session/消息事务端口与文件所有权。此后复用本admission候选补create/list/detail/patch、迁移与HTTP安全接入，以及完整T02当前head CI/真实验收/正常合并。

没有扩大到T03修复、V2/V3、生产操作或付费资源；未派生代理。实际token/费用遥测不可用。草稿PR的当前head/CI及尚未合并状态以Issue交付中的实测记录为准。
