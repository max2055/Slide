# MAX-238：一次性库上验证未测或必要项失败是否阻止启用

2026-10-27。本包补验收句「未测或必要项失败阻止启用」：在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `PolicyService.changeBinding` 发布两个目标的既有包，再用现有 `MetricConfigurationService.trialCurrent` 对实例 1（`mysql3306`）和服务器 3（`192.168.49.130:22`）各跑一次真实试用，然后用该资源当前 binding revision 调用现有 `MetricConfigurationService.activate`，观察非良好样本仍在时是否会被阻断。未改采集器、试用实现、状态实现、调度器、worker、routes、模板、绑定、策略、migration、前端或 `config/access.ts`，未改表，未跑 worker，未对应用库调用 `activate`。

## 结论：条件不成立（阻塞结果）

**在仍有 15 条非良好样本（实例 5、服务器 10）的情况下，两个资源的 `activate` 都返回并发布了新 revision（1 → 2），没有抛 `CONFIGURATION_TRIAL_FAILED`。**

- `instance:1`：试用 30 个样本，5 条非良好；`activate` 返回 `{ published: true, revision: 2 }`，`error_code=null`，binding revision 由 1 变为 2。
- `server:3`：试用 82 个样本，10 条非良好；`activate` 同样返回 `{ published: true, revision: 2 }`，`error_code=null`，revision 由 1 变为 2。
- 现有发布条件（`apps/db-ops-api/src/metrics/config/service.ts:55-56`）在绑定启用时只要求「一条值非空且 `quality.status='good'` 的样本」加「一条 `succeeded` 或 `partial` 的 attempt」。两次真实试用都满足该条件（实例 25 条良好 / 14 个 attempt，服务器 72 条良好 / 8 个 attempt），所以非良好样本不构成阻断。
- 现有 `activate` 入参没有「显式排除可选项」或「必需项」参数，本包按现有调用形状（`{ expected_revision, package }`）无法把这些非良好样本标成已排除或必需项。

新增测试 `formal-enablement-block.mysql.test.ts` 按本包要求断言「非良好样本仍在时不得发布」，因此**测试当前为失败状态（1 failed）**，失败点即上表事实。这是本包的阻塞结果，不是测试缺陷；未把断言改成「发布成功也算通过」，也未改产品代码让它变绿。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 / 证据 `run.head` | `2fa795e2a11cd77cd8312177015c32851c4c53a7` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/formal-enablement-block.mysql.test.ts` |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_formal_enablement_block_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
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

## 2. 两个资源的观测

| 项 | `instance:1` | `server:3` |
|---|---|---|
| 绑定包 | `mysql-diagnostics@1.1.0` | `linux-host@1.1.0` |
| `trialCurrent` `decision` / `persisted` | `attempted` / **false** | `attempted` / **false** |
| 顶层 `error` | null | null |
| attempts | 14（全部 `succeeded`） | 8（全部 `succeeded`） |
| samples | 30 | 82 |
| 良好样本 | 25 | 72 |
| 非良好样本 | **5** | **10** |
| `activate` 入参 | `{ expected_revision: 1, package }` | `{ expected_revision: 1, package }` |
| `activate` 结果 | **返回，`published=true`** | **返回，`published=true`** |
| `error_code` | **null** | **null** |
| revision 调用前 / 后 | 1 / **2** | 1 / **2** |
| `status.collection.state` | `pending` | `pending` |
| `formal_visibility.last_observed_at` / `freshness` | null / `unknown` | null / `unknown` |
| `blockers` | `APPLICATION_PENDING`、`CAPABILITY_UNKNOWN`、`AWAITING_SAMPLE` | 同左 |
| 正式表 / 告警表行数 | 全 0 | 全 0 |

## 3. 非良好样本逐项（仍为独立解释）

两次试用合计 **112** 个样本、**15 条非良好**（`partial` 8、`unknown` 7、`invalid` 0）。每条都有 `metric.id`、`quality.status` 和非空且不是 `none` 的 `quality.reason`；良好样本保持 `good`/`none`。

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

## 4. 发布条件与缺条件位置

`apps/db-ops-api/src/metrics/config/service.ts:54-56` 现有逻辑：

```ts
const disabled = !preview.resources[0].resolved.settings.enabled;
rule(disabled || trial.samples.some(s => s.value !== null && s.quality.status === 'good')
  && trial.attempts.some(a => ['succeeded', 'partial'].includes(a.status)), 'CONFIGURATION_TRIAL_FAILED', 422);
```

即：绑定启用时，只要**一条**良好样本加**一个**成功 attempt 就继续发布；非良好样本（部分失败、未知、不适用）不参与判定。两次真实试用都满足，因此 `activate` 发布。

要让「未测或必要项失败阻止启用」成立，需要产品侧先明确哪些 metric 是必需项、哪些非良好原因可豁免，并让 `activate` 的判定读取该信息；当前调用参数与判定逻辑都没有这个维度。本包只记录该事实，未修改 `config/service.ts` 或任何表。

## 5. 正式历史与只读证明

| 表 | 试用前 | 两次试用 + 两次 activate 后 |
|---|---|---|
| `metric_observations`（`stage='normalized'`） | 0 | 0 |
| `metric_publications` | 0 | 0 |
| `alerts` | 0 | 0 |
| `alert_events` | 0 | 0 |
| `notification_records` | 0 | 0 |
| 告警状态表 / 告警迁移表 | 0 / 0 | 0 / 0 |

**表名说明**：migration 121 已把 `metric_v2_alert_state`、`metric_v2_alert_transitions` 改名为 `metric_alert_state`、`metric_alert_transitions`；测试先解析实际存在的表名再断言计数，证据里同时记录请求名与解析名。

| 项 | 测试前 | 测试后 | 容器移除后独立只读复核 |
|---|---|---|---|
| `database_instances` 行数 | 5 | 5 | 5 |
| `servers` 行数 | 1 | 1 | 1 |
| 服务器 3 `host` / `port` | `192.168.49.130` / 22 | 同左 | 同左 |
| 服务器 3 `collection_enabled` | 1 | 1 | 1 |
| `instance:1` revision | 4 | 4 | 4 |
| `server:3` revision | 3 | 3 | 3 |
| 3306 上 `max238%` 库 | —— | —— | 0 |

一次性库已在测试结束 `DROP DATABASE`；13306 容器已移除，端口无监听。

## 6. 边界与后续

- 这是阻塞结果：验收句「未测或必要项失败阻止启用」在真实目标上**不成立**；测试保持失败，不改成通过。
- 本包不是生产发布、告警或整单验收；MAX238 保持 **in_progress**。未对应用库 `activate`，未跑 worker，未产生正式样本。
- 未测解绑、停写、切换、回退、超时重试或真实 SNMP；只跑本包新增测试与 `tsc --noEmit`，未跑浏览器与全量。
- 后续需要产品/Chief 决定「必需项与非良好原因的可豁免集合」，再由单独授权包接线；本包不派发、不改产品代码。
