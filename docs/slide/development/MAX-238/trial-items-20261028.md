# MAX-238：一次性库上验证试用逐项返回读取、转换、单位校验、值、时间、耗时和错误

2026-10-28。本包补验收句「测试逐项返回读取/转换/单位校验、值/时间/耗时/错误」：在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `recommendations`、现有 `PolicyService.changeBinding` 和现有 `MetricConfigurationService.trialCurrent`，对实例 1（`mysql3306`）的一份已发布绑定跑一次现有试用，再只用这次试用返回的 `samples` 与对应 `attempts` 逐项核对七项。产品侧只改了 `MetricConfigurationService.trial()` 成功返回里的样本投影，把采集执行已经算出的读取、转换版本和映射单位对交出去；启用谓词、`activate` 与契约形状未改。

## 结论：七项都能从这次试用返回里逐项读到

**读取、转换、单位校验、值、时间、耗时、错误七项都从同一次试用返回里逐项读到；至少一条实际样本同时读到读取、转换和单位校验，测试通过（1 passed）。** 三项新增字段全部来自本次试用已经产生的数据，没有新造语义、转换器或单位换算。

| 项 | 返回里的来源键 | 本次读到的值 | 结论 |
|---|---|---|---|
| 读取 | `samples[].read.attempt_id` + `samples[].read.status` | `trial:31ff9bb2-…:mysql-status`、`succeeded` | 成立，取该观测 `source.attempt_id` 对齐到的 attempt |
| 转换 | `samples[].transform.version` | `1.0.0` | 成立，等于该观测已有的 `versions.transform_version` |
| 单位校验 | `samples[].unit_check.input_unit` + `samples[].unit_check.output_unit` | `s` / `s` | 成立，取产生该样本的采集映射上已声明的一对单位 |
| 值 | `samples[].value` | `{ encoding: 'float64', value: 204468 }` | 成立 |
| 时间 | `attempts[].started_at` | `2026-10-28T08:27:59.187Z` | 成立（采集器粒度） |
| 耗时 | `attempts[].ended_at - attempts[].started_at` | `18` ms | 成立（只用现有时间戳相减） |
| 错误 | `attempts[].error` | `null`（该次尝试无错误） | 成立（可为空） |

核对口径：

- 读取只认 `read`。采集器级 `attempt.status=succeeded` 不能代替逐项读取，测试没有用它填读取。
- 转换只认 `transform.version`。`quality` 不能代替转换版本。
- 单位校验只认 `unit_check` 的一对输入/输出单位。本次这对 `s` / `s` 是从 `mysql-basic@2.0.0` 的采集映射 `mysql-status` → `db.uptime_seconds` 上读出的已声明单位对，不是把 `samples[].unit` 的字符串抄到两头；该映射本身就把输入、输出都声明为秒。派生样本没有采集映射时不写 `unit_check`，本条样本不是派生样本。
- 对不上任何 `attempts[].id` 的观测不写 `read`；没有 `transform_version` 的观测不写 `transform`，也不写占位版本。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `ac964cc820e1d288dad698bbaacc84db2c5f0b52` |
| 证据 `run.head` | `195a0a503a28f68dacc539029292490bd270a1ce` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/trial-items.mysql.test.ts` |
| 实现文件 | `apps/db-ops-api/src/metrics/config/service.ts`（仅 `trial()` 成功样本投影） |
| 证据 JSON | `docs/slide/development/MAX-238/trial-items-20261028.json`（测试写出） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器，实测 `8.4.10`），库名 `max238_trial_items_<pid>`，测试结束 `DROP DATABASE` |
| 资源行 | `instance:1`（`mysql3306`、端口 3306、`active` + `available`），只存在于一次性库 |
| 绑定包 | `mysql-basic@2.0.0`，digest `sha256:a38519cb02bf92ce0b5d81f8d6e0dd6277bcc5f73abf92128747df8d9ee25322`；pin 的 id、version、digest 从当次 `recommendations` 的兼容已发布 release 读，未写死推荐名字 |
| 目标 | 已纳管 `mysql3306`（`localhost:3306`），服务器实测 `9.6.0`；凭据由授权应用库该行解密后只写入一次性库自己的实例行（未打印、未记录） |
| 应用库 | 只用 `SELECT`；未做 `INSERT`/`UPDATE`/`DELETE` |
| 调用实现 | 现有 `MetricConfigurationService.trialCurrent` + `createTrialStore`；access 为 `createAssetCollectorAccess()` |

运行命令（授权环境文件路径运行时通过 `SLIDE_DEBUG_ENV_FILE` 传入，不落仓库）：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
  pnpm exec vitest run src/metrics/config/trial-items.mysql.test.ts
```

