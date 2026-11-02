# MAX-238：一次性库上证明部分失败逐项解释

2026-10-27。本包补验收句「测试不污染正式历史/告警；部分失败逐项解释；等待首样本不显示健康」中的「部分失败逐项解释」：在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `PolicyService.changeBinding` 发布两个目标的既有包，再用现有 `MetricConfigurationService.trial`（经 `trialCurrent`）与 `createAssetCollectorAccess()` 对实例 1（`mysql3306`）和服务器 3（`192.168.49.130:22`）各跑一次真实试用，用**已有字段**证明每一条非良好样本都带自己的 `metric.id`、`quality.status` 和来自现有枚举的 `quality.reason`，解释留在 `samples` 里，没有被收成一个顶层错误，也没有被写成正式历史或健康样本。未改试用实现、状态实现、调度器、worker、routes、模板、绑定、策略、migration、前端或 `config/access.ts`，未改表，未跑 worker，未调用 `activate`。

## 结论

- 新增 `apps/db-ops-api/src/metrics/config/formal-partial-explanation.mysql.test.ts` 在真实目标上通过：`1 passed`（测试 7.03s，总 8.00s）；`tsc --noEmit` 通过。
- 两次试用合计 **112** 个样本，其中 **15 条非良好**：实例 5 条（`unknown`）、服务器 10 条（`unknown` 2、`partial` 8）。这是一次真实的部分失败，不是空超时或空适配器错误。
- 15 条非良好样本每条都是独立对象，均带 `metric.id`、`quality.status`（`partial`/`unknown`，本包无 `invalid`）和非空 `quality.reason`（`source_error`、`counter_baseline`、`not_applicable`、`precision_loss`），没有一条是 `none`。97 条良好样本保持 `status='good'`、`reason='none'`。
- 服务器 3 有 10 个重复 `metric.id`（最多 11 条同 id 样本），每一条仍带自己的 `quality` 对象；实例 1 的 30 个 `metric.id` 互不重复。
- 两次试用的 `decision='attempted'`、`persisted=false`、`samples` 非空、顶层 `error=null`；14 / 8 个 attempt 全部 `succeeded`、`evidence_code` 为空——逐项解释在 `samples[].quality`，不靠 attempt 级代码。
- 试用前后一次性库 `stage='normalized'` 观测、`metric_publications`、`alerts`、`alert_events`、`notification_records`、告警状态/迁移表全部为 0；`metric_schedule`、`metric_attempts` 也是 0。
- 试用后再读状态：`last_observed_at=null`、`freshness='unknown'`、`blockers` 含 **`AWAITING_SAMPLE`**、`collection.state='pending'`；两次试用与两次状态读取分别对应 `instance:1` 与 `server:3`。
- 应用库 3306 未写入：试用前后 `database_instances` 5 行、`servers` 1 行、服务器 3 `192.168.49.130:22` / `collection_enabled=1`、`instance:1` revision 4、`server:3` revision 3 逐项一致。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `38e760a672eb8080b3fe440dd092ceb1cb196f73` |
| 测试提交 / 证据 `run.head` | `dd9c2a6215ac0210fdc74464308f7dec3da682df` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/formal-partial-explanation.mysql.test.ts` |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_formal_partial_explanation_32804`，测试结束 `DROP DATABASE`，容器跑完移除 |
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
pnpm exec vitest run src/metrics/config/formal-partial-explanation.mysql.test.ts
```

## 2. 四项证明（真实目标，一次性库）

| 项 | `instance:1` | `server:3` |
|---|---|---|
| 绑定包 | `mysql-diagnostics@1.1.0` | `linux-host@1.1.0` |
| `decision` / `persisted` | `attempted` / **false** | `attempted` / **false** |
| 顶层 `error` | **null** | **null** |
| 采集器 attempts | 14（全部 `succeeded`，21–210ms） | 8（全部 `succeeded`，482–3285ms） |
| samples | 30 | 82 |
| 非良好样本 | **5** | **10** |
| 重复 `metric.id` | 0 | 10 个（最多 11 条同 id） |
| 试用后 `stage='normalized'` 观测 | **0** | **0** |
| `metric_publications` / `alerts` / `alert_events` / `notification_records` | **0 / 0 / 0 / 0** | **0 / 0 / 0 / 0** |
| 告警状态 / 迁移表 | **0 / 0** | **0 / 0** |
| 试用后 `last_observed_at` / `freshness` | **null** / **`unknown`** | **null** / **`unknown`** |
| 试用后 `blockers` | `APPLICATION_PENDING`、`CAPABILITY_UNKNOWN`、**`AWAITING_SAMPLE`** | 同左 |
| 试用后 `collection.state` | **`pending`**（非 `succeeded`） | **`pending`**（非 `succeeded`） |
| 试用/状态 `resource` | `{type:'instance', id:1}` | `{type:'server', id:3}` |

1. **真实的部分失败**：两次试用合计 15 条非良好样本（`partial` 8、`unknown` 7、`invalid` 0），样本总数为 112。
2. **逐项解释**：每条非良好样本都是独立对象，带自己的 `metric.id`、`quality.status`、非空 `quality.reason`；`reason` 来自 `QualitySchema` 现有枚举且不是 `none`。良好样本保持 `good`/`none`。
3. **解释留在 `samples`**：两次试用都是 `decision='attempted'`、`persisted=false`、`samples` 非空、顶层 `error=null`；attempt 全为 `succeeded`、`evidence_code` 为空，逐项原因没有被 attempt 级代码替代。
4. **不污染正式历史、不写成健康**：试用前后正式表与告警表全部 0 行；试用后状态仍是等待首样本、非 `succeeded`；资源 `instance:1` 与 `server:3` 各自独立。

## 3. 逐项解释证据

### 3.1 实例 1（mysql3306）

30 个样本：25 条 `good`/`none`，5 条非良好。`metric.id` 全部不同，无重复。

| metric | quality | reason | value |
|---|---|---|---|
| `mysql.innodb.deadlocks_total` | `unknown` | `source_error` | null |
| `mysql.transaction_commands.commit_rate` | `unknown` | `counter_baseline` | null |
| `mysql.transaction_commands.rollback_rate` | `unknown` | `counter_baseline` | null |
| `mysql.transaction_commands.completed_rate` | `unknown` | `counter_baseline` | null |
| `mysql.queries.per_second` | `unknown` | `counter_baseline` | null |

环境放宽保持不动，缺测仍为 null、不补 0；没有复制通道，`mysql.replication.*` 无序列。

### 3.2 服务器 3（192.168.49.130:22）

82 个样本：72 条 `good`/`none`，10 条非良好。10 个 `metric.id` 出现多次（含 `linux.filesystem.used_ratio`、`linux.filesystem.inode_used_percent`、各文件系统/接口/块设备序列），每条样本都带自己的 `quality`。

| metric | 非良好条数 | quality | reason | 同 id 良好条数 |
|---|---|---|---|---|
| `linux.filesystem.inode_used_percent` | 2 | `unknown` | `not_applicable` | 9（值 1–2%） |
| `linux.filesystem.used_ratio` | 8 | `partial` | `precision_loss` | 3（值 0） |

上一包记录的两项在本包中仍保留原有解释：仍非良好的样本保持 `unknown`/`not_applicable` 与 `partial`/`precision_loss`；同一 `metric.id` 下部分序列转为 `good` 的事实记入证据，不作为失败。`linux.block.io_time_ms_total` 保持 `ms`，未做速率转换；未开真实 SNMP，本包不测网络设备。

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

**表名说明**：本包要求的 `metric_v2_alert_state`、`metric_v2_alert_transitions` 在现有 migration 121（`apps/db-ops-api/sql/migrations/121_unified_metric_names.sql`）里已改名为 `metric_alert_state`、`metric_alert_transitions`。测试先解析实际存在的表名再断言计数，证据里同时记录请求名与解析名；`metric_publications` 同样来自该 migration 的改名。没有新增表，没有改表。

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

独立复核另外确认 13306 上没有残留 `max238%` 库，一次性容器已移除，测试临时脚本已删除；13306 已无监听。

## 6. 边界

- 本包不是生产发布、告警或整单验收；MAX238 保持 **in_progress**。未调用 `activate`，未跑 worker，未产生正式样本。
- 未测解绑、停写、切换、回退、超时、启用阻断或真实 SNMP；环境放宽保持不动（`mysql.innodb.deadlocks_total` 仍 null、复制无通道不出序列、`io_time_ms` 保持 `ms`）。
- 「未测或必要项失败阻止启用」仍留给后续包；`activate` 未被调用或修改。
- 未跑浏览器、未跑全量；只跑本包新增测试与 `tsc --noEmit`。
