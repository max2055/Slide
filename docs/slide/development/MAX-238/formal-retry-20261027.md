# MAX-238：一次性库上证明重复请求不会再执行一次

2026-10-27。本包补验收句「正式任务受理后可追溯到真实采集样本；重复请求/超时重试无重复执行」的后半段证据：仍在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，复用现有 `MetricScheduler`、`WorkerRuntime`、`MysqlScheduleStore` 和 `MysqlWorkflowStore.enqueue`，对实例 1（`mysql3306`）和服务器 3（`192.168.49.130:22`）各排一次正式调度任务，再用**已有字段**证明重复 tick 与重复 idempotency key 都不会新增任务。不改调度器、worker、routes、模板、绑定、策略、migration、前端或 `config/access.ts`，未改表。

## 结论

- 新增 `apps/db-ops-api/src/metrics/scheduler/formal-retry.mysql.test.ts` 在真实目标上通过：`1 passed`（测试 16.52s，总 17.27s）。
- 两个任务都经现有队列受理并 `completed`：实例 1 job `4737fdb2-6edf-429c-bb38-7130dda8bbbf`（30 条正式观测）；服务器 3 job `96ef605c-a903-4db9-a885-a24acaeb8045`（82 条正式观测）。两者 fencing token 均为 1、`attempts=1`。
- **任务尚在队列时再次 `tick()`**：返回 0；两个 `resource_key` 的 `metric_schedule.job_id` 保持首次 id，`workflow_jobs` 仍是两行（状态 `queued`，尚未 claim，fencing token 为 0）。
- **两个 worker 都 `completed` 后立刻再 `tick()`**：返回 0；`metric_schedule.job_id` 均为 `NULL`，`next_due_ms` 已被 `commit` 推到间隔之后；`workflow_jobs` 仍是两行，每个资源仍只有一个 job id、一个 fencing token（1），观测集合不变（30 / 82）。
- **重复 idempotency key**：用已完成行的现有 key、不同的新 UUID 再调 `MysqlWorkflowStore.enqueue`，`uq_workflow_job_idempotency` + `ON DUPLICATE KEY UPDATE id = id` 生效，key 仍只对应原来的 job id、状态仍 `completed`，`workflow_jobs` 仍两行，新 id 未落库，观测集合不变。
- 应用库 3306 未写入：采集前后 `database_instances` 5 行、`servers` 1 行、服务器 3 `host=192.168.49.130` / `port=22` / `collection_enabled=1`、`instance:1` revision 4、`server:3` revision 3 逐项一致；两个新 job id 在应用库的 `workflow_jobs`、`metric_schedule_events`、`metric_attempts`、`metric_observations` 中均为 0 行。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `d8e3e1b3204158cc97245edeee0837f1222a8c39` |
| 测试提交 | `195f0c2ee8acec496475341c46341ae4968e30bb`（证据 `run.head` 即此 SHA） |
| 测试文件 | `apps/db-ops-api/src/metrics/scheduler/formal-retry.mysql.test.ts` |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_formal_retry_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 凭据来源 | 应用库行内既有密文，`decryptData` 解密后 `encryptData` 写进一次性库自己的行；未打印、未提交口令或密钥 |
| 实例目标 | id=1，`mysql3306`，`localhost:3306`（测试内断言名称与端口） |
| 服务器目标 | id=3，`192.168.49.130:22`（测试内断言主机与端口） |
| 采集包 | `mysql-diagnostics@1.1.0`、`linux-host@1.1.0` |
| 来源库写入 | 仅 `SELECT`；`databaseService.addConnection` 只建连接与 `ping` |

