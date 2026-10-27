# MAX-238：mysql3306 与已纳管 VM 的真实只读试采

2026-10-27。本包只做两件事：对已纳管实例 1（`mysql3306`，`localhost:3306`）和服务器 3（`192.168.49.130:22`）发已有的只读采集，并把每一项的读取、转换、单位、值、时间和耗时留成证据。不新增采集器，不接路由、DDL、调度器、前端或正式发布；网络设备不在本包。测试通过不等于正式样本、告警或生产发布。

## 结论

- `unified.real.test.ts` 在真实目标上通过：`1 passed`，81.30s。
- 实例 1：试采 14/14 个采集器成功，30 个样本；正式采集 33 个指标，5 轮调度产生 20 个观测周期。
- 服务器 3：试采 5/8 个采集器成功，3 个 `parse_error`；正式采集 22 个指标，产生 16 个正式周期，其中网络和磁盘吞吐在正式路径有真实值。
- 应用库未被写入：`database_instances`/`servers` 行数、实例 1 的模板绑定、服务器 3 的 `collection_enabled` 与采集前快照一致（`original_configuration_unchanged=true`）。一次性库建在 13306 端口并在测试结束删除。
- 失败项已按错误类别记录；缺测保持为 `null`，没有写成 0。服务器试采的 3 个 `parse_error` 是试采访问路径缺少计数器生命周期证据导致，正式路径正常，详见第 5 节。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `97c5626a3e42ca33ac606b2927d27193b4ed5c3b` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/unified.real.test.ts` |
| `UNIFIED_METRICS_REAL` | `true` |
| `UNIFIED_METRICS_EXISTING` | `true` |
| `UNIFIED_METRICS_UI` / `_SWITCH` / `_CUSTOM` | 未设置（试采不开浏览器、不克隆切换、不加自定义指标） |
| 实例目标 | id=1，`mysql3306`，`localhost:3306`，MySQL 9.6.0 |
| 服务器目标 | id=3，`192.168.49.130:22`，指纹 `SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA` |
| 一次性平台库 | 端口 13306，库名 `max189_real_*`，测试后已删除 |
| 采集包 | `mysql-diagnostics@1.1.0` `sha256:785a03fc665f5dbb374e5896a41b4134dd1f2af6f64deeee06c4dca432b7250f`；`linux-host@1.1.0` `sha256:b5797402cec6302f57563b644f442fffd45b75c0a67c843b73356c2be67f8d2f` |

凭据只从服务器 3 行内已有密文或既有钥匙串读取，未打印、未提交；证据文件里没有口令或密钥字段。

读取来源是既有固定实现：MySQL 走 `builtin:database.mysql.*.v1` 的只读 SQL，服务器走 `builtin:linux.*.v1` 的固定 SSH 命令。转换是采集包既有的 `decode → normalize`；计数器在查询视图里按桶内速率显示，原始观测仍是累计值。缺测保留 `null`。

## 2. 只读与清理证明

| 项 | 值 |
|---|---|
| 源配置快照摘要 | `90f3ef2ee223fd2ff0371b1513d1293bb9ce0ea32610a9fe247f2c83055ae15a` |
| 采集前后源配置一致 | `true` |
| `database_instances` 行数（前/后） | 5 / 5 |
| `servers` 行数（前/后） | 1 / 1 |
| `metric_policy_bindings` revision（前/后） | `instance:1`=4，`server:3`=3（前后一致） |
| 服务器 3 `collection_enabled` | 1（未改；该行原本已启用） |
| 3306 上残留的一次性库 | 0 |
| 应用库 `metrics_history` 写入 | 无 |

试采响应为 `persisted=false`、`decision=attempted`，不写正式历史。暂停/恢复只在一次性副本里改服务器 3 的 `collection_enabled`：暂停后尝试数 40 → 40（`effective_enabled.source=asset`，未采集）；恢复后 `effective_enabled` 重新为 `true`，`formal_visibility` 为 `available` / `fresh`。

## 3. 试采逐项证据

### 3.1 实例 1（mysql3306）

| collector | implementation | status | error | started_at | ended_at | duration_ms |
|---|---|---|---|---|---|---|
| diagnostics_connections | `builtin:database.mysql.diagnostics_connections.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.092Z | 21.0 |
| diagnostics_limit | `builtin:database.mysql.diagnostics_limit.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.109Z | 38.0 |
| diagnostics_transactions | `builtin:database.mysql.diagnostics_transactions.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.125Z | 54.0 |
| diagnostics_size | `builtin:database.mysql.diagnostics_size.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.143Z | 72.0 |
| diagnostics_queries | `builtin:database.mysql.diagnostics_queries.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.157Z | 86.0 |
| diagnostic_counters | `builtin:database.mysql.diagnostic_counters.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.173Z | 102.0 |
| buffer_pages | `builtin:database.mysql.buffer_pages.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.188Z | 117.0 |
| uptime_diagnostics | `builtin:database.mysql.uptime_diagnostics.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.203Z | 132.0 |
| diagnostic_gauges | `builtin:database.mysql.diagnostic_gauges.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.217Z | 146.0 |
| diagnostic_ratios | `builtin:database.mysql.diagnostic_ratios.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.232Z | 161.0 |
| innodb_diagnostics | `builtin:database.mysql.innodb_diagnostics.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.246Z | 175.0 |
| thread_cache | `builtin:database.mysql.thread_cache.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.265Z | 194.0 |
| active_transactions | `builtin:database.mysql.active_transactions.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.280Z | 209.0 |
| replication_channels | `builtin:database.mysql.replication_channels.v1` | succeeded | - | 2026-10-27T13:48:04.071Z | 2026-10-27T13:48:04.294Z | 223.0 |

