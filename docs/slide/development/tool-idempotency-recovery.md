# 工具幂等身份与中断对账

适用范围：`slide_add_database_batch`，迁移 `156_agent_tool_recovery.sql` 及其配套代码。

## 部署与身份

先停止接收新的批量请求，等待旧版本在途批量结束，再运行正常数据库迁移入口并启动新版本。旧版本没有所有者和心跳，无法证明其仍在运行；遗留的 running 行在新版本同键查询时会转为 unknown。迁移不能与仍会执行旧版工具的进程并行发布。

新记录使用 hash_version=2，以 UTF-16 码元比较键名，递归规范化对象，保留数组顺序，再计算 SHA-256。旧记录保留 hash_version=1 和原摘要；读取时尝试当前 ICU 支持的双/三字母语言排序及常见区域排序（包含 en-US、da-DK、zh-TW、zh-HK、de-AT、sv-FI），匹配后复用原结果，不改写旧摘要或持久化原始参数。历史运行时的特殊排序或 ICU 版本差异若无法重建，返回 `IDEMPOTENCY_IDENTITY_UNVERIFIED`，`retryable=false`，保留原键和记录并人工核对，禁止通过换键重放解决。历史行只有摘要，不能区分参数变化和无法重建的排序，两种情况都保守拒绝且不返回旧结果；v2 行摘要不同仍明确返回 `IDEMPOTENCY_KEY_CONFLICT`。迁移前后均不以哈希切换清空历史记录。

## 所有权与检查点

- 成功 INSERT 获得唯一随机 owner_token，重复 INSERT 不能获得执行权，与 mysql2 FOUND_ROWS 配置无关。
- 租约由数据库时钟确定，为 60 秒；执行期间每 10 秒心跳续期。心跳、检查点及 finish 均检查所有者、参数摘要、running 状态和有效租约。过期执行者无法续期或覆盖结果。
- 每项调用前先保存 started；调用返回后保存 completed 和逐项结果。并发条目通过 JSON_SET 独立更新路径，避免覆盖其他条目的检查点。未保存 started 的条目不会开始调用。在 started 回执返回后、实际 handler 调用前重新检查全批停止状态；其他检查点失败或心跳失效后，即使延迟回执成功也不再启动条目，已在途结果继续保全。
- 同键查询发现租约过期，仅原子转为 unknown，保留所有者和检查点，不抢占、不重放。状态转换在查询时发生，无后台扫描器。
- finish 的确认丢失时，响应保留全部已取得的逐项结果，返回 `IDEMPOTENCY_RESULT_UNCONFIRMED`、`persistenceConfirmed=false`、`retryable=false`；存储故障期间不启动后续条目。仍在途的条目会收集返回结果。
- 已有 failed 行也作为 unknown 对待，避免把历史失败误当成确定没有副作用。

## 对账步骤

1. 保存当前响应。使用相同操作员、会话、工具和幂等键查询；running 返回 `IDEMPOTENCY_IN_PROGRESS`，unknown 返回 `IDEMPOTENCY_OUTCOME_UNKNOWN` 和 `details.checkpoint`。租约尚未过期时等待，不重复执行。
2. 对 checkpoint.items 中 state=completed 的条目，按 result.instanceId、名称及主机/端口/数据库名核实平台记录。completed 仅表示该项 handler 已返回，应继续查看 result.status/errorCode；未知创建结果仍需人工核实。
3. state=started 且无结果的条目可能已经提交创建，必须对账。对于本版本创建且有检查点的记录，缺少 started 的条目尚未调用；旧版本 checkpoint 为 NULL 时不能作此推断。
4. 仅在确认条目没有执行且业务仍需要时，单独提交这些条目。禁止整批重试，禁止换键重放成功或未知条目。当前实现不提供自动接管、自动重置 unknown 或自动写入人工对账结论的接口。

可由授权运维人员进行只读查询，参数须经驱动绑定，避免将凭据或原始请求写入日志：

```sql
SELECT state, owner_token, lease_until, arguments_hash, hash_version,
       checkpoint_json, result_json, updated_at
FROM agent_tool_idempotency
WHERE actor_id = ? AND session_hash = ? AND tool_name = ? AND idempotency_key = ?;
```

## 可执行验证

默认回归（不读取本机凭据）：

```bash
pnpm --filter slide-api exec vitest run src/security/agent-tool-idempotency-service.test.ts src/tools/generated/slide-self-mgmt/add_database_batch.test.ts
pnpm --filter slide-api typecheck
```

显式注入 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD` 后运行真实 MySQL 验收，不能指向共享业务库。脚本创建随机独占数据库并在 finally 中关闭连接、删除自身数据库；不操作已有业务数据库：

```bash
pnpm --filter slide-api exec tsx tests/tool-idempotency.integration.ts
pnpm --filter slide-api exec tsx tests/tool-recovery.integration.ts
```

前者验证默认/禁用 FOUND_ROWS 的跨连接竞争、冲突和完成结果重放。后者验证完整旧版空库安装、带历史记录升级及重复迁移、两个真实 locale 进程、真实 batch → add_database → instance service → MySQL 待凭据实例创建，以及抢占后、部分完成后、写入后未记结果、finish 前的 SIGKILL。存活执行者保护观察一次真实心跳；失联后的到期测试只提前本任务记录的租约，不修改系统时钟。该验收不调用模型，不证明目标数据库认证连接或生产发布已通过。
