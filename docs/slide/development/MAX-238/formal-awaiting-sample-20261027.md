# MAX-238：一次性库上证明等待首样本不显示健康

2026-10-27。本包补验收句「测试不污染正式历史/告警；部分失败逐项解释；等待首样本不显示健康」的最后一段：在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `PolicyService.changeBinding` 发布两个目标的既有包，再用现有 `MetricConfigurationReader.status`（经 `MetricConfigurationService.status` 与 `configurationReader`）各读取一次状态，用**已有字段**证明等待首样本时没有观测时间、新鲜度为 `unknown`、带 `AWAITING_SAMPLE`、采集状态不是 `succeeded`，且没有把任何样本写成健康。未改状态实现、调度器、worker、routes、模板、绑定、策略、migration、前端或 `config/access.ts`，未改表，未跑 worker，未发起采集。

## 结论

- 新增 `apps/db-ops-api/src/metrics/config/formal-awaiting-sample.mysql.test.ts` 在真实目标上通过：`1 passed`（测试 3.43s，总 4.34s）。
- 一次性库内两个绑定都由 `changeBinding` 正常发布：`instance:1` → `mysql-diagnostics@1.1.0`，`server:3` → `linux-host@1.1.0`，revision 1，`application='pending'`。
- 两个资源各读一次状态：`formal_visibility.last_observed_at=null`、`freshness='unknown'`、`state='pending'`、`source='none'`，`blockers` 含 **`AWAITING_SAMPLE`**。
- `collection.state='pending'`，不是 `succeeded`；`last_attempt_at` / `last_success_at` 均为 null，`in_flight=false`。额外的 `APPLICATION_PENDING`、`CAPABILITY_UNKNOWN` 是既有行为，记录在证据里，不作为本包失败。
- 一次性库在读取前后 `stage='normalized'` 观测都是 **0**；`metric_publications`、`metric_attempts`、`metric_schedule` 也都是 0 行。没有成功样本被写成健康。
- 两次状态读取的 `resource` 分别是 `{instance,1}` 与 `{server,3}`，两个结果不同，绑定包也不同，没有串配置。
- 应用库 3306 未写入：读取前后 `database_instances` 5 行、`servers` 1 行、服务器 3 `192.168.49.130:22` / `collection_enabled=1`、`instance:1` revision 4、`server:3` revision 3 逐项一致。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `339041b848d3a992b041c629c8fa0532e559a272` |
| 测试提交 / 证据 `run.head` | `a367f323a34b63b45b8a773e8b04b8e96f046dcd` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/formal-awaiting-sample.mysql.test.ts` |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_formal_awaiting_sample_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 凭据来源 | 应用库行内既有密文，`decryptData` 解密后 `encryptData` 写进一次性库自己的行；未打印、未提交口令或密钥 |
| 实例目标 | id=1，`mysql3306`，`localhost:3306`（测试内断言名称与端口） |
| 服务器目标 | id=3，`192.168.49.130:22`（测试内断言主机与端口） |
| 采集包 | `mysql-diagnostics@1.1.0`、`linux-host@1.1.0`（digest 见 JSON） |
| 状态实现 | 现有 `MetricConfigurationReader.status` + `configurationReader`；access 用抛错桩，证明状态读取不会采集 |
| 来源库写入 | 仅 `SELECT` |

运行命令（授权环境文件路径运行时通过 `SLIDE_DEBUG_ENV_FILE` 传入，不落仓库）：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
pnpm exec vitest run src/metrics/config/formal-awaiting-sample.mysql.test.ts
```

## 2. 四项证明（真实目标，一次性库）

| 项 | `instance:1` | `server:3` |
|---|---|---|
| 绑定包 | `mysql-diagnostics@1.1.0` | `linux-host@1.1.0` |
| `binding.state` / revision | `bound` / 1 | `bound` / 1 |
| `binding.application` / `applied_revision` | `pending` / null | `pending` / null |
| `effective_enabled.enabled` | true（global/asset/policy 均 true） | true（global/asset/policy 均 true） |
| `formal_visibility.state` | `pending` | `pending` |
| `formal_visibility.source` | `none` | `none` |
| `formal_visibility.last_observed_at` | **null** | **null** |
| `formal_visibility.freshness` | **`unknown`** | **`unknown`** |
| `formal_visibility.generation` | null | null |
| `collection.state` | **`pending`**（非 `succeeded`） | **`pending`**（非 `succeeded`） |
| `collection.last_attempt_at` / `last_success_at` | null / null | null / null |
| `collection.in_flight` | false | false |
| `blockers` | `APPLICATION_PENDING`、`CAPABILITY_UNKNOWN`、**`AWAITING_SAMPLE`** | 同左 |
| `resource` | `{type:'instance', id:1}` | `{type:'server', id:3}` |

1. **等待首样本**：两次读取都没有观测时间，`freshness='unknown'`，`blockers` 含 `AWAITING_SAMPLE`，`formal_visibility.state` 不是 `available`。
2. **不是成功**：`collection.state='pending'`，不是 `succeeded`。`APPLICATION_PENDING`（发布后尚未有应用回执）与 `CAPABILITY_UNKNOWN`（一次性库没有历史能力证据）是既有解释性阻断项，保留并记录，不当作本包失败；`GLOBAL_COLLECTION_DISABLED` / `ASSET_COLLECTION_DISABLED` 未出现。
3. **没有样本被写成健康**：一次性库读取前后 `stage='normalized'` 的 `metric_observations` 都是 0；`metric_publications`=0、`metric_attempts`=0、`metric_schedule`=0。测试没有跑 worker，也没有发起任何采集。
4. **不串资源**：两个结果的 `resource` 不同（`instance:1` / `server:3`），绑定包也不同，状态各自绑定自己的资源与 revision。

## 3. 只读与清理证明

| 项 | 测试内读取前 | 测试内读取后 | 测试结束后独立只读复核 |
|---|---|---|---|
| `database_instances` 行数 | 5 | 5 | 5 |
| `servers` 行数 | 1 | 1 | 1 |
| 服务器 3 `host` / `port` | `192.168.49.130` / 22 | 同左 | 同左 |
| 服务器 3 `collection_enabled` | 1 | 1 | 1 |
| `instance:1` revision | 4 | 4 | 4 |
| `server:3` revision | 3 | 3 | 3 |

独立复核另外确认 13306 上没有残留 `max238%` 库，一次性容器已移除。

## 4. 边界

- 本包不是生产发布、告警或整单验收；MAX238 保持 **in_progress**。
- 未测解绑、停写、切换、回退、超时或真实 SNMP；环境放宽保持不动（`mysql.innodb.deadlocks_total` 仍 null、复制无通道不出序列、`io_time_ms` 保持 `ms`、未开真实 SNMP），本包不测网络设备。
- 「没有绑定」不是本包的等待首样本路径：两个资源都已发布绑定。未跑浏览器、未跑全量。