样本（试采原始值，计数器为累计值）：

| metric | unit | quality | value |
|---|---|---|---|
| `mysql.processlist.count` | count | good | 13 |
| `mysql.connections.limit` | count | good | 151 |
| `mysql.transaction_commands.commit_total` | count | good | 901398 |
| `mysql.transaction_commands.rollback_total` | count | good | 32 |
| `mysql.tables.estimated_allocated_bytes` | By | good | 2117173248 |
| `mysql.queries.total` | count | good | 16204318 |
| `mysql.slow_queries.total` | count | good | 4 |
| `mysql.protocol.received_bytes_total` | By | good | 1641071378 |
| `mysql.protocol.sent_bytes_total` | By | good | 77954923474 |
| `mysql.handler.read_next_total` | count | good | 10408920 |
| `mysql.connections.aborted_total` | count | good | 21 |
| `mysql.buffer_pool.pages_used_percent` | % | good | 96.8842 |
| `db.uptime_seconds` | s | good | 137273 |
| `mysql.threads.running` | count | good | 2 |
| `mysql.threads.connected` | count | good | 12 |
| `mysql.files.open` | count | good | 10 |
| `mysql.key_cache.used_blocks` | count | good | 0 |
| `mysql.key_cache.unused_blocks` | count | good | 6698 |
| `mysql.buffer_pool.read_hit_percent` | % | good | 99.68 |
| `mysql.table_cache.hit_percent` | % | good | 99.9915 |
| `mysql.key_cache.used_percent` | % | good | 0 |
| `mysql.innodb.row_lock_average_ms` | ms | good | 7 |
| `mysql.innodb.deadlocks_total` | count | unknown | null |
| `mysql.temporary.disk_tables_total` | count | good | 3793 |
| `mysql.thread_cache.hit_percent` | % | good | 99.96 |
| `mysql.transactions.active` | count | good | 0 |
| `mysql.transaction_commands.commit_rate` | count/s | unknown | null |
| `mysql.transaction_commands.rollback_rate` | count/s | unknown | null |
| `mysql.transaction_commands.completed_rate` | count/s | unknown | null |
| `mysql.queries.per_second` | count/s | unknown | null |

### 3.2 服务器 3（192.168.49.130）

| collector | implementation | status | error | started_at | ended_at | duration_ms |
|---|---|---|---|---|---|---|
| linux-basic | `builtin:linux.basic.v1` | succeeded | - | 2026-10-27T13:48:04.620Z | 2026-10-27T13:48:05.094Z | 474.0 |
| linux-host-gauges | `builtin:linux.host-gauges.v1` | succeeded | - | 2026-10-27T13:48:04.620Z | 2026-10-27T13:48:05.608Z | 988.0 |
| linux-filesystem | `builtin:linux.filesystem.v1` | succeeded | - | 2026-10-27T13:48:04.620Z | 2026-10-27T13:48:06.039Z | 1419.0 |
| linux-network | `builtin:linux.network.v1` | failed | parse_error | 2026-10-27T13:48:04.620Z | 2026-10-27T13:48:06.172Z | 1552.0 |
| linux-block | `builtin:linux.block.v1` | failed | parse_error | 2026-10-27T13:48:04.620Z | 2026-10-27T13:48:06.318Z | 1698.0 |
| linux-diagnostic-gauges-v1 | `builtin:linux.diagnostic-gauges.v1` | succeeded | - | 2026-10-27T13:48:04.620Z | 2026-10-27T13:48:07.325Z | 2705.0 |
| linux-filesystem-diagnostics-v1 | `builtin:linux.filesystem-diagnostics.v1` | succeeded | - | 2026-10-27T13:48:04.620Z | 2026-10-27T13:48:07.745Z | 3125.0 |
| linux-network-diagnostics-v1 | `builtin:linux.network-diagnostics.v1` | failed | parse_error | 2026-10-27T13:48:04.620Z | 2026-10-27T13:48:07.890Z | 3270.0 |