运行命令（授权环境文件路径运行时通过 `SLIDE_DEBUG_ENV_FILE` 传入，不落仓库）：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
pnpm exec vitest run src/metrics/scheduler/formal-retry.mysql.test.ts
```

## 2. 三步证明（真实目标，一次性库）

### 2.1 任务仍在队列时再次 tick

首次 tick 扫描到两个资源到期后入队（真实 jitter，循环扫描直到两行 `queued`）。此时 `workflow_jobs` 两行状态均为 `queued`，尚未被任何 worker claim：

| resource | `metric_schedule.job_id` | `workflow_jobs.state` | fencing token |
|---|---|---|---|
| `instance:1` | `4737fdb2-…` | `queued` | 0（未 claim） |
| `server:3` | `96ef605c-…` | `queued` | 0（未 claim） |

再次 `scheduler.tick()` 返回 **0**；两行 `metric_schedule.job_id` 保持首次 id；`workflow_jobs` 仍两行。现有 store 对非 `completed`/`dead_letter`/`cancelled` 的 pending job 直接拒绝入队（`store.ts` 的 `enqueue` 早退分支），没有新任务。

### 2.2 两个任务完成后立刻再 tick

两个 worker 各跑一次，返回值 `['completed', 'completed']`。`commit` 在同一事务里清空 `metric_schedule.job_id` 并把 `next_due_ms` 推到完成时刻 + 间隔（实例 `1793115496562`、服务器 `1793115500001`，均晚于即时 tick 的当前时间）。

| resource | job id | fencing token | attempts | 正式观测 |
|---|---|---|---|---|
| `instance:1` | `4737fdb2-6edf-429c-bb38-7130dda8bbbf` | 1 | 1 | 30 |
| `server:3` | `96ef605c-a903-4db9-a885-a24acaeb8045` | 1 | 1 | 82 |

完成后立刻 `tick()` 返回 **0**：`workflow_jobs` 仍两行、id 与 fencing token 不变；`metric_schedule.job_id` 仍为 `NULL`；按 `${job.id}:${fencingToken}:` 前缀统计的观测数仍为 30 / 82，没有增加。

### 2.3 重复 idempotency key

读出已完成任务在 `workflow_jobs.idempotency_key` 上的现有值（`metric:instance:1:<job id>`、`metric:server:3:<job id>`），用 `MysqlWorkflowStore.enqueue` 分别提交同 key、不同新 id：

| resource | 原 job id | 重放尝试的新 id | key 对应行数 | 状态 | 观测（前/后） |
|---|---|---|---|---|---|
| `instance:1` | `4737fdb2-…` | `5d41b66c-…` | 1 | `completed` | 30 / 30 |
| `server:3` | `96ef605c-…` | `c703f143-…` | 1 | `completed` | 82 / 82 |

`uq_workflow_job_idempotency` + `ON DUPLICATE KEY UPDATE id = id` 未新增行；`workflow_jobs` 仍两行，新 id 查不到，观测集合不变。未新造第二套 key、未加列、未改表。

## 3. 只读与清理证明

| 项 | 采集前 | 采集后（测试内断言） | 测试结束后独立只读复核 |
|---|---|---|---|
| `database_instances` 行数 | 5 | 5 | 5 |
| `servers` 行数 | 1 | 1 | 1 |
| 服务器 3 `host` / `port` | `192.168.49.130` / 22 | 同左 | 同左 |
| 服务器 3 `collection_enabled` | 1 | 1 | 1 |
| `instance:1` revision | 4 | 4 | 4 |
| `server:3` revision | 3 | 3 | 3 |

- 来源库连接只执行 `SELECT`；凭据复制是解密后写一次性库，未对 3306 的 `database_instances`、`servers`、`metric_policy_bindings` 做 `INSERT`/`UPDATE`/`DELETE`。
- 两个新 job id 在应用库的 `workflow_jobs`、`metric_schedule_events`、`metric_attempts`、`metric_observations` 中均为 **0 行**；3306 上没有 `max238%` 库。
- 一次性库建在 13306，`afterAll` 执行 `DROP DATABASE`；独立复核时 13306 上也没有残留 `max238%` 库。
- 测试在开始时即断言上表基线；任一变化直接失败，不做写回补救。

## 4. 环境放宽保持不变

- `mysql.innodb.deadlocks_total` 继续 `null`，没有补 0。
- 复制无通道，未产出 `mysql.replication.*` 序列。
- `linux.block.io_time_ms_total` 单位保持 `ms`，不做速率转换。
- 未打开真实 SNMP，未测网络设备。
- SSH 单测夹具没有端口和口令时继续跳过。

## 5. 未覆盖

- 这是正式调度任务在**一次性库**上的真实采集与重复请求证明，不是线上绑定切换、生产发布、健康判定或告警。
- 未测租约接管、死信、切换、回退、停写或 SNMP；间隔到期后的下一次正常采集未当作失败。
- 未改线上绑定/采集开关，未跑浏览器、未跑全量；`MAX238` 整单保持 `in_progress`。
- 证据文件：`docs/slide/development/MAX-238/formal-retry-20261027.json`（三步证明、job/观测计数、只读前后快照、重放结果）。
