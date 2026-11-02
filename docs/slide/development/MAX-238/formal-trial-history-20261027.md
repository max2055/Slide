# MAX-238：一次性库上证明测试不写正式历史、不触发告警

2026-10-27。本包补验收句「测试不污染正式历史/告警；部分失败逐项解释；等待首样本不显示健康」的前一段：在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `PolicyService.changeBinding` 发布两个目标的既有包，再用现有 `MetricConfigurationService.trial`（经 `trialCurrent`）与 `createAssetCollectorAccess()` 对实例 1（`mysql3306`）和服务器 3（`192.168.49.130:22`）各跑一次真实试用，用**已有字段**证明试用不写正式历史、不产生告警行，试用后状态仍是等待首样本。未改试用实现、状态实现、调度器、worker、routes、模板、绑定、策略、migration、前端或 `config/access.ts`，未改表，未跑 worker，未调用 `activate`。

## 结论

- 新增 `apps/db-ops-api/src/metrics/config/formal-trial-history.mysql.test.ts` 在真实目标上通过：`1 passed`（测试 7.25s，总 8.26s）。
- 两次试用都是真正跑完的读取：`persisted=false`、`decision=attempted`，实例 14 个采集器 30 个样本，服务器 8 个采集器 82 个样本，`samples + attempts` 都远大于 0。
- 试用前后一次性库 `stage='normalized'` 的 `metric_observations` 都是 **0**；`metric_publications`、`alerts`、`alert_events`、`notification_records`、告警状态/迁移表也都是 **0**。`metric_schedule` 与 `metric_attempts` 同样 0 行，试用没有留下任何正式周期或正式尝试。
- 试用后再各读一次现有状态：`formal_visibility.last_observed_at=null`、`freshness='unknown'`、`blockers` 仍含 **`AWAITING_SAMPLE`**、`collection.state='pending'`（不是 `succeeded`）。试用结果没有被写成健康的正式样本。
- 两次试用与两次状态读取的 `resource` 分别是 `{instance,1}` 与 `{server,3}`，包分别是 `mysql-diagnostics@1.1.0` / `linux-host@1.1.0`，没有串配置。
- 应用库 3306 未写入：试用前后 `database_instances` 5 行、`servers` 1 行、服务器 3 `192.168.49.130:22` / `collection_enabled=1`、`instance:1` revision 4、`server:3` revision 3 逐项一致。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `9513fca2ee5a328045c74b4ddef8d201408e03f7` |
| 测试提交 / 证据 `run.head` | `396cb45fe32a6db9cad2478e7b675877000dd49d` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/formal-trial-history.mysql.test.ts` |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_formal_trial_history_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 凭据来源 | 应用库行内既有密文，`decryptData` 解密后 `encryptData` 写进一次性库自己的行；未打印、未提交口令或密钥 |
| 实例目标 | id=1，`mysql3306`，`localhost:3306`（测试内断言名称与端口；只读 SQL） |
| 服务器目标 | id=3，`192.168.49.130:22`（测试内断言主机与端口；既有固定 SSH 命令） |
| 采集包 | `mysql-diagnostics@1.1.0`、`linux-host@1.1.0`（digest 见 JSON） |
| 试用实现 | 现有 `MetricConfigurationService.trial` / `trialCurrent` + `createTrialStore`；access 为 `createAssetCollectorAccess()`（未传 `true`） |
| 来源库写入 | 仅 `SELECT` |

运行命令（授权环境文件路径运行时通过 `SLIDE_DEBUG_ENV_FILE` 传入，不落仓库）：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
pnpm exec vitest run src/metrics/config/formal-trial-history.mysql.test.ts
```

## 2. 四项证明（真实目标，一次性库）

| 项 | `instance:1` | `server:3` |
|---|---|---|
| 绑定包 | `mysql-diagnostics@1.1.0` | `linux-host@1.1.0` |
| `persisted` | **false** | **false** |
| `decision` | `attempted` | `attempted` |
| 采集器 attempts | 14（全部 `succeeded`） | 8（全部 `succeeded`） |
| samples | 30 | 82 |
| 试用后 `stage='normalized'` 观测 | **0** | **0** |
| `metric_publications` | **0** | **0** |
| `alerts` / `alert_events` / `notification_records` | **0 / 0 / 0** | **0 / 0 / 0** |
| 告警状态 / 迁移表 | **0 / 0** | **0 / 0** |
| 试用后 `formal_visibility.last_observed_at` | **null** | **null** |
| 试用后 `formal_visibility.freshness` | **`unknown`** | **`unknown`** |
| 试用后 `blockers` | `APPLICATION_PENDING`、`CAPABILITY_UNKNOWN`、**`AWAITING_SAMPLE`** | 同左 |
| 试用后 `collection.state` | **`pending`**（非 `succeeded`） | **`pending`**（非 `succeeded`） |
| 试用/状态 `resource` | `{type:'instance', id:1}` | `{type:'server', id:3}` |

