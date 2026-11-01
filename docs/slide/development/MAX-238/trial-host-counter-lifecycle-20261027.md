# MAX-238：试采补上主机计数器生命周期

2026-10-27。本包只修一处编码差异：试采访问（`trialAccess`）没有给服务器采集提供主机块设备和接口发现，导致 `linux-network`、`linux-block`、`linux.network-diagnostics.v1` 以 `parse_error` 失败。不重做已接受的 B1–B2G 和只读试采的其余部分，未接路由、DDL、调度器、前端，未发布应用或告警。

## 结论

- `apps/db-ops-api/src/metrics/config/access.ts` 现在对服务器无论试采还是生产都提供 `host_blocks` / `host_interfaces`，两者各自持有 `createAssetCollectorAccess()` 内创建的缓存，互不共享；生产路径的 `assertAssetCollectionEnabled`、SNMP 发现缓存和共享缓存逻辑未改。
- 服务器 3 试采 8/8 个采集器成功、82 个样本；原三条 `parse_error` 全部变成成功并带真实值。实例 1 仍是 14/14 成功、30 个样本。
- 真实只读试采 `1 passed`、79.33s；结果里没有缺 `host_counter_epochs` 的 `parse_error`。
- 3306 上的 `database_instances` 5/5、`servers` 1/1 行数不变，服务器 3 的 `collection_enabled=1`、`instance:1` revision 4、`server:3` revision 3 均未改；一次性库在 13306 建立、测试自行删除，容器已移除。

## 1. 改动

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `cc0599a40282065b489194f56ef2a70d09e3b72c` |
| 实现 + focused test | `6fb39d531` |
| 允许修改文件 | `apps/db-ops-api/src/metrics/config/access.ts`、`apps/db-ops-api/src/metrics/config/access.test.ts`、本目录 |

改法只有一处条件：服务器证据从 `ref.type === 'server' && preserveDiscovery` 改为 `ref.type === 'server'`。

- 缓存仍在 `createAssetCollectorAccess()` 内创建；`trialAccess` 与 `productionAccess` 是两个独立调用，因此各自持有自己的 `HostBlockDiscoveryCache` / `HostInterfaceDiscoveryCache`。没有改成共用，也没有把 `trialAccess` 改成 `createAssetCollectorAccess(true)`。
- `preserveDiscovery` 仍然只管 SNMP 发现缓存与 `assertAssetCollectionEnabled`；试采不调用 `assertAssetCollectionEnabled`，生产路径这项检查原样保留。
- 禁止目录（`routes.ts`、`metrics/templates`、`metrics/snmp`、`metrics/policy`、`metrics/bindings`、migration、调度器、前端）未改。

新增的 focused 测试覆盖这条差异：试采服务器拿到 `host_blocks` 和 `host_interfaces`，同一 access 内重复 resolve 复用同一缓存，试采与生产的缓存对象不同，且 `assertAssetCollectionEnabled` 只被生产路径调用一次。

## 2. 验证

| 检查 | 结果 |
|---|---|
| `vitest run src/metrics/config/access.test.ts` | 9 passed（新增 1 项） |
| `vitest run .../access.test.ts .../routes.test.ts` | 20 passed |
| `tsc --noEmit`（`apps/db-ops-api`） | 无输出，通过 |
| `unified.real.test.ts`（真实目标） | `1 passed`，79.33s |

重跑开关与上一包相同：`UNIFIED_METRICS_REAL=true`、`UNIFIED_METRICS_EXISTING=true`；未设 `UNIFIED_METRICS_UI`、`UNIFIED_METRICS_SWITCH`、`UNIFIED_METRICS_CUSTOM`。目标仍是实例 1（`mysql3306`，`localhost:3306`，MySQL 9.6.0）和服务器 3（`192.168.49.130:22`，指纹 `SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA`）。一次性平台库建在 13306，未在 3306 建库。

## 3. 服务器 3 试采逐项

| collector | implementation | status | error | started_at | ended_at | duration_ms | 观测 |
|---|---|---|---|---|---|---|---|
| linux-basic | `builtin:linux.basic.v1` | succeeded | - | 2026-10-27T14:30:07.731Z | 2026-10-27T14:30:08.256Z | 525.0 | 2 |
| linux-host-gauges | `builtin:linux.host-gauges.v1` | succeeded | - | 2026-10-27T14:30:07.731Z | 2026-10-27T14:30:08.766Z | 1035.0 | 2 |
| linux-filesystem | `builtin:linux.filesystem.v1` | succeeded | - | 2026-10-27T14:30:07.731Z | 2026-10-27T14:30:09.204Z | 1473.0 | 22 |
| linux-network | `builtin:linux.network.v1` | succeeded | - | 2026-10-27T14:30:07.731Z | 2026-10-27T14:30:09.344Z | 1613.0 | 2 |
| linux-block | `builtin:linux.block.v1` | succeeded | - | 2026-10-27T14:30:07.731Z | 2026-10-27T14:30:09.501Z | 1770.0 | 9 |
| linux-diagnostic-gauges-v1 | `builtin:linux.diagnostic-gauges.v1` | succeeded | - | 2026-10-27T14:30:07.731Z | 2026-10-27T14:30:10.505Z | 2774.0 | 8 |
| linux-filesystem-diagnostics-v1 | `builtin:linux.filesystem-diagnostics.v1` | succeeded | - | 2026-10-27T14:30:07.731Z | 2026-10-27T14:30:10.920Z | 3189.0 | 22 |
| linux-network-diagnostics-v1 | `builtin:linux.network-diagnostics.v1` | succeeded | - | 2026-10-27T14:30:07.731Z | 2026-10-27T14:30:11.060Z | 3329.0 | 4 |

