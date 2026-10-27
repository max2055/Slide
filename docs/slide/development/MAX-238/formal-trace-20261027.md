# MAX-238：一次性库上的正式任务追溯到真实样本

2026-10-27。本包补「正式任务受理后可追溯到真实采集样本」的证据：用现有 `MetricScheduler`、`WorkerRuntime` 和 `MysqlScheduleStore.commit`，对实例 1（`mysql3306`）和服务器 3（`192.168.49.130:22`）各跑一次正式调度任务，观测只写一次性库，再用**已有字段**把 job 查回观测。不新写采集器，不改路由、模板、绑定、策略、migration、调度器源码、前端或 `config/access.ts`。

## 结论

- 新增 `apps/db-ops-api/src/metrics/scheduler/formal-trace.mysql.test.ts` 在真实目标上通过：`1 passed`，16.1s。
- 两个任务都经现有队列受理并 `completed`：实例 1 job `2b1d8761-71b4-4733-a8bc-0a46fea849a7`（fencing token 1，549ms，14 次逻辑读取，14 个 attempt，**30** 条正式观测）；服务器 3 job `bb802749-bef3-4c2a-b0bc-b36cbb6b7658`（fencing token 1，3464ms，16 次逻辑读取，8 个 attempt，**82** 条正式观测）。
- 追溯只用现有字段：`metric_schedule_events.job_id` 取任务号，`workflow_jobs.fencing_token` 拼出 `attempt_id` 前缀 `${job.id}:${fencingToken}:`，再按 `metric_observations.payload.source.attempt_id` 前缀找回该任务的每条观测。没有加列、没有新 DDL。
- 应用库 3306 未写入：`database_instances` 5 行、`servers` 1 行、服务器 3 `collection_enabled=1`、`instance:1` revision 4、`server:3` revision 3，采集前后逐项一致（测试内断言，失败即停）。
- 缺测保持 `null`，没有补 0：共 7 条 —— `mysql.innodb.deadlocks_total` 1 条、首轮速率派生 4 条（`mysql.queries.per_second`、`mysql.transaction_commands.{commit,rollback,completed}_rate`）、`linux.filesystem.inode_used_percent` 2 条。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `b7dbabbca2b25342c93a13503f77d1776c3ccf24` |
| 测试提交 | `c9cc5d347bbfd4f4b3b733a40c5a3f309cb8b21c`（证据 `run.head` 即此 SHA） |
| 测试文件 | `apps/db-ops-api/src/metrics/scheduler/formal-trace.mysql.test.ts` |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性容器），库名 `max238_formal_trace_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 凭据来源 | 应用库行内既有密文，`decryptData` 解密后 `encryptData` 写进一次性库自己的行；未打印、未提交口令或密钥 |
| 实例目标 | id=1，`mysql3306`，`localhost:3306`，MySQL 9.6.0 |
| 服务器目标 | id=3，`192.168.49.130:22`（密码认证） |
| 采集包 | `mysql-diagnostics@1.1.0`、`linux-host@1.1.0` |
| 来源库写入 | 仅 `SELECT`；`databaseService.addConnection` 只建连接与 `ping` |

运行命令（授权环境文件路径运行时通过 `SLIDE_DEBUG_ENV_FILE` 传入，不落仓库）：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
pnpm exec vitest run src/metrics/scheduler/formal-trace.mysql.test.ts
```

## 2. 追踪链

| resource | job id（`metric_schedule_events.job_id`） | fencing token | attempt_id 前缀 | attempt 数 | 正式观测数 | commit 事件 |
|---|---|---|---|---|---|---|
| `instance:1` | `2b1d8761-71b4-4733-a8bc-0a46fea849a7` | 1 | `2b1d8761-…:1:` | 14 | 30 | `committed` |
| `server:3` | `bb802749-bef3-4c2a-b0bc-b36cbb6b7658` | 1 | `bb802749-…:1:` | 8 | 82 | `committed` |

- `metric_schedule_events` 里每个资源只有一条 `committed`，`job_id` 与 `workflow_jobs.id` 一致，任务状态 `completed`、`attempts=1`。
- `metric_attempts.id` 为 `${job.id}:${fencingToken}:${collectorId}`，与观测 `source.attempt_id` 完全一致；测试逐条断言前缀匹配，没有按时间窗或指标名猜测归属。
- 观测时间范围 `2026-10-27T15:18:16.997Z` – `2026-10-27T15:18:20.805Z`，与两条 commit 事件的 549ms / 3464ms 一致。

## 3. 真实样本（代表项，全量见 JSON）

实例 1（mysql3306），观测 30 条：

| metric | value | unit | quality |
|---|---|---|---|
| `db.uptime_seconds` | 142686 | s | good |
| `mysql.processlist.count` | 13 | count | good |
| `mysql.queries.total` | 16922864 | count | good |
| `mysql.buffer_pool.pages_used_percent` | 96.875 | % | good |
| `mysql.innodb.deadlocks_total` | null | count | unknown |

服务器 3（192.168.49.130），观测 82 条：

| metric | value | unit | quality |
|---|---|---|---|
| `linux.uptime.seconds` | 214725.47 | s | good |
| `linux.memory.used_bytes` | 899203072 | By | good |
| `linux.block.io_time_ms_total`（nvme0n1） | 2160 | ms | good |
| `linux.filesystem.used_ratio`（各挂载点） | 0 – 0.372 | 1 | good / partial |

每条观测在 JSON 中带 `job_id`、`fencing_token`、`attempt_id`、`observation_id`、`operation_id`（collector）、`metric_id`、`value`、`unit`、`quality`、`observed_at`、`config_revision`。

## 4. 只读与清理证明

| 项 | 采集前 | 采集后 |
|---|---|---|
| `database_instances` 行数 | 5 | 5 |
| `servers` 行数 | 1 | 1 |
| 服务器 3 `collection_enabled` | 1 | 1 |
| `instance:1` revision | 4 | 4 |
| `server:3` revision | 3 | 3 |

- 来源库连接只执行 `SELECT`；凭据复制是解密后写一次性库，未对 3306 的 `database_instances`、`servers`、`metric_policy_bindings` 做 `INSERT`/`UPDATE`/`DELETE`。
- 一次性库建在 13306，未在 3306 建库；`afterAll` 执行 `DROP DATABASE`，容器随后移除。
- 测试在开始时即断言上表基线；任一变化直接失败，不做写回补救。

## 5. 环境放宽保持不变

- `mysql.innodb.deadlocks_total` 仍为 `null`，没有补 0。
- 复制无通道，未产出 `mysql.replication.*` 序列（本包观测里 0 条）。
- `linux.block.io_time_ms_total` 单位保持 `ms`。
- 未打开真实 SNMP，未产出网络设备指标。
- 未跑试采夹具的端口/口令跳过逻辑；本包不涉及网络设备。

## 6. 未覆盖

- 这是正式调度任务在**一次性库**上的真实采集与追溯，不是线上绑定切换、生产发布、健康判定或告警。
- 未改线上绑定/采集开关，未跑浏览器、未跑全量；`MAX238` 整单保持 `in_progress`。
- 证据文件：`docs/slide/development/MAX-238/formal-trace-20261027.json`（逐条观测、job/attempt 链、只读前后快照）。
