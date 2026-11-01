# MAX-238：一次性库上证明超时重试不会再执行一次

2026-10-27。本包补验收句「正式任务受理后可追溯到真实采集样本；重复请求/超时重试无重复执行」的后半段：在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，复用现有 `MetricScheduler`、`WorkerRuntime`、`MysqlScheduleStore` 和 `PolicyService.changeBinding`，对实例 1（`mysql3306`）和服务器 3（`192.168.49.130:22`）各跑一次真实 worker 尝试，用**已有字段**证明现有 `SCHEDULE_TIMEOUT` 会取消尚未结束的真实读取、不提交正式观测，且该 job 非终态时再 `tick()` 不会重新入队。未改调度器、worker、routes、模板、绑定、策略、migration、前端或 `config/access.ts`，未改表，未 mock `collect`。

## 结论

- 新增 `apps/db-ops-api/src/metrics/scheduler/formal-timeout.mysql.test.ts` 在真实目标上通过：`1 passed`（测试 13.16s，总 14.11s）。
- 一次性库内两个绑定都用已有 override 把 `timeout_ms` 设为平台下限 **250**，两者 `interval_ms=60000`（250 < 60000）；worker 租约 60s，远长于本次超时。
- 两个目标各只跑一次现有 worker，**都被 `SCHEDULE_TIMEOUT` 取消**：返回 `['retry', 'retry']`，`workflow_jobs.state='retry'`，不是 `completed`（也不是 `dead_letter`/`cancelled`）；job id 不变，`workflow_jobs` 仍两行，没有插入第二个 job。
- 取消时真实读取已经发生：实例 8 次逻辑读、服务器 2 次逻辑读。被取消的尝试**没有提交正式观测**：按 `${job.id}:${fencingToken}:` 统计 `stage='normalized'` 观测为 0，`metric_attempts` 也是 0。
- 取消事件各两条（`cancellation_requested` 在 254ms / 251ms 记录，随后 `cancelled_result_uncertain` 在 254ms / 425ms 记录）。实例的取消落在两次读取之间（`uncertain=0`，此前已发 8 次读取），服务器的取消落在读取进行中（`uncertain=1`，已发 2 次读取）；两者的结果都被丢弃。
- 两个 job 仍非终态时立刻再 `tick()`：返回 **0**；两个 `metric_schedule.job_id` 保持原 id，`workflow_jobs` 仍是这两行，观测仍为 0。
- 应用库 3306 未写入：采集前后 `database_instances` 5 行、`servers` 1 行、服务器 3 `host=192.168.49.130` / `port=22` / `collection_enabled=1`、`instance:1` revision 4、`server:3` revision 3 逐项一致；两个新 job id 在应用库的 `workflow_jobs`、`metric_schedule`、`metric_schedule_events`、`metric_attempts` 前缀和观测前缀中均为 0 行；两个端口都没有残留 `max238%` 库，一次性容器已移除。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `0a7dc6d4857a89e9bafe743827f024494570e7dd` |
| 测试提交 / 证据 `run.head` | `c715b5b2340e920f3a5a45ce105dd3fad53e2016` |
| 测试文件 | `apps/db-ops-api/src/metrics/scheduler/formal-timeout.mysql.test.ts` |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_formal_timeout_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 凭据来源 | 应用库行内既有密文，`decryptData` 解密后 `encryptData` 写进一次性库自己的行；未打印、未提交口令或密钥 |
| 实例目标 | id=1，`mysql3306`，`localhost:3306`（测试内断言名称与端口） |
| 服务器目标 | id=3，`192.168.49.130:22`（测试内断言主机与端口） |
| 采集包 | `mysql-diagnostics@1.1.0`、`linux-host@1.1.0` |
| 一次性绑定 | `timeout_ms={mode:'set',value:250}`、`interval_ms=60000`、revision 1 |
| 来源库写入 | 仅 `SELECT`；`databaseService.addConnection` 只建连接与 `ping` |

