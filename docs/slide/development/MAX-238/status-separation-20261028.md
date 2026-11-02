# MAX-238：一次性库上证明状态读数把发布、应用、等待首样本和正式采集成功分开

2026-10-28。本包补验收句「草稿保存、版本发布、pending/applied/failed、等待首样本、正式采集成功分开显示」。现有产品没有单独的草稿绑定类型，本包也不新造；这里只证明 `configurationStatus` 里已有的四个位置各读各的：版本发布就是现有 `PolicyService.changeBinding` 的 `binding.published_revision`，应用状态就是 `binding.application` / `binding.applied_revision`，等待首样本就是 `AWAITING_SAMPLE` blocker 与 `formal_visibility.last_observed_at`，正式采集成功就是 `collection.state='succeeded'`。

## 结论：三条都成立，四个位置不能互相代替

在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `MetricConfigurationService.recommendations` 读 pin、现有 `PolicyService.changeBinding` 发布、现有 `MysqlPolicyStore.reportApplied` 报应用结果、现有 `MetricConfigurationService.status` 读状态，三份 `status()` 的实际键值如下，测试实际执行并通过（1 passed）。

| # | 场景 | `published_revision` | `application` | `applied_revision` | `blockers` | `last_observed_at` | `freshness` | `collection.state` |
|---|---|---|---|---|---|---|---|---|
| 1 | 发布后、未应用 | 1 | `pending` | `null` | `APPLICATION_PENDING`、`CAPABILITY_UNKNOWN`、`AWAITING_SAMPLE` | `null` | `unknown` | `pending` |
| 2 | `reportApplied(...,'applied')` 后 | 1 | `applied` | 1 | `CAPABILITY_UNKNOWN`、`AWAITING_SAMPLE` | `null` | `unknown` | `pending` |
| 3 | 另一资源 `reportApplied(...,'failed')` 后 | 1 | `failed` | `null` | `APPLICATION_FAILED`、`CAPABILITY_UNKNOWN`、`AWAITING_SAMPLE` | `null` | `unknown` | `pending` |

- **发布不是 applied**：第 1 份 `application=pending`、`applied_revision=null`，同时 `APPLICATION_PENDING` 在 blockers 里。
- **applied 不会清掉等待首样本**：第 2 份 `application=applied` 且 `applied_revision=published_revision=1`，但 `AWAITING_SAMPLE` 仍在、`last_observed_at` 仍为 `null`、`freshness` 仍为 `unknown`。
- **failed 不是 applied**：第 3 份 `application=failed`、`applied_revision=null`、`APPLICATION_FAILED` 在 blockers 里，`AWAITING_SAMPLE` 仍在。
- **三者都不是正式采集成功**：三份 `collection.state` 都是 `pending`，没有一份是 `succeeded`。`succeeded` 需要当前 revision 上存在 `succeeded` 的 attempt；本包没有插入任何 attempt、观测或发布（见下）。
- 两份资源各自 `status()` 只报自己的 `resource`（`instance:1` / `instance:2`）和自己的 pin，没有串配置。

`CAPABILITY_UNKNOWN` 是现有行为（本包没有写入能力证据，也没有跑检查），不是本条验收的失败项；测试只断言本条要求出现的 blocker 存在。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `3d793ab18db348191ff0f352ec061be38e93fd40` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/status-separation.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/status-separation-20261028.json`（测试写出，`run.head` 记录执行时 HEAD，即基点） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_status_separation_<pid>`，测试结束 `DROP DATABASE`，容器跑完删除 |
| 资源行 | `instance:1`、`instance:2`，一次性库里 `status='active'` + `lifecycle_state='available'`；不连任何已纳管目标 |
| pin | 两份资源分别从当次 `recommendations` 的兼容已发布 release 读出（本次均为 `mysql-basic@1.0.0`），未写死推荐名字 |
| 应用库 | 未连接；未对 3306 发语句 |
| 未调用 | `activate`、worker、trial、任何采集；未插入 attempt / observation / publication |

运行命令：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/status-separation.mysql.test.ts
```

验证结果：`Test Files 1 passed (1)`、`Tests 1 passed (1)`，测试实际执行（未跳过）；`pnpm exec tsc --noEmit` 退出码 0。

## 2. 没有伪造正式成功

| 表 | 测试前 | 测试后 |
|---|---|---|
| `metric_observations` | 0 | 0 |
| `metric_publications` | 0 | 0 |
| `metric_attempts` | 0 | 0 |

三份 `collection.state` 都是 `pending`，测试没有为了让某条变 `succeeded` 而插入假 attempt。正式任务追溯到真实样本已由已接受包证明，本包不重跑。

## 3. 修改范围

- 新增测试 `apps/db-ops-api/src/metrics/config/status-separation.mysql.test.ts`。
- 新增证据 `docs/slide/development/MAX-238/status-separation-20261028.json` 与本文件。
- 未改 `status.ts`、`config/service.ts`、`policy/service.ts`、`policy/model.ts`、`policy/store.ts`、routes、registry、builtins、migration、前端，也未改已有测试和旧证据。