样本：

| metric | unit | quality | value |
|---|---|---|---|
| `linux.uptime.seconds` | s | good | 209312.55 |
| `linux.load.one_minute` | 1 | good | 0 |
| `linux.cpu.user_system_percent` | % | good | 9.1 |
| `linux.memory.used_percent` | % | good | 31.49 |
| `host.filesystem.used_bytes` | By | good | 7963566080, 0, 0, 0, 33730, 58040320 …（共 11 个序列值） |
| `host.filesystem.size_bytes` | By | good | 21416116224, 4194304, 1427353600, 4194304, 262128, 570941440 …（共 11 个序列值） |
| `linux.memory.used_bytes` | By | good | 898793472 |
| `linux.memory.total_bytes` | By | good | 2854707200 |
| `linux.load.five_minutes` | 1 | good | 0.03 |
| `linux.load.fifteen_minutes` | 1 | good | 0.01 |
| `linux.swap.used_percent` | % | good | 0 |
| `linux.processes.count` | count | good | 215 |
| `linux.processes.sample_max_cpu_percent` | % | good | 1.1 |
| `linux.processes.cpu_sample_max_memory_percent` | % | good | 8.3 |
| `linux.filesystem.available_bytes` | By | good | 13452550144, 4194304, 1427353600, 4194304, 228398, 512901120 …（共 11 个序列值） |
| `linux.filesystem.inode_used_percent` | % | good,unknown | 2, 1, 1, 2, null, 1 …（共 11 个序列值） |
| `linux.filesystem.used_ratio` | 1 | partial,good | 0.37184921844398744, 0, 0, 0, 0.12867759262650308, 0.10165722074754287 …（共 11 个序列值） |

## 4. 正式采集逐项证据

5 轮调度后，实例 1 得到 20 个正式周期、服务器 3 得到 16 个。下表是本次查询窗口内每个指标的非空点数与最后值；计数器显示的是查询视图的桶内速率。

### 4.1 实例 1

