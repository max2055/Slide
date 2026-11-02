# MAX-238：一次性库上证明组合监控项和参数来源链

2026-10-28。本包在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `PolicyService.changeBinding`、现有 `changeGroup` 和现有 `resolvePolicy` 的读回结果，证明验收句「展示组合监控项、参数默认/覆盖/最终值及来源链；冲突必须解决，不能后绑定覆盖前绑定」。只准备一个资源行：实例 1（`db_type=mysql`、`db_version=8.0.46`），口令列留空；没有调用真实主机，没有调用 `activate`，没有使用 3306。未改 `config/service.ts`、`policy/service.ts`、`policy/model.ts`、`resolver.ts`、`policy/store.ts`、routes、registry、builtins、migration、前端或 `config/access.ts`；没有为「组合」新建多模板保存，也没有把一次 publish 改成保存多个 package。

## 结论：三条全部成立

测试实际执行并通过（`Tests 1 passed (1)`，不是 `describe.skip` 跳过）。同一个 package pin `mysql-diagnostics@1.1.0` 贯穿三次参数读回；冲突那一刻产品返回 `POLICY_UNKNOWN_METRIC`，读回没有半写。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `1c2a331bd2e996ad01a9412d9a18de55d54e7e38` |
| 测试提交 | `2feb02f1dbf86eaaa222f08821e2e950a4bdbf88` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/source-chain.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/source-chain-20261028.json`（测试写出） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_source_chain_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 资源行 | `instance:1`（`mysql` / `8.0.46`，状态 `active`+`available`） |
| 凭据 | 该行口令列留空；未解密、未打印任何口令或密钥 |
| 应用库 3306 | 未连接；本包不读写线上绑定或采集开关 |

运行命令：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/source-chain.mysql.test.ts
```

## 2. 逐条结果

### 2.1 组合监控项

发布 `mysql-diagnostics@1.1.0`（revision 1，无覆盖），读回 `resolved.metric_templates` 共 **33** 项，与「该 release 的采集映射（29 项）+ 派生输出（4 项）」按 `id@semantic_version` 排序后**完全相等**：既不是写死的一项，也没有带上另一个 package 的项（抽查 `host.filesystem.used_bytes@1.0.0` 不在读回里）。

4 个派生项：`mysql.transaction_commands.commit_rate@1.0.0`、`mysql.transaction_commands.rollback_rate@1.0.0`、`mysql.transaction_commands.completed_rate@1.0.0`、`mysql.queries.per_second@1.0.0`，来源 kind 都是 `derived`。

读回名单（`metric | source_kind | enabled | required_dimensions`）：

```text
mysql.processlist.count@1.0.0                       | collector | true |
mysql.connections.limit@1.0.0                       | collector | true |
mysql.transaction_commands.commit_total@1.0.0       | collector | true |
mysql.transaction_commands.rollback_total@1.0.0     | collector | true |
mysql.tables.estimated_allocated_bytes@1.0.0        | collector | true |
mysql.queries.total@1.0.0                           | collector | true |
mysql.slow_queries.total@1.0.0                      | collector | true |
mysql.protocol.received_bytes_total@1.0.0           | collector | true |
mysql.protocol.sent_bytes_total@1.0.0               | collector | true |
mysql.handler.read_next_total@1.0.0                 | collector | true |
mysql.connections.aborted_total@1.0.0               | collector | true |
mysql.buffer_pool.pages_used_percent@1.0.0         | collector | true |
db.uptime_seconds@1.0.0                             | collector | true |
mysql.threads.running@1.0.0                         | collector | true |
mysql.threads.connected@1.0.0                       | collector | true |
mysql.files.open@1.0.0                              | collector | true |
mysql.key_cache.used_blocks@1.0.0                   | collector | true |
mysql.key_cache.unused_blocks@1.0.0                 | collector | true |
mysql.buffer_pool.read_hit_percent@1.0.0           | collector | true |
mysql.table_cache.hit_percent@1.0.0                 | collector | true |
mysql.key_cache.used_percent@1.0.0                  | collector | true |
mysql.innodb.row_lock_average_ms@1.0.0             | collector | true |
mysql.innodb.deadlocks_total@1.0.0                  | collector | true |
mysql.temporary.disk_tables_total@1.0.0             | collector | true |
mysql.thread_cache.hit_percent@1.0.0                | collector | true |
mysql.transactions.active@1.0.0                     | collector | true |
mysql.replication.behind_source_seconds@1.0.0       | collector | true | channel
mysql.replication.io_running@1.0.0                  | collector | true | channel
mysql.replication.sql_running@1.0.0                 | collector | true | channel
mysql.transaction_commands.commit_rate@1.0.0        | derived   | true |
mysql.transaction_commands.rollback_rate@1.0.0      | derived   | true |
mysql.transaction_commands.completed_rate@1.0.0     | derived   | true |
mysql.queries.per_second@1.0.0                      | derived   | true |
```