1. **真正跑完的试用**：两次试用都返回 `persisted=false`、`decision=attempted`，`samples + attempts` 合计分别为 44 与 90，不是空超时或空适配器错误。
2. **不写正式历史/告警**：两个目标试用前后，一次性库 `stage='normalized'` 观测、`metric_publications`、`alerts`、`alert_events`、`notification_records`、告警状态/迁移表全部为 0。两次试用之间也各查一次，仍为 0。
3. **不写成健康**：试用之后再调用现有状态读取，`last_observed_at` 仍为 null、`freshness='unknown'`、`blockers` 含 `AWAITING_SAMPLE`、`collection.state='pending'`。`APPLICATION_PENDING` 与 `CAPABILITY_UNKNOWN` 是既有解释性阻断项，保留并记录，不作为本包失败。
4. **不串资源**：两次试用与两次状态读取分别对应 `instance:1`、`server:3`，绑定包不同，状态各自绑定自己的资源与 revision。

## 3. 试用逐项证据

### 3.1 实例 1（mysql3306）

14 个采集器全部 `succeeded`，`error` 全为 null，耗时 24–259ms。样本 30 个，单位含 `count`、`By`、`s`、`%`、`ms`、`count/s`。

| metric | unit | quality | value |
|---|---|---|---|
| `mysql.processlist.count` | count | good | 13 |
| `mysql.connections.limit` | count | good | 151 |
| `mysql.transaction_commands.commit_total` | count | good | 973820 |
| `mysql.transaction_commands.rollback_total` | count | good | 32 |
| `mysql.tables.estimated_allocated_bytes` | By | good | 2117304320 |
| `mysql.queries.total` | count | good | 17507678 |

环境放宽保持不动，缺测仍为 null、不补 0：`mysql.innodb.deadlocks_total`（`unknown` / `source_error`）、`mysql.transaction_commands.commit_rate`、`mysql.transaction_commands.rollback_rate`、`mysql.transaction_commands.completed_rate`、`mysql.queries.per_second`（`unknown` / `counter_baseline`，首次试用没有基线）。没有复制通道，`mysql.replication.*` 无序列。

### 3.2 服务器 3（192.168.49.130:22）

8 个采集器全部 `succeeded`，`error` 全为 null，耗时 504–3282ms。样本 82 个，单位含 `1`、`%`、`By`、`count`、`s`、`ms`。

| metric | unit | quality | value |
|---|---|---|---|
| `linux.uptime.seconds` | s | good | 219144 |
| `linux.load.one_minute` | 1 | good | 0.01 |
| `linux.cpu.user_system_percent` | % | good | 0 |
| `linux.memory.used_percent` | % | good | 31.5 |
| `host.filesystem.used_bytes` | By | good | 4096（首个序列） |
| `host.filesystem.size_bytes` | By | good | 285470720（首个序列） |

`linux.filesystem.inode_used_percent`（`not_applicable`）与 `linux.filesystem.used_ratio`（`partial` / `precision_loss`）是既有逐项解释，保留并记录，不是本包失败。`linux.block.io_time_ms_total` 保持 `ms`，未做速率转换；未开真实 SNMP，本包不测网络设备。

## 4. 正式表与告警表的 0 行证明

| 表 | 试用前 | 总试用后 |
|---|---|---|
| `metric_observations`（`stage='normalized'`） | 0 | 0 |
| `metric_publications` | 0 | 0 |
| `alerts` | 0 | 0 |
| `alert_events` | 0 | 0 |
| `notification_records` | 0 | 0 |
| 告警状态表 | 0 | 0 |
| 告警迁移表 | 0 | 0 |
| `metric_schedule` / `metric_attempts` | —— | 0 / 0 |

**表名说明**：本包要求的 `metric_v2_alert_state`、`metric_v2_alert_transitions` 在现有 migration 121（`apps/db-ops-api/sql/migrations/121_unified_metric_names.sql`）里已改名为 `metric_alert_state`、`metric_alert_transitions`。测试先解析实际存在的表名再断言计数，证据里同时记录请求名与解析名，两者都指向同一批表；`metric_publications` 同样来自该 migration 的改名。没有新增表，没有改表。

试用的 `GET_LOCK` 预约只在会话内存在，不写这些表。

## 5. 只读与清理证明

| 项 | 测试内试用前 | 测试内试用后 | 测试结束后独立只读复核 |
|---|---|---|---|
| `database_instances` 行数 | 5 | 5 | 5 |
| `servers` 行数 | 1 | 1 | 1 |
| 服务器 3 `host` / `port` | `192.168.49.130` / 22 | 同左 | 同左 |
| 服务器 3 `collection_enabled` | 1 | 1 | 1 |
| `instance:1` revision | 4 | 4 | 4 |
| `server:3` revision | 3 | 3 | 3 |
| 3306 上 `max238%` 库 | —— | —— | 0 |

独立复核另外确认 13306 上没有残留 `max238%` 库，一次性容器已移除，测试临时脚本已删除。

## 6. 边界

- 本包不是生产发布、告警或整单验收；MAX238 保持 **in_progress**。未调用 `activate`，未跑 worker，未产生正式样本。
- 未测解绑、停写、切换、回退、超时或真实 SNMP；环境放宽保持不动（`mysql.innodb.deadlocks_total` 仍 null、复制无通道不出序列、`io_time_ms` 保持 `ms`、未开真实 SNMP），本包不测网络设备。
- 未跑浏览器、未跑全量；只跑本包新增测试与 `tsc --noEmit`。
