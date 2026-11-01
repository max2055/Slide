# MAX-238：一次性库上证明可以保存而不启用，也可以走绑定→检查→测试→应用并启用

2026-10-28。本包在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `recommendations`、现有 `status`、现有 `PolicyService.changeBinding`、现有 `MetricConfigurationService.trial` 与现有 `activate`，证明验收句「流程为绑定→检查→测试→应用并启用，也可保存不启用」。两条演示用一次性库里的两个不同实例行，因此前一条留下的绑定不会被后一条冲掉。当前模型每个资源仍然只有一个 pin；没有新做多模板保存，没有改状态 blocker 枚举，没有改 `activate` 的启用谓词。

## 结论：两条全部成立

测试实际执行并通过（`Tests 1 passed (1)`，不是 `describe.skip` 跳过）。

- 实例 1 只发布后读 `status`，没有调用 `activate`、`trial`、`databaseService.getConnection`，没有打开任何目标端口：pin 读回一致，revision 1，绑定 1 行，`policy_enabled=false`、`effective_enabled.enabled=false`、来源层 `resource`、`collection.state=disabled`、应用状态 `pending`、`applied_revision=null`，正式观测/发布/告警表都是 0。
- 实例 2 先绑定并读 `status`（检查），再用现有试用拿到良好样本（不写正式历史/告警），随后 `activate` 返回 `published: true`，revision 从 1 增到 2，绑定 1 行；实例 1 的 pin、revision 1 与 `enabled: 'disable'` 保持不变。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `fcff04b82427b75e349563d3a80ba34781201713` |
| 测试提交 | `b053c42a1` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/flow-or-save.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/flow-or-save-20261028.json`（测试写出） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_flow_or_save_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 资源行 1 | `instance:1`（`mysql` / `8.0.46`，`active` + `available`，口令列留空） |
| 资源行 2 | `instance:2`（`name=mysql3306`、端口 3306、`mysql` / `8.0.46` 行，`active` + `available`，只存在于一次性库） |
| 目标 | 已纳管的 `mysql3306`（`localhost:3306`），服务器实测 `9.6.0`；凭据由授权应用库该行解密后只写入一次性实例 2 |
| 应用库 3306 | 只用 `SELECT` 读取该目标行与只读快照；没有 `INSERT`/`UPDATE`/`DELETE` 业务表 |

运行命令（授权环境文件路径运行时通过 `SLIDE_DEBUG_ENV_FILE` 传入，不落仓库）：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
  pnpm exec vitest run src/metrics/config/flow-or-save.mysql.test.ts
```

## 2. 保存不启用（实例 1）

开始时未绑定：`state=unbound`、`published_revision=null`、绑定表 0 行。pin 的 id、version、digest 从当次 `recommendations` 的兼容已发布 release 里读，并与注册表里的同一 release 一致，没有写死推荐名字。

| 项 | 结果 |
|---|---|
| 提交的 pin | `mysql-basic@1.0.0`，digest `sha256:f35d9c93e1c63b080db59482018e0331e8500da8da5613fd8820988a12b57f1c` |
| 覆盖 | `overrides.enabled = 'disable'` |
| 读回 | id、version、digest 与提交一致；revision **1**；绑定表 **1 行** |
| `status.binding` | `state=bound`、`published_revision=1`、`applied_revision=null`、`application=pending` |
| `status.effective_enabled` | `policy_enabled=false`、`enabled=false`、`source=resource` |
| `status.collection` | `state=disabled` |
| 正式表 | `metric_observations`/`metric_publications`/`alerts`/`alert_events`/`notification_records` 均为 0 |

这一条到此结束，绑定留在该状态：没有调用 `activate`，没有调用 `trial`，没有调用 `databaseService.getConnection`，没有打开任何目标端口。

## 3. 绑定→检查→测试→应用并启用（实例 2）

先发布另一个从 `recommendations` 读到的兼容已发布 pin，不带 `enabled: 'disable'`，默认启用来自 release 自己的 `enabled: true`。

