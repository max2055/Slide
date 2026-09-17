# 已批准 SQL 的持久意图与对账

上线前通过现有迁移 runner 应用 `091_sql_execution_intents.sql`。表不可用、控制库不可写或意图提交未获确认时，SqlExecutor 不下发写 SQL；没有内存降级。最新 main 复核基线为 `ef85a08`，该版本尚无统一控制库 capability 接口；当前以真实事务提交作为能力证明，兼容 `dbConnection.getPool()` 与既有审计接口。

控制库账本保存完整 SQL、instance、database、operation、approval、reviewer、actor。userId 缺失时采用已验证 reviewer。审批锁内复核 SQL 哈希、实例、库、reviewer、operation、状态和有效期。operation 与 approval 均唯一，任何重复调用都不能重新下发；唯一记录不得删除作为重试手段。

意图初始状态为 `unknown`：进程可能尚未下发、正在运行，或已提交但尚未记录结果。只有目标驱动返回、审计调用完成、结果持久化成功后才为 `succeeded`。审计中心仍是既有日志接口；执行账本是本功能的持久证据，不依赖其内存/持久配置。异常返回包含 operationId、`executionState=unknown`、`retryable=false`，不能理解为回滚。审批/operation 保持执行中，避免自动失败重试。SELECT 审计保持 best-effort。

## 恢复步骤

1. 根据返回的 operationId，在后端目录使用控制库环境配置运行：
   `pnpm exec tsx scripts/sql-intent-recovery.ts inspect <operationId>`。
   输出含完整 SQL，应仅由有控制库访问权限的管理员查看，不粘贴到公开日志。
2. 先停止或隔离原执行进程，并确认目标数据库已无该语句运行；不要仅凭记录年龄判断已经终止。检查目标审计/binlog/事务记录以及业务数据，判断是否已生效。MySQL `max_execution_time` 只限制 SELECT，绝非 DML/DDL 硬超时。
3. 有明确证据后，将证据写入文件，执行：
   `pnpm exec tsx scripts/sql-intent-recovery.ts reconcile <operationId> <applied|not-applied> <operator> <evidence-file> --executor-fenced`。
   命令只更新控制库对账证据，不连接目标库、不重放 SQL，也不自动改写审批/operation 生命周期。按原工单人工关闭/补偿审批和 operation；不要将其重置为 pending。
4. 无法确认时保留 unknown 并继续调查。确认未执行而需要再次执行时，必须重新发起审批和新的 operation，不复用旧批准。确认生效则不得再次执行；补偿同样需新的审批。

这不是跨库原子事务或 exactly-once。控制库恢复到旧备份也可能丢失去重记录；恢复备份后须先停止执行入口并与目标库对账。

## 验证

在专用临时 MySQL 8.4 实例（空 root 密码、仅绑定 loopback；不要连接应用实例）执行：

```sh
SQL_INTENT_TEST_PORT=13358 pnpm --filter slide-api exec vitest run tests/sql-intent.mysql.test.ts src/sql-executor.security.test.ts src/approval-service.test.ts src/security/approval-execution-authorizer.test.ts
pnpm --filter slide-api typecheck
```

测试使用独立 `max58_control` / `max58_target` schema，覆盖真实目标变化、意图不可用、批准篡改、并发重复、结果写入故障、审计故障及新进程读取恢复。测试只注入审计接口失败与控制库访问中断，不宣称覆盖磁盘断电持久性。
