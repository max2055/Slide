# Agent 工具审批消费与恢复

MAX-57；适用于启用审批的 Agent 工具。全局开关、once/high-risk、已有 on-risk binding 兼容规则、session/window 作用域均保持原样。

## 执行顺序与部署

部署前运行迁移 `094_agent_tool_execution_intents.sql`；缺表时执行会 fail closed，不调用 handler。

1. 解析资源并验证静态权限、资源作用域和 Agent policy；拒绝不进入消费事务。
2. 在同一 MySQL 连接和事务中锁定审批行，重新检查过期、撤销、binding、风险及次数；原子消费，插入 UUID 执行意图，并持久化最终决策审计。任一步失败则回滚，handler 不执行。并发 once 请求只有一个能够成功。
3. 提交后立即检查取消。已取消且尚未进入 handler 时，用该次执行的唯一 receipt 在事务内标记 `released` 并退回本次消费。重复退款无效；不改变 rejected/expired 状态，不延长期限，不修改 binding 或 scope，不退回其他并发调用的消费。
4. 最后一次取消检查与 handler 调用之间没有 await。进入 handler 后，即便抛错也不自动退款，因为异常之前可能已有外部副作用。
5. 结果审计持久化后将意图置为 `finished`。结果审计或状态写入失败时保留 `dispatching`；execute_code 继续遵循结果审计失败不返回输出的原有规则。

意图状态的含义：`dispatching` 是已提交的执行许可，**不证明 handler 已执行或未执行**；`released` 是当前调用已证明未调用 handler 并退还消费；`finished` 表示 handler 返回或抛错且结果审计已写入，是否成功须查看 result 审计。

## 恢复规则

- 审批仍为 approved、无已消费的未决意图：修复审计/存储后使用原 approvalId 重试，无须重新审批；仍需通过当前权限和有效期检查。
- 取消已成功退款：可使用原 approvalId 重试；到期或已撤销仍拒绝。
- handler 已进入后失败：检查 result 审计及实际目标状态。确认需要再次执行后，去掉原 approvalId 重新提交请求并由操作者审批。不得重新开放 consumed 审批。
- 崩溃、提交确认丢失、退款失败或结果审计缺失：通过 approvalId、requestId 查询意图及审计，并检查目标系统副作用；停止该旧执行者后再由操作者确认重试。保留旧审批和意图，使用新的审批，不根据超时自动退款或重放。退款失败返回 executionId 和明确 recovery 提示；提交错误返回 approvalId/requestId 以便查证。

MySQL 与外部 handler 无法形成分布式原子提交。提交与 handler 之间崩溃可能消耗批准但没有副作用；此窗口保守视为未知，需要上述人工核对。没有后台自动退款任务，也没有可绕过审批的恢复接口。

`consumed_at` 保留消费尝试时间；恢复后的授权有效性以 status、used_count、expires_at 和意图状态为准。一次审批原有 used_count=0 的表示保持兼容，消费状态由 status 表示。

## 验证

普通 focused checks：

```sh
cd apps/db-ops-api
pnpm exec vitest run src/tools/policy.test.ts src/security/agent-tool-approval-service.test.ts src/security/agent-tool-audit-service.test.ts
```

真实存储检查（专用 MySQL 8.4、localhost root 无密码，仅用于临时测试容器）：

```sh
docker run -d --name slide-approval-test -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1::3306 mysql:8.4
docker port slide-approval-test 3306
# 以输出端口替换 PORT，确认 mysqladmin ping 成功后执行：
APPROVAL_TEST_MYSQL_PORT=PORT pnpm exec vitest run src/security/agent-tool-approval-execution.mysql.test.ts
# 测试建立随机命名数据库并在结束时删除，之后停止并删除临时容器。
```

未配置端口时真实存储套件显式 skip，不能作为真实原子性验收通过的证据。
