# MAX-238：一次性库上证明应用失败维持上一份已应用的 revision

2026-10-28。本包补验收句「应用失败维持上一份有效配置」。现有产品把「上一份有效配置」记成已被 `reportApplied(..., 'applied')` 确认的 `binding.applied_revision`。这里不新造历史快照，只用现有 `PolicyService.changeBinding`、现有 `MysqlPolicyStore.reportApplied` 和现有 `MetricConfigurationService.status`，在一次性库上证明：新的发布把 `application` 重置为 `pending` 并保留旧的 `applied_revision`；随后把这次新 revision 报成 `failed`，`applied_revision` 仍停在先前那一份，没有被换成失败版。

## 结论：三步都成立

在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，测试实际执行并通过（1 passed），三步 `status()` 的实际键值如下。

| 步 | 动作 | `published_revision` | `application` | `applied_revision` | 本步要求的 blocker | `effective_enabled.policy_enabled` | `collection.state` |
|---|---|---|---|---|---|---|---|
| 1 | 发布 `enabled` pin（revision 1），`reportApplied(...,'applied')` | 1 | `applied` | 1 | — | `true` | `pending` |
| 2 | 同 pin 再发布（revision 2，`overrides.enabled='disable'`），不报应用 | 2 | `pending` | 1 | `APPLICATION_PENDING` | `false` | `disabled` |
| 3 | 对 revision 2 `reportApplied(...,'failed')` | 2 | `failed` | 1 | `APPLICATION_FAILED` | `false` | `disabled` |

- **第 1 步**：`application='applied'`，`applied_revision = published_revision = 1`，`resolved.settings.enabled` 为 `true`。这一份 revision 与 pin（`mysql-basic@1.0.0`，digest `sha256:f35d9c93…`）记为本包的「上一份有效确认」。
- **第 2 步**：新发布的 `published_revision` 推进到 2，但 `application` 回到 `pending`，`applied_revision` 仍是 1；`APPLICATION_PENDING` 在 blockers 里；`policy_enabled=false`。pending 的新发布没有把 `applied_revision` 推进到自己。
- **第 3 步**：`application='failed'`、`APPLICATION_FAILED` 在 blockers 里，`published_revision` 仍是 2，`applied_revision` 仍是 1。失败没有把上一份已应用的 revision 换成失败的这一版。
- `binding.package` 三步都仍是第 1 步读到的同一个 pin，发布新版没有换掉 pin 身份。
- 三步 `collection.state` 都不是 `succeeded`（第 1 步 `pending`，第 2、3 步因策略被 disable 而为 `disabled`），没有借插入的 attempt 伪造正式成功。

`POLICY_COLLECTION_DISABLED`、`CAPABILITY_UNKNOWN`、`AWAITING_SAMPLE` 是现有状态的如实读数，不是本条验收的失败项；测试只断言本条要求出现的 blocker 存在。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `77dcbce5ad73013d7f4bca9b78a80c3413e758d6` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/apply-failure-retains.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/apply-failure-retains-20261028.json`（测试写出，`run.head` 记录执行时 HEAD，即基点） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_apply_failure_<pid>`，测试结束 `DROP DATABASE`，容器跑完删除 |
| 资源行 | 只用 `instance:1`，一次性库里 `status='active'` + `lifecycle_state='available'`；不连任何已纳管目标 |
| pin | 从当次 `recommendations` 的兼容已发布 release 读出（本次 `mysql-basic@1.0.0`），未写死推荐名字 |
| 应用库 | 未连接；未对 3306 发语句 |
| 未调用 | `activate`、worker、trial、任何采集；未插入 attempt / observation / publication |

运行命令：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/apply-failure-retains.mysql.test.ts
```

验证结果：`Test Files 1 passed (1)`、`Tests 1 passed (1)`，测试实际执行（未跳过）；`pnpm exec tsc --noEmit` 退出码 0。

## 2. 没有伪造正式成功

| 表 | 测试前 | 测试后 |
|---|---|---|
| `metric_observations` | 0 | 0 |
| `metric_publications` | 0 | 0 |
| `metric_attempts` | 0 | 0 |

测试没有为了让任何一条变 `succeeded` 而插入 attempt、观测或发布。

## 3. 修改范围

- 新增测试 `apps/db-ops-api/src/metrics/config/apply-failure-retains.mysql.test.ts`。
- 新增证据 `docs/slide/development/MAX-238/apply-failure-retains-20261028.json` 与本文件。
- 未改 `status.ts`、`config/service.ts`、`policy/service.ts`、`policy/model.ts`、`policy/store.ts`、routes、registry、builtins、migration、前端，也未改已有测试和旧证据。