| metric | unit | kind | collector | series | 非空点 | 最后值 | 最后 observed_at |
|---|---|---|---|---|---|---|---|
| `db.uptime_seconds` | s | gauge/instant | uptime_diagnostics | 1 | 4 | {"encoding": "float64", "value": 137333} | 2026-10-27T13:49:04.640Z |
| `mysql.processlist.count` | count | gauge/instant | diagnostics_connections | 1 | 4 | {"encoding": "uint64", "value": "13"} | 2026-10-27T13:49:04.640Z |
| `mysql.connections.limit` | count | gauge/instant | diagnostics_limit | 1 | 4 | {"encoding": "uint64", "value": "151"} | 2026-10-27T13:49:04.640Z |
| `mysql.transaction_commands.commit_total` | count | counter/cumulative | diagnostics_transactions | 1 | 6 | {"encoding": "float64", "value": 21.774895964385948} | 2026-10-27T13:48:54.436Z |
| `mysql.transaction_commands.rollback_total` | count | counter/cumulative | diagnostics_transactions | 1 | 6 | {"encoding": "float64", "value": 0} | 2026-10-27T13:48:54.436Z |
| `mysql.tables.estimated_allocated_bytes` | By | gauge/instant | diagnostics_size | 1 | 4 | {"encoding": "uint64", "value": "2117173248"} | 2026-10-27T13:49:04.640Z |
| `mysql.transaction_commands.commit_rate` | count/s | gauge/instant | derived | 1 | 4 | {"encoding": "float64", "value": 21.774895964385948} | 2026-10-27T13:49:04.769Z |
| `mysql.transaction_commands.rollback_rate` | count/s | gauge/instant | derived | 1 | 4 | {"encoding": "float64", "value": 0} | 2026-10-27T13:49:04.769Z |
| `mysql.transaction_commands.completed_rate` | count/s | gauge/instant | derived | 1 | 4 | {"encoding": "float64", "value": 21.774895964385948} | 2026-10-27T13:49:04.769Z |
| `mysql.queries.total` | count | counter/cumulative | diagnostics_queries | 1 | 6 | {"encoding": "float64", "value": 412.31126596980255} | 2026-10-27T13:48:54.501Z |
| `mysql.queries.per_second` | count/s | gauge/instant | derived | 1 | 4 | {"encoding": "float64", "value": 412.31126596980255} | 2026-10-27T13:49:04.833Z |
| `mysql.slow_queries.total` | count | counter/cumulative | diagnostic_counters | 1 | 6 | {"encoding": "float64", "value": 0} | 2026-10-27T13:48:54.526Z |
| `mysql.protocol.received_bytes_total` | By | counter/cumulative | diagnostic_counters | 1 | 6 | {"encoding": "float64", "value": 38773.30364921111} | 2026-10-27T13:48:54.526Z |
| `mysql.protocol.sent_bytes_total` | By | counter/cumulative | diagnostic_counters | 1 | 6 | {"encoding": "float64", "value": 1655505.2753847642} | 2026-10-27T13:48:54.526Z |
| `mysql.handler.read_next_total` | count | counter/cumulative | diagnostic_counters | 1 | 6 | {"encoding": "float64", "value": 227.567515245378} | 2026-10-27T13:48:54.526Z |
| `mysql.connections.aborted_total` | count | counter/cumulative | diagnostic_counters | 1 | 6 | {"encoding": "float64", "value": 0} | 2026-10-27T13:48:54.526Z |
| `mysql.buffer_pool.pages_used_percent` | % | gauge/instant | buffer_pages | 1 | 4 | {"encoding": "float64", "value": 96.875} | 2026-10-27T13:49:04.640Z |
| `mysql.threads.running` | count | gauge/instant | diagnostic_gauges | 1 | 4 | {"encoding": "uint64", "value": "2"} | 2026-10-27T13:49:04.640Z |
| `mysql.threads.connected` | count | gauge/instant | diagnostic_gauges | 1 | 4 | {"encoding": "uint64", "value": "12"} | 2026-10-27T13:49:04.640Z |
| `mysql.files.open` | count | gauge/instant | diagnostic_gauges | 1 | 4 | {"encoding": "uint64", "value": "10"} | 2026-10-27T13:49:04.640Z |
| `mysql.key_cache.used_blocks` | count | gauge/instant | diagnostic_gauges | 1 | 4 | {"encoding": "uint64", "value": "0"} | 2026-10-27T13:49:04.640Z |
| `mysql.key_cache.unused_blocks` | count | gauge/instant | diagnostic_gauges | 1 | 4 | {"encoding": "uint64", "value": "6698"} | 2026-10-27T13:49:04.640Z |
| `mysql.buffer_pool.read_hit_percent` | % | gauge/instant | diagnostic_ratios | 1 | 4 | {"encoding": "float64", "value": 99.68} | 2026-10-27T13:49:04.640Z |
| `mysql.table_cache.hit_percent` | % | gauge/instant | diagnostic_ratios | 1 | 4 | {"encoding": "float64", "value": 99.9914} | 2026-10-27T13:49:04.640Z |
| `mysql.key_cache.used_percent` | % | gauge/instant | diagnostic_ratios | 1 | 4 | {"encoding": "float64", "value": 0} | 2026-10-27T13:49:04.640Z |
| `mysql.innodb.row_lock_average_ms` | ms | gauge/instant | innodb_diagnostics | 1 | 4 | {"encoding": "uint64", "value": "7"} | 2026-10-27T13:49:04.975Z |
| `mysql.innodb.deadlocks_total` | count | counter/cumulative | innodb_diagnostics | 1 | 0 | 缺测 (null) | - |
| `mysql.temporary.disk_tables_total` | count | counter/cumulative | innodb_diagnostics | 1 | 5 | {"encoding": "float64", "value": 0.09682416731216112} | 2026-10-27T13:48:54.647Z |
| `mysql.thread_cache.hit_percent` | % | gauge/instant | thread_cache | 1 | 4 | {"encoding": "float64", "value": 99.96} | 2026-10-27T13:49:04.640Z |
| `mysql.transactions.active` | count | gauge/instant | active_transactions | 1 | 4 | {"encoding": "uint64", "value": "0"} | 2026-10-27T13:49:04.640Z |
| `mysql.replication.behind_source_seconds` | s | gauge/instant | replication_channels | 0 | 0 | 缺测 (null) | - |
| `mysql.replication.io_running` | count | gauge/instant | replication_channels | 0 | 0 | 缺测 (null) | - |
| `mysql.replication.sql_running` | count | gauge/instant | replication_channels | 0 | 0 | 缺测 (null) | - |

