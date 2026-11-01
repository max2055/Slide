# MAX-238：四个样本质量原因作为本次启用的可豁免集合

2026-10-28。本包把成员确认的四个样本质量原因写成这次启用的可豁免集合，并改掉上一包会失败的那条断言：这四类非良好样本不拦发布。仍在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `PolicyService.changeBinding`、`MetricConfigurationService.trialCurrent` 和 `MetricConfigurationService.activate`，对实例 1（`mysql3306`，`localhost:3306`）和服务器 3（`192.168.49.130:22`）各跑一次试用、一次 activate。未改采集器、试用实现、状态实现、调度器、worker、routes、模板、绑定、策略、migration、前端或 `config/access.ts`，未改表，未跑 worker，未对应用库调用 `activate`。

## 结论：四类可豁免原因不拦发布

**两个资源的非良好样本原因全部落在可豁免集合内，`activate` 都返回并发布（一次性库内 revision 1 → 2），`error_code=null`，没有抛 `CONFIGURATION_TRIAL_FAILED`。** 测试实际执行并通过（1 passed），不是 `describe.skip` 跳过。

可豁免集合只这四项，作为测试里的具名常量 `exemptNonGoodReasons`：

```ts
const exemptNonGoodReasons = ['source_error', 'counter_baseline', 'precision_loss', 'not_applicable'] as const;
```

- `instance:1`：试用 30 个样本，5 条非良好（`source_error` 1、`counter_baseline` 4）；14 个 attempt 全部 `succeeded`；`activate` 返回 `{ published: true, revision: 2 }`，`error_code=null`，一次性库 binding revision 1 → 2。
- `server:3`：试用 82 个样本，10 条非良好（`not_applicable` 2、`precision_loss` 8）；8 个 attempt 全部 `succeeded`；`activate` 返回 `{ published: true, revision: 2 }`，`error_code=null`，一次性库 binding revision 1 → 2。
- 两次试用合计 **112 个样本、15 条非良好**，`by_reason` = `{ source_error: 1, counter_baseline: 4, not_applicable: 2, precision_loss: 8 }`；集合外原因 `unexempted=[]`。
- 现有发布前置条件在两个资源上都成立：各有一条值非空的 `good` 样本，各有 `succeeded` attempt。`tests` 断言这两个前置条件本身为真，然后断言发布结果。
- 集合外若出现非良好原因，断言 `unexempted` 为空会失败，证据里已写下该 `metric.id`、`quality.status` 和 `quality.reason`；未把新原因补进集合，也未改成发布成功。

良好样本保持 `good` / `none`；缺失值保持 null，未补 0（`missing_value_filled=[]`，`source_error` / `counter_baseline` / `not_applicable` 样本的值断言为 null）。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 / 证据 `run.head` | `02aea91bd7cc43780fe49155d9d752317dac5c62` |
| 测试提交 | `564cdb3f5` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/formal-enablement-block.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/formal-enablement-exempt-20261028.json`（测试写出，未再覆盖 `formal-enablement-block-20261027.json`） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 8.4.10 容器），库名 `max238_formal_enablement_exempt_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 凭据来源 | 应用库行内既有密文，`decryptData` 解密后 `encryptData` 写进一次性库自己的行；未打印、未提交口令或密钥 |
| 实例目标 | id=1，`mysql3306`，`localhost:3306`（测试内断言名称与端口；只读 SQL） |
| 服务器目标 | id=3，`192.168.49.130:22`（测试内断言主机与端口；既有固定 SSH 命令） |
| 采集包 | `mysql-diagnostics@1.1.0`、`linux-host@1.1.0` |
| 调用实现 | 现有 `MetricConfigurationService.trialCurrent` / `MetricConfigurationService.activate` + `createTrialStore`；access 为 `createAssetCollectorAccess()`（未传 `true`） |
| 来源库写入 | 仅 `SELECT` |