## 2. 这次试用实际返回了什么

| 项 | 值 |
|---|---|
| 绑定 revision | 1（先以 `expected_revision: 0` 发布） |
| `trialCurrent` | `persisted=false`、`decision=attempted`、顶层 `error=null` |
| samples | 1 条：`db.uptime_seconds`，`quality={good,none}`，`unit='s'`，外加 `read` / `transform` / `unit_check` |
| attempts | 1 条：`collector_id=mysql-status`、`status=succeeded`、`error=null`、`observation_ids` 1 个 |
| 顶层键 | `applicability`、`attempts`、`capabilities`、`decision`、`lifecycle_evidence`、`persisted`、`samples`、`trial` |
| 样本键 | `metric`、`quality`、`read`、`transform`、`unit`、`unit_check`、`value` |
| 尝试键 | `binding_id`、`collector_id`、`config_revision`、`ended_at`、`error`、`id`、`observation_ids`、`resource_id`、`started_at`、`status` |

样本与尝试的对应关系来自观测自身的 `source.attempt_id`（测试再用包内 collector→metric 映射兜底），不是测试新增字段。证据中未记录口令、密文或密钥。

## 3. 正式历史与只读证明

| 表 | 试用前 | 试用后 |
|---|---|---|
| `metric_observations` | 0 | 0 |
| `metric_publications` | 0 | 0 |
| `alerts` | 0 | 0 |
| `alert_events` | 0 | 0 |
| `notification_records` | 0 | 0 |

应用库只读快照前后逐项相等：

| 项 | 试用前 | 试用后 |
|---|---|---|
| `database_instances` 行数 | 5 | 5 |
| `servers` 行数 | 1 | 1 |
| `instance:1` 绑定 revision | 4 | 4 |

一次性库已 `DROP DATABASE`；13306 的一次性容器已移除。

## 4. 产品代码改动范围

- `apps/db-ops-api/src/metrics/config/service.ts` 只改 `trial()` 成功返回里的样本投影：按观测 `source.attempt_id` 对齐 `attempts[].id` 写 `read`，按 `versions.transform_version` 写 `transform.version`，按 `source.collector_id` 与 `metric` 对上包内映射写 `unit_check`。失败返回的空 `samples` 保持空数组。
- **启用谓词（`config/service.ts:54-56`）没有进 diff**，没有改 `activate`，没有加必需指标名单，也没有调用 `activate`。
- `policy/`、`policy/store.ts`、routes、registry、builtins、migration、`config/access.ts`、前端与旧证据均未改；测试文件只去掉「这三项必定缺字段」的写死结论。
- 没有写 3306 业务表，没有停写、复制整库、切换、回退或解绑；没有改线上绑定或采集开关。
- 没有跑浏览器、worker 或全量测试；没有开子代理。

## 5. 验证命令与结果

```text
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
  pnpm exec vitest run src/metrics/config/trial-items.mysql.test.ts
Test Files  1 passed (1)
      Tests  1 passed (1)

pnpm exec tsc --noEmit
tsc_exit=0
```

测试实际执行（不是 `describe.skip` 跳过）。证据 JSON 逐项记录七项各自的来源键、实际值、缺失项（空）以及「至少一条样本同时读到读取/转换/单位校验」的计数 1。

本包不是生产发布、告警或整单验收；MAX-238 保持 **in_progress**。