### 4.2 服务器 3

| metric | unit | kind | collector | series | 非空点 | 最后值 | 最后 observed_at |
|---|---|---|---|---|---|---|---|
| `host.filesystem.used_bytes` | By | gauge/instant | linux-filesystem | 11 | 44 | {"encoding": "uint64", "value": "33730"} | 2026-10-27T13:49:05.164Z |
| `host.filesystem.size_bytes` | By | gauge/instant | linux-filesystem | 11 | 44 | {"encoding": "uint64", "value": "570941440"} | 2026-10-27T13:49:05.164Z |
| `host.network.bytes_total` | By | counter/cumulative | linux-network | 2 | 10 | {"encoding": "float64", "value": 3283.9244410177334} | 2026-10-27T13:48:56.170Z |
| `linux.uptime.seconds` | s | gauge/instant | linux-basic | 1 | 4 | {"encoding": "float64", "value": 209372.86} | 2026-10-27T13:49:05.164Z |
| `linux.load.one_minute` | 1 | gauge/instant | linux-basic | 1 | 4 | {"encoding": "float64", "value": 0.06} | 2026-10-27T13:49:05.164Z |
| `linux.cpu.user_system_percent` | % | gauge/instant | linux-host-gauges | 1 | 4 | {"encoding": "float64", "value": 10} | 2026-10-27T13:49:05.164Z |
| `linux.memory.used_percent` | % | gauge/instant | linux-host-gauges | 1 | 4 | {"encoding": "float64", "value": 31.43} | 2026-10-27T13:49:05.164Z |
| `linux.block.read_bytes_total` | By | counter/cumulative | linux-block | 3 | 15 | {"encoding": "float64", "value": 0} | 2026-10-27T13:48:56.317Z |
| `linux.block.write_bytes_total` | By | counter/cumulative | linux-block | 3 | 15 | {"encoding": "float64", "value": 2365.578977764944} | 2026-10-27T13:48:56.317Z |
| `linux.block.io_time_ms_total` | ms | counter/cumulative | linux-block | 0 | 0 | 缺测 (null) | - |
| `linux.filesystem.used_ratio` | 1 | gauge/instant | derived | 11 | 44 | {"encoding": "float64", "value": 0.12867759262650308} | 2026-10-27T13:49:05.164Z |
| `linux.memory.used_bytes` | By | gauge/instant | linux-diagnostic-gauges-v1 | 1 | 4 | {"encoding": "uint64", "value": "897503232"} | 2026-10-27T13:49:05.164Z |
| `linux.memory.total_bytes` | By | gauge/instant | linux-diagnostic-gauges-v1 | 1 | 4 | {"encoding": "uint64", "value": "2854707200"} | 2026-10-27T13:49:05.164Z |
| `linux.load.five_minutes` | 1 | gauge/instant | linux-diagnostic-gauges-v1 | 1 | 4 | {"encoding": "float64", "value": 0.03} | 2026-10-27T13:49:05.164Z |
| `linux.load.fifteen_minutes` | 1 | gauge/instant | linux-diagnostic-gauges-v1 | 1 | 4 | {"encoding": "float64", "value": 0} | 2026-10-27T13:49:05.164Z |
| `linux.swap.used_percent` | % | gauge/instant | linux-diagnostic-gauges-v1 | 1 | 4 | {"encoding": "float64", "value": 0} | 2026-10-27T13:49:05.164Z |
| `linux.processes.count` | count | gauge/instant | linux-diagnostic-gauges-v1 | 1 | 4 | {"encoding": "uint64", "value": "215"} | 2026-10-27T13:49:05.164Z |
| `linux.processes.sample_max_cpu_percent` | % | gauge/instant | linux-diagnostic-gauges-v1 | 1 | 4 | {"encoding": "float64", "value": 0.3} | 2026-10-27T13:49:05.164Z |
| `linux.processes.cpu_sample_max_memory_percent` | % | gauge/instant | linux-diagnostic-gauges-v1 | 1 | 4 | {"encoding": "float64", "value": 8.3} | 2026-10-27T13:49:05.164Z |
| `linux.filesystem.available_bytes` | By | gauge/instant | linux-filesystem-diagnostics-v1 | 11 | 44 | {"encoding": "uint64", "value": "285466624"} | 2026-10-27T13:49:05.164Z |
| `linux.filesystem.inode_used_percent` | % | gauge/instant | linux-filesystem-diagnostics-v1 | 11 | 36 | {"encoding": "float64", "value": 1} | 2026-10-27T13:49:05.164Z |
| `linux.network.events_total` | count | counter/cumulative | linux-network-diagnostics-v1 | 4 | 20 | {"encoding": "float64", "value": 0} | 2026-10-27T13:48:57.902Z |