运行命令（授权环境文件路径运行时通过 `SLIDE_DEBUG_ENV_FILE` 传入，不落仓库）：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
pnpm exec vitest run src/metrics/config/formal-enablement-block.mysql.test.ts
```

## 2. 两个资源的发布结果

| 项 | `instance:1` | `server:3` |
|---|---|---|
| 绑定包 | `mysql-diagnostics@1.1.0` | `linux-host@1.1.0` |
| `trialCurrent` `decision` / `persisted` | `attempted` / **false** | `attempted` / **false** |
| attempts | 14（全部 `succeeded`） | 8（全部 `succeeded`） |
| samples / 良好 / 非良好 | 30 / 25 / **5** | 82 / 72 / **10** |
| 非良好原因 | `source_error` 1、`counter_baseline` 4 | `not_applicable` 2、`precision_loss` 8 |
| 可豁免集合外原因 | 无 | 无 |
| `activate` 入参 | `{ expected_revision: 1, package }` | `{ expected_revision: 1, package }` |
| `activate` 结果 | **返回，`published=true`** | **返回，`published=true`** |
| `error_code` | **null** | **null** |
| 一次性库 revision 前 / 后 | 1 / **2** | 1 / **2** |
| `status.collection.state` | `pending` | `pending` |
| 正式表 / 告警表行数（前 / 后） | 全 0 / 全 0 | 全 0 / 全 0 |

## 3. 非良好样本逐项（原因均在可豁免集合内）

### 3.1 实例 1（mysql3306，5 条）

| metric | quality | reason | value |
|---|---|---|---|
| `mysql.innodb.deadlocks_total` | `unknown` | `source_error` | null |
| `mysql.transaction_commands.commit_rate` | `unknown` | `counter_baseline` | null |
| `mysql.transaction_commands.rollback_rate` | `unknown` | `counter_baseline` | null |
| `mysql.transaction_commands.completed_rate` | `unknown` | `counter_baseline` | null |
| `mysql.queries.per_second` | `unknown` | `counter_baseline` | null |

### 3.2 服务器 3（192.168.49.130:22，10 条）

| metric | 条数 | quality | reason |
|---|---|---|---|
| `linux.filesystem.inode_used_percent` | 2 | `unknown` | `not_applicable` |
| `linux.filesystem.used_ratio` | 8 | `partial` | `precision_loss` |

环境放宽保持不动：`mysql.innodb.deadlocks_total` 仍允许 null，复制无通道不产出序列，`io_time_ms` 保持 `ms`；未补 0，未开真实 SNMP，未测网络设备。

## 4. 产品代码未改，必需指标名单本次未定

`apps/db-ops-api/src/metrics/config/service.ts` 的发布条件**未改**：仍是「绑定启用时，至少一条值非空且 `quality.status='good'` 的样本，且至少一个 `succeeded`/`partial` 的 attempt」。本包没有改严 `activate`、没有加必需项参数、没有定义必需指标名单，也没有改 `routes.test.ts` / `package-switch.test.ts` 里已有的 `CONFIGURATION_TRIAL_FAILED` 断言。**必需指标名单本次未定**；真正仍应拦住启用的是尝试失败、解析失败、连接失败，或一个必需指标根本没有良好样本，名单定了再由单独授权包接线。

## 5. 正式历史与只读证明

| 表 | 试用 + activate 前 | 后 |
|---|---|---|
| `metric_observations`（`stage='normalized'`） | 0 | 0 |
| `metric_publications` | 0 | 0 |
| `alerts` | 0 | 0 |
| `alert_events` | 0 | 0 |
| `notification_records` | 0 | 0 |
| 告警状态表 / 告警迁移表 | 0 / 0 | 0 / 0 |

**表名说明**：migration 121 已把 `metric_v2_alert_state`、`metric_v2_alert_transitions` 改名为 `metric_alert_state`、`metric_alert_transitions`；测试先解析实际存在的表名再断言计数。配置 revision 的发布不是正式样本，正式表前后都是 0。

| 项 | 测试前 | 测试后 | 容器移除后独立只读复核 |
|---|---|---|---|
| `database_instances` 行数 | 5 | 5 | 5 |
| `servers` 行数 | 1 | 1 | 1 |
| 服务器 3 `host` / `port` | `192.168.49.130` / 22 | 同左 | 同左 |
| 服务器 3 `collection_enabled` | 1 | 1 | 1 |
| `instance:1` 线上 revision | 4 | 4 | 4 |
| `server:3` 线上 revision | 3 | 3 | 3 |
| 3306 上 `max238%` 库 | —— | —— | 0 |

一次性库已在测试结束 `DROP DATABASE`（容器内无 `max238%` 库）；13306 容器已移除，端口无监听。

## 6. 验证命令与边界

```text
pnpm exec vitest run src/metrics/config/formal-enablement-block.mysql.test.ts
Test Files  1 passed (1)
      Tests  1 passed (1)

pnpm exec tsc --noEmit
tsc_exit=0
```

- 本包不是生产发布、告警或整单验收；MAX238 保持 **in_progress**。
- 未跑 worker、浏览器或全量测试；未测解绑、停写、切换、回退、超时重试或真实 SNMP。
- 未改 `formal-enablement-block-20261027.md` / `.json`，它们仍是「非良好样本仍在时现有 activate 仍会发布」的历史阻塞记录。