运行命令（授权环境文件路径运行时通过 `SLIDE_DEBUG_ENV_FILE` 传入，不落仓库）：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
pnpm exec vitest run src/metrics/scheduler/formal-timeout.mysql.test.ts
```

## 2. 三步证明（真实目标，一次性库）

首次 tick 扫描到两个资源到期后入队（真实 jitter，循环扫描直到两行 `queued`），两个 job id 均只存在于一次性库。随后两个目标各运行一次真实 worker（未注入 `collect`）：

| resource | job id | fencing token | attempts | state | worker 返回 | 尝试耗时 | 正式观测 | metric_attempts |
|---|---|---|---|---|---|---|---|---|
| `instance:1` | `66d85745-89f8-47d2-bbf2-9a352aba46f3` | 1 | 1 | `retry` | `retry` | 266ms | 0 | 0 |
| `server:3` | `3ef985bd-ca34-4596-a3c3-879dde19fefa` | 1 | 1 | `retry` | `retry` | 436ms | 0 | 0 |

### 2.1 现有 SCHEDULE_TIMEOUT 取消本次尝试

| resource | 取消事件 | 记录耗时 | uncertain | logical_reads |
|---|---|---|---|---|
| `instance:1` | `cancellation_requested` | 254ms | 0 | 8 |
| `instance:1` | `cancelled_result_uncertain` | 254ms | 0 | 8 |
| `server:3` | `cancellation_requested` | 251ms | 1 | 2 |
| `server:3` | `cancelled_result_uncertain` | 425ms | 1 | 2 |

两个 job 在取消后都不是 `completed`：`workflow_jobs` 仍是同样的两行、同一 job id、`attempts=1`、`fencing_token=1`；`metric_schedule.job_id` 仍指向这两个 id，没有第二个 job 行。实例的取消发生在读取间隙（`uncertain=0`，但此前已发出 8 次读取），服务器的取消发生在读取进行中（`uncertain=1`）；两者的真实读取都没有完成提交。

### 2.2 被取消的尝试不提交正式观测

- 按 `${job.id}:${fencingToken}:` 前缀统计 `metric_observations` 中 `stage='normalized'` 的行：实例 0 条、服务器 0 条。
- `metric_attempts` 同前缀：0 / 0；事件里没有 `committed`，即结果被丢弃而不是再成功执行一遍。

### 2.3 job 仍非终态时立刻再 tick

`workflow_jobs.state='retry'`，不满足 `completed`/`dead_letter`/`cancelled`，因此紧接着的 `scheduler.tick()` 返回 **0**：

| 项 | 结果 |
|---|---|
| `tick()` 返回 | 0 |
| `workflow_jobs` 行数 | 2（id、state、attempts、fencing token 均未变） |
| `metric_schedule.job_id` | 仍为 `66d85745…` / `3ef985bd…` |
| 观测（实例/服务器） | 0 / 0 |

`store.ts` 的 `enqueue` 对非终态 pending job 直接早退，没有新任务；未把 job 跑到死信，超时后也没有再放行一次成功采集。

## 3. 只读与清理证明

| 项 | 测试内采集前 | 测试内采集后 | 测试结束后独立只读复核 |
|---|---|---|---|
| `database_instances` 行数 | 5 | 5 | 5 |
| `servers` 行数 | 1 | 1 | 1 |
| 服务器 3 `host` / `port` | `192.168.49.130` / 22 | 同左 | 同左 |
| 服务器 3 `collection_enabled` | 1 | 1 | 1 |
| `instance:1` revision | 4 | 4 | 4 |
| `server:3` revision | 3 | 3 | 3 |

独立复核另外确认：本次两个 job id 在应用库 `workflow_jobs`、`metric_schedule`、`metric_schedule_events`、`metric_attempts` 前缀、观测前缀中均为 0 行；3306 与 13306 上都没有 `max238%` 库；一次性容器已移除。

## 4. 边界

- 本包不是生产发布、告警或整单验收；MAX238 保持 **in_progress**。
- 未测租约接管、死信退避、切换、回退、停写或真实 SNMP；环境放宽保持不动（`mysql.innodb.deadlocks_total` 仍 null、复制无通道不出序列、`io_time_ms` 保持 `ms`、未开真实 SNMP），本包不测网络设备。
- 间隔到期后的下一次正常采集不是重复请求，本包不涉及；未跑浏览器、未跑全量。