### 3.1 原三条 `parse_error` 现在的值与单位

| collector | metric | unit | quality | value |
|---|---|---|---|---|
| linux-network | `host.network.bytes_total` | By | good | 47506923（累计） |
| linux-network | `host.network.bytes_total` | By | good | 66057557（累计） |
| linux-block | `linux.block.read_bytes_total` | By | good | 965485568 / 929768448 / 2269184（3 个设备） |
| linux-block | `linux.block.write_bytes_total` | By | good | 328601088 / 250981376 / 0（3 个设备） |
| linux-block | `linux.block.io_time_ms_total` | ms | good | 2130 / 2220 / 0（3 个设备） |
| linux-network-diagnostics-v1 | `linux.network.events_total` | count | good | 0（4 个序列，本机错误/丢包计数为 0） |

读取来源仍是既有固定实现：块设备是 `HOST_BLOCK_SNAPSHOT_COMMAND`（`/proc/diskstats` 前后各读一次 boot_id、btime 和 `diskseq`），网络是接口发现命令加 `/proc/net/dev`。转换是采集包既有的 `decode → normalize`；计数器保留累计值，查询视图才按桶内速率显示。时间是本次试采动作的起止；样本没有单独的 `observed_at` 字段。

### 3.2 其余服务器采集器

`linux-basic`、`linux-host-gauges`、`linux-filesystem`、`linux-diagnostic-gauges-v1`、`linux-filesystem-diagnostics-v1` 与上一包一致，仍为成功。`linux.filesystem.inode_used_percent` 仍有 2 个挂载点为 `unknown`/`null`，是既有缺测表达，不补 0。

## 4. 实例 1 试采

14/14 个采集器成功、30 个样本，与上一包一致（含 `replication_channels` 成功但 0 序列）。本包没有改 MySQL 路径。

## 5. 只读与清理证明

| 项 | 采集前 | 采集后 |
|---|---|---|
| `database_instances` 行数 | 5 | 5 |
| `servers` 行数 | 1 | 1 |
| 服务器 3 `collection_enabled` | 1 | 1 |
| `metric_policy_bindings` revision | `instance:1`=4，`server:3`=3 | 同左 |
| 3306 上 `max189_real_*` 一次性库 | 0 | 0 |

- 测试自身的源配置摘要前后一致：`original_configuration_digest=90f3ef2ee223fd2ff0371b1513d1293bb9ce0ea32610a9fe247f2c83055ae15a`，`original_configuration_unchanged=true`；该摘要与上一包相同，说明线上源配置在这两次试采之间没有变化。
- 一次性平台库建在 127.0.0.1:13306（库名 `max189_real_<pid>`），测试结束由 `DROP DATABASE` 删除；试采结束后该容器已停止并移除，13306 上没有残留库。
- 试采响应 `persisted=false`、`decision=attempted`，未写 `metrics_history`；未启用 `servers.collection_enabled`，未改线上绑定。
- 凭据只从该行已有密文或既有钥匙串读取，未打印、未提交；证据文件没有口令或密钥字段。

## 6. 环境放宽项（本包不改）

- MySQL 9.6 不暴露 `Innodb_deadlocks`，`mysql.innodb.deadlocks_total` 保持 `null` / `unknown`。
- 实例没有复制通道，`mysql.replication.*` 保持无序列。
- `linux.block.io_time_ms_total` 的 `ms` 单位不做速率转换，保留原值。
- 网络设备不开真实套接字，本包不碰。
- SSH 单测夹具没有端口和口令时继续跳过。

试采响应里的 `lifecycle_evidence` 字段仍为 `unavailable`：它是服务层按顶层 `access.evidence.counter` / `host_counter_epochs` / `snmp` 生成的报告字段，试采和生产走同一条判断，本包未改也未依赖它；采集器是否拿到生命周期证据以 `attempts` 的 `status` 和上述值为准。

## 7. 复现

```bash
cd apps/db-ops-api
UNIFIED_METRICS_REAL=true UNIFIED_METRICS_EXISTING=true SLIDE_DEBUG_ENV_FILE=<授权环境文件> METRICS_TEST_MYSQL_PORT=13306 \
UNIFIED_METRICS_VM_FINGERPRINT='SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA' \
pnpm exec vitest run src/metrics/config/unified.real.test.ts
```

机读证据：`docs/slide/development/MAX-238/trial-host-counter-lifecycle-20261027.json`（逐采集器尝试、三条修复项的样本值、只读前后对比、清理结果）。

## 8. 未覆盖

- 仍不是正式样本、健康判定、告警或生产发布；正式采集写在一次性库。
- 未跑浏览器、未跑全量、未开网络设备、未做 Zabbix 模板导入（MAX-237）。
