# MAX-238：一次性库上验证试用是否逐项返回读取、转换、单位校验、值、时间、耗时和错误

2026-10-28。本包补验收句「测试逐项返回读取/转换/单位校验、值/时间/耗时/错误」：在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `recommendations`、现有 `PolicyService.changeBinding` 和现有 `MetricConfigurationService.trialCurrent`，对实例 1（`mysql3306`）的一份已发布绑定跑一次现有试用，再只用这次试用返回的 `samples` 与对应 `attempts` 逐项核对七项。未改采集器、试用实现、状态实现、调度器、worker、routes、模板、绑定、策略、migration、前端或 `config/service.ts`，未加字段，未调用 `activate`。

## 结论：三项没有对应字段（阻塞结果）

**「值 / 时间 / 耗时 / 错误」能从本次试用返回值逐项读到；「读取 / 转换 / 单位校验」在现有返回里没有对应字段，因此本包停在这三项，测试保持失败（1 failed），不记成通过。**

| 项 | 现有返回里的来源 | 本次读到的值 | 结论 |
|---|---|---|---|
| 读取 | **无**。`attempt.status` 只是采集器级状态（`succeeded`），一 个采集器可映射多个监控项，不能说明该样本读到了什么 | —— | **缺字段** |
| 转换 | **无**。返回值没有 `transform_version`、预处理阶段或 raw→normalized 链路 | —— | **缺字段** |
| 单位校验 | **无**。`samples[].unit` 只是单位字符串 `s`，不是校验通过/失败结果 | —— | **缺字段** |
| 值 | `samples[].value` | `{ encoding: 'float64', value: 195962 }` | 成立 |
| 时间 | `attempts[].started_at` | `2026-10-28T06:06:13.113Z` | 成立（采集器粒度） |
| 耗时 | `attempts[].ended_at - attempts[].started_at` | `16` ms | 成立（只用现有时间戳相减） |
| 错误 | `attempts[].error` | `null`（该次尝试无错误） | 成立（可为空） |

按验收要求「返回值里没有的项，就停在该项」，本包没有用 `quality.status`、`quality.reason` 代替读取、转换或单位校验，也没有把单位字符串写成单位校验，没有另造计时。测试断言七项都可读，因此在缺失项处失败；证据 JSON 逐项记录了实际键与缺失原因。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 / 证据 `run.head` | `1cff08b6002fed70c1d17a0830bf4e2ffe64672a` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/trial-items.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/trial-items-20261028.json`（测试写出） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器，实测 `8.4.10`），库名 `max238_trial_items_<pid>`，测试结束 `DROP DATABASE` |
| 资源行 | `instance:1`（`mysql3306`、端口 3306、`active` + `available`），只存在于一次性库 |
| 绑定包 | `mysql-basic@2.0.0`，digest `sha256:a38519cb02bf92ce0b5d81f8d6e0dd6277bcc5f73abf92128747df8d9ee25322`；pin 的 id、version、digest 从当次 `recommendations` 的兼容已发布 release 读，未写死推荐名字 |
| 目标 | 已纳管 `mysql3306`（`localhost:3306`），服务器实测 `9.6.0`；凭据由授权应用库该行解密后只写入一次性库自己的实例行 |
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
| 绑定 revision | 1（`expected_revision: 0` 发布） |
| `trialCurrent` | `persisted=false`、`decision=attempted`、顶层 `error=null` |
| samples | 1 条：`db.uptime_seconds`，`quality={good,none}`，`unit='s'` |
| attempts | 1 条：`collector_id=mysql-status`、`status=succeeded`、`error=null`、`observation_ids` 1 个 |
| 顶层键 | `applicability`、`attempts`、`capabilities`、`decision`、`lifecycle_evidence`、`persisted`、`samples`、`trial` |
| 样本键 | `metric`、`quality`、`unit`、`value` |
| 尝试键 | `binding_id`、`collector_id`、`config_revision`、`ended_at`、`error`、`id`、`observation_ids`、`resource_id`、`started_at`、`status` |

样本与尝试的对应关系来自已安装包自己的 collector→metric 映射（`mysql-status` → `db.uptime_seconds`），不是测试新增字段。证据中未记录口令、密文或密钥。

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

## 4. 产品代码未改

- 本包只新增测试与两份证据；`config/service.ts`、`policy/service.ts`、`policy/model.ts`、`resolver.ts`、`config/access.ts`、routes、registry、builtins、migration、前端、`policy/store.ts`、已有测试与旧证据均未改。
- `service.ts` 未改，没有为了让七项出现而给试用响应、契约或 `config/service.ts` 加字段。
- **没有调用 `activate`**，没有改 `activate` 的启用谓词，没有加必需指标名单。
- 没有写 3306 业务表，没有停写、复制整库、切换、回退或解绑；没有改线上绑定或采集开关。
- 没有跑浏览器、worker 或全量测试；没有开子代理。

## 5. 验证命令与结果

```text
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
  pnpm exec vitest run src/metrics/config/trial-items.mysql.test.ts
Test Files  1 failed (1)
      Tests  1 failed (1)
AssertionError: items with no field in the existing trial response: 读取、转换、单位校验

pnpm exec tsc --noEmit
tsc_exit=0
```

测试实际执行（不是 `describe.skip` 跳过）。失败点即上表缺失项；这是本包的阻塞结果，不是测试缺陷。要让这三项逐项返回，需要产品侧先定义读取结果、转换阶段与单位校验结果在试用 response / 契约中的形状，再由单独授权包接线；本包不改产品代码。

本包不是生产发布、告警或整单验收；MAX-238 保持 **in_progress**。