## 5. 失败与缺测分类

| 资源 | 项 | 结果 | 原因 |
|---|---|---|---|
| server:3 | `linux-network`（`builtin:linux.network.v1`） | 试采 `parse_error` | 试采访问用 `createAssetCollectorAccess()`（`preserveDiscovery=false`，与生产 `trialAccess` 一致），不提供 `host_counter_epochs`，计数器生命周期守卫拒绝；正式路径 `preserveDiscovery=true` 时 `host.network.bytes_total` 有 2 个序列、10 个非空点。 |
| server:3 | `linux-block`（`builtin:linux.block.v1`） | 试采 `parse_error` | 同上；正式路径 `linux.block.read_bytes_total`/`write_bytes_total` 各 3 个序列、15 个非空点。 |
| server:3 | `linux-network-diagnostics-v1`（`builtin:linux.network-diagnostics.v1`） | 试采 `parse_error` | 同上；正式路径 `linux.network.events_total` 有 4 个序列、20 个非空点（本机错误/丢包速率为 0）。 |
| instance:1 | `mysql.innodb.deadlocks_total` | 缺测 (`null`)，capability `unknown` | 能力评估的 `permission` 依据为 `unknown`，查询桶为 `missing_input`。不是 0。 |
| instance:1 | `mysql.replication.*` | 0 个序列 | 目标没有复制通道，属于不适用，不是 0。 |
| server:3 | `linux.block.io_time_ms_total` | 已采集但 `query_operation_unavailable` | 消费者只对 `By`/`count` 单位的计数器提供速率查询（`apps/db-ops-api/src/metrics/consumers/service.ts:90-93`），`ms` 单位保留原始证据但不转成速率。不是 0。 |
| instance:1 | `*_rate` / `*_per_second` 派生指标 | 试采为 `unknown`、`null` | 派生速率需要前一采样点，单次试采没有基线；正式采集有值。不是 0。 |

试采的 3 个 `parse_error` 不是采集命令失败：同样的固定命令在真实 VM 上退出码 0，正式路径也能出值。差异来自试采访问没有保留 `HostBlockDiscovery`/`HostInterfaceDiscovery`，而这两个采集器要求驱动程序提供计数器生命周期证据；代码路径是 `apps/db-ops-api/src/metrics/config/access.ts:132` 的 `trialAccess`（`preserveDiscovery=false`）与 `apps/db-ops-api/src/metrics/config/routes.ts:27` 的接线。

修复需要改 `apps/db-ops-api/src/metrics/config/access.ts` 或 `routes.ts`，不在本包允许修改的文件列表内，因此本包只记录该发现，没有越界修。建议由 Chief 决定是否让试采访问同样保留 discovery。

## 6. 复现

```bash
cd apps/db-ops-api
UNIFIED_METRICS_REAL=true UNIFIED_METRICS_EXISTING=true SLIDE_DEBUG_ENV_FILE=<授权环境文件> METRICS_TEST_MYSQL_PORT=13306 UNIFIED_METRICS_EVIDENCE=../../docs/slide/development/MAX-238/evidence UNIFIED_METRICS_VM_FINGERPRINT='SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA' pnpm exec vitest run src/metrics/config/unified.real.test.ts
```

同时跑的 focused 单元测试：`host-counter.test.ts` 10/10 通过，`host-counter.ssh.test.ts` 因未设夹具端口/口令跳过 1 项。

机读证据：`docs/slide/development/MAX-238/real-trial-evidence-20261027.json`（逐采集器尝试、样本、正式指标逐序列摘要、失败类别、只读证明；无口令和密钥）。

## 7. 未覆盖

- 网络设备、官方模板转换与导入属于 MAX-237，本包不读不改。
- 未跑浏览器、未跑全量测试、未发布应用或告警。
- 试采通过仍是内部证据；正式样本、健康判定、告警与生产发布需要后续放行。
- 正式采集写在一次性库；应用库没有任何迁移或 DDL。
