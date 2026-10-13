# T05 后台完成事务修复验收

2026-10-13，MAX-147 / PR #158。修复对象为父审查 v1.2.8 在 head `1ea8326d35d2842c27d5fb75bad5a92873624161` 确认的后台结果缺口。继续原 PR，不释放后续阶段；父独立差异审查及普通合并/main 核验仍为门禁。

## 修复与兼容

`AgentRunService` 保留唯一 Run 终态写入所有权。正式完成事务在同一 MySQL connection 上提交最终消息/Parts、V2/result.persisted、run.terminal、Run 状态和调查状态；result.persisted 的持久 sequence 先于 run.terminal。任一步失败整笔回滚，先前 completionPending 答案意图保留。`InvestigationExecutor` 在实时权限、取消与 lease/fence 仍有效时抛出存储失败供后续 lease 恢复，不把已暂存答案转为 failed，也不重新调用模型。丢失 COMMIT ack 时复用原版本和原 Run。

snapshot/replay 已删除自动结果生成，只读取已提交版本。历史无结果记录不会因观察而被补造。旧 admitted request 未填写 context.subject 时，从其持久化 primary resource 取 subject，不伪造资源或 provenance。通用 Chat staging/recovery 不变；无公开契约或迁移变更。

有效权限下 partial/unknown 仅生成保守状态摘要，仍为 unverified/unconfirmed；取消和撤权不发布 V2，不恢复已撤回答案。状态摘要不包含模型 reasoning、staged 答案或未绑定证据派生内容。丰富结果和证据引用仍由原 ResultStore 验证原调查/request/Run 和实时资源 scope。收据结算/unknown 预算规则不变。

本次暂借的 T04 `agent-run-service.ts`、`executor.ts` 及恢复测试仅触达上述完成装配，锁序仍为 Session → Investigation → Request → Job → Run，完成末尾重新检查 lease。修复结束后共享文件归还原 owner。

## 验收证据

- 父 RED patch 在本任务隔离 mysql:8.4、正式 MigrationRunner、实际 executor 上复现：首次观察前 result 为 0，1 个选中测试失败，18 个未选中；未选中不计完整 gate 的 skip 或通过。
- 将 RED 变为正式原后台集成测试：零观察者时已经存在 V2/result.persisted/run.terminal，结果先于终态；snapshot/restart 不增加版本。
- 四个真实 SQL trigger 故障点：最终 assistant 消息 INSERT、V2 INSERT、终态事件 INSERT、调查状态 UPDATE。结果/消息/事件/Run 原子回滚，completionPending 保留；新 fenced lease 恢复版本 1，Provider/tool 调用均为 0；重复恢复不增版本。
- 真实 OS SIGKILL：手工及 service 两条通道覆盖 completionPending 后、结果/终态 SQL 后但 COMMIT 前、COMMIT 后 ack 前。复用现有 sent unknown/工具/response_ready 矩阵；恢复与终态重读均零模型重发，原结果 ID/version 不变。未 COMMIT 写入由真实 InnoDB 回滚。
- 追问产生第二 request、第二 Run、第二版本，第一版本逐字段不变。
- 暂存答案后取消、全部资源 scope 中一项撤销、operator membership 撤销、主体停用：零调用、无 assistant/V2、staged event 移除；恢复权限后的 snapshot/replay 不重新发布答案。
- 实际 JWT/HTTP/DirectAdapter WS、T04 Chromium 浏览器关闭/退出、canonical/引用/版本/撤权/unknown/v1 reader 联合模块：**8 文件、235 passed、0 skipped**。新测试已进入既有 `run-agent-runtime.sh --mode mysql` qualification gate。
- `security:agent`：**17 文件、187 passed、0 skipped**；API typecheck、contracts:check、qualification:matrix、secret scan、diff check 通过；lint 263 warnings、0 errors。
- 干净 PR 候选后端全量：**338 文件通过、40 文件环境跳过；3288 passed、591 skipped、0 failed**。候选复用相同 lockfile/现有 node_modules，仅关闭候选路径差异引起的 pnpm 自动重装检查，没有更改依赖。agent-core/前端源码、依赖和公开契约均未变化，复用原 head 已核验的 core 675、前端757及 typecheck/build 证据；最终 CI 另按当前 head 执行仓库门禁。

```bash
AGENT_RUN_TEST_MYSQL_PORT=62361 AGENT_RUN_TEST_MYSQL_PASSWORD='' \
AUTH_TEST_MYSQL_PORT=62361 AUTH_TEST_MYSQL_PASSWORD='' T04_BROWSER_TEST=1 \
JWT_SECRET_KEY=t05-isolated-fixture-jwt-key-not-for-production-use \
pnpm --filter slide-api exec vitest run \
  src/investigations/observation.mysql.test.ts src/investigations/routes.test.ts \
  src/adapter/__tests__/investigation-canonical.mysql.test.ts \
  src/investigations/execution-recovery.mysql.test.ts \
  src/investigations/stream.test.ts src/investigations/evidence-store.test.ts \
  src/investigations/result-schema.test.ts src/analysis/analysis-evidence-binding.test.ts
```

使用 loopback 上独立短生命周期 mysql:8.4 和随机 test schema，正式迁移、真实事务/锁，afterAll 删除 schema。Provider/工具为受控本地合成 fixture，无外部模型调用或生产操作。既有 T04 真实模型预算累计 5/6、成功停发记录不变。测试集合重叠，不合计；普通全量的环境 skips 不能代替本次明确开启的真实模块。token/费用实测遥测不可用。T12 全 V1 gate 未完成。