| 步骤 | 结果 |
|---|---|
| 绑定 | `mysql-representative@1.0.0`，digest `sha256:c785f27645ad4dd658b7212a8edbdfc719f6a69135e5fec799f625714bb45460`，revision **1**，绑定表 **1 行** |
| 检查（`status`） | `state=bound`、pin 与提交一致、`published_revision=1`、`applied_revision=null`、`application=pending`、`policy_enabled=true`、`effective_enabled.enabled=true`、`collection.state=pending`；正式表仍为 0 |
| 测试（`trial`，`expected_revision=1`） | `persisted=false`、`decision=attempted`、`error=null`；5 个采集器：4 个 `succeeded`、1 个 `failed`；8 个样本，其中 5 个 `good`；正式表仍为 0 |
| 应用并启用（`activate`，`expected_revision=1`） | `published=true`；读回 pin 仍是 `mysql-representative@1.0.0`，revision **2**（比试用前增加），绑定表 **1 行** |

- 试用只返回本次读数，不写正式历史、发布或告警；应用后这些表仍为 0。
- `activate` 的成功使用现有谓词：需要试用中至少一个良好样本且有 succeeded/partial 的尝试。1 个采集器失败没有把整次试用收成顶层错误，也没有被本包改写成通过；证据里保留了逐项 `attempt_statuses`。
- 目标只收到现有采集器的只读语句；3306 业务表没有 `INSERT`/`UPDATE`/`DELETE`。目标行实测版本 `9.6.0` 与一次性行标注的 `8.0.46` 都在证据里如实记录。

## 4. 两个资源互不影响

- `instance:1` 的 pin、revision 1 与 `overrides.enabled='disable'` 在实例 2 完成应用后仍然保留，绑定表仍 1 行。
- `instance:2` 的 pin 与 revision 2 只写在自己的 `resource_key` 上；两个资源没有共享配置。

## 5. 只读与清理证据

应用库只读快照在测试前后逐项相等：

| 项 | 测试前 | 测试后 |
|---|---|---|
| `database_instances` 行数 | 5 | 5 |
| `servers` 行数 | 1 | 1 |
| `instance:1` 绑定 revision | 4 | 4 |
| 3306 上 `max238%` 库 | 0 | 0 |

- 来源库连接只执行 `SELECT`；凭据复制是解密后写一次性库实例 2，未对 3306 的 `database_instances`、`servers`、`metric_policy_bindings` 做 `INSERT`/`UPDATE`/`DELETE`。
- 口令、密文与密钥都没有打印，也没有进入证据 JSON。
- 一次性库已 `DROP DATABASE`；13306 的一次性容器已移除，端口无监听。

## 6. 产品代码未改

- 本包只新增测试与两份证据；`config/service.ts`、`policy/service.ts`、`policy/model.ts`、`resolver.ts`、`config/access.ts`、routes、registry、builtins、migration、前端、`policy/store.ts`、已有测试与旧证据均未改。内存与 MySQL 行为一致，不需要最小修改 `policy/store.ts`。
- `service.ts` 未改；**没有改 `activate` 的启用谓词**，没有改「必要项失败阻止启用」判断，没有加必需指标名单。
- **没有写 3306 业务表**；没有停写、复制整库、切换、回退或解绑；没有改线上绑定或采集开关。
- 没有跑浏览器、worker 或全量测试；没有开子代理。

## 7. 验证命令与结果

```text
METRICS_TEST_MYSQL_PORT=13306 SLIDE_DEBUG_ENV_FILE=<授权环境文件> \
  pnpm exec vitest run src/metrics/config/flow-or-save.mysql.test.ts
Test Files  1 passed (1)
      Tests  1 passed (1)

pnpm exec tsc --noEmit
tsc_exit=0
```

本包不是生产发布、告警或整单验收；MAX-238 保持 **in_progress**。