维度项留在模板里：3 个 `mysql.replication.*` 带必需维度 `channel`，只出现在 `metric_templates`，**没有**进入具体序列 `plan.entries`；具体条目为 30 项，全部是无必需维度的项，合计等于 33 − 3。

### 2.2 参数的默认值、覆盖值、最终值与来源链

同一个 pin 做三次读回，`interval_ms` 全部与来源层一致：

| 读回 | `interval_ms` 最终值 | 来源层 | 来源 id | binding 覆盖 | group |
|---|---|---|---|---|---|
| 默认 | 60000（= release 推荐值） | `package` | `mysql-diagnostics@1.1.0` | `{}` | 无 |
| 组覆盖 | 45000（= 组值） | `group` | `source-chain`（组 revision 1） | `{}` | `interval_ms=45000` |
| 资源覆盖 | 30000（= 资源值） | `resource` | `instance:1`（资源 revision 3） | `interval_ms=30000` | 仍为 `interval_ms=45000` |

- 默认：资源覆盖为空，也不挂会改该参数的组；最终值等于该 release 的推荐值 60000。`sources.interval_ms.id` 是 `mysql-diagnostics@1.1.0`——现有 package 来源身份就是 `id@version`，digest 仍保留在 binding pin 里。
- 组覆盖：组把 `interval_ms` 设为 45000（`timeout_ms` 5000 ≤ 45000，`stale_after_ms` 120000、`max_counter_gap_ms` 300000 ≥ 45000，仍满足现有时序约束）；最终值 45000、来源层 `group`；`registry.get(pin).recommendations.interval_ms` 读回仍是 60000，release 推荐值没有被改。
- 资源覆盖：资源把 `interval_ms` 设为 30000（与组值不同仍合法）；最终值 30000、来源层 `resource`。再把组读回来，组自己的覆盖仍是 `interval_ms=45000`，没有被这次资源绑定擦掉。
- 三次读回里 `max_concurrency`（最终值 1）和 `max_series_per_resource`（最终值 330）的来源层都是 `platform`，id `metrics-limits-v1`；平台上限没有被写成用户覆盖。

### 2.3 冲突不能被后一次绑定静默覆盖

监控项覆盖从注册表读，不猜键：取 `mysql-diagnostics@1.1.0` 有、`mysql-basic@1.1.0` 没有的监控项，排序后第一条是 **`mysql.buffer_pool.pages_used_percent@1.0.0`**（诊断包里有、basic 包里没有）。

1. 在前一个 pin 上保存该监控项覆盖：`overrides={metrics:{"mysql.buffer_pool.pages_used_percent@1.0.0":"disable"}}`，publish 成功，revision 3 → **4**；读回该监控项 `enabled=false`，`metric_sources` 来源层 `resource`。
2. 不带「明确清空覆盖」去 publish 后一个 pin（`mysql-basic@1.1.0`，`expected_revision=4`，不传 `overrides`，因此保留上一步的覆盖）：请求被后端拒绝，错误 **`POLICY_UNKNOWN_METRIC`（400）**——basic 不认识这个被继承下来的监控项。
3. 读回仍是前一个 pin `mysql-diagnostics@1.1.0`、原来的覆盖（`metrics` 那条 `disable`）、原来的 **revision 4**；绑定表仍 **1 行**，审计增量为 **0**，失败事务没有留下半写（前后完整 `binding` 对象逐字段相等）。

`overrides: {}` 这种「明确清空」是另一条已有契约，本包没有用它充当冲突，也没有改它。

## 3. 产品代码未改

- 本包只新增测试与两份证据；`config/service.ts`、`policy/service.ts`、`policy/model.ts`、`resolver.ts`、`policy/store.ts`、routes、registry、builtins、migration、前端、`config/access.ts` 均未改。内存测试已经锁过同类行为，本包没有在一次性 MySQL 上发现「内存通过、MySQL 失败」的差异，因此不需要最小修改 `policy/store.ts`。
- `service.ts` 未改；**没有调用 `activate`**，没有改「必要项失败阻止启用」判断，没有新增必需指标名单。
- **没有调用 3306**；没有写 3306 业务表；没有改线上绑定或采集开关。
- **没有停写、复制、切换、回退、解绑**。
- 没有跑浏览器、worker 或全量测试；没有开子代理。

## 4. 验证命令与结果

```text
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/source-chain.mysql.test.ts
Test Files  1 passed (1)
      Tests  1 passed (1)

pnpm exec tsc --noEmit
tsc_exit=0
```

一次性库已 `DROP DATABASE`；13306 的一次性容器已移除，端口无监听。本包不是生产发布、告警或整单验收；MAX-238 保持 **in_progress**。
