# MAX-238 应用幂等键：实现与一次性库验证

分支 `agent/15coder1/max-238`；基点 `c14b06a0033cde3972a1722014921afc691c3c75`；实现提交 `57cea5013663e183bc3555f440cf92dad03b2913`；测试与证据提交见本条交付评论。本包是 PUBLISH-REJECTIONS 之后的新实现包，不重跑已接受的包。

## 实现范围

原范围中「幂等键绑定资源、目标 revision 和 digest」此前缺实现，本包补齐客户端 operation key，并绑定到既有 configuration → policy 事务与 MySQL 持久化：

- 请求：`POST /api/metrics/config/resources/{type}/{id}/activate`（以及 `POST /api/metrics/policy/resources/{type}/{id}/publish`）的请求体新增可选 `operation_key`（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`）。不带该字段的旧调用行为不变。
- 绑定：key 绑定「授权资源、目标 revision（`expected_revision + 1`）、规范化配置摘要」。摘要沿用既有 `candidateFingerprint` 的规范形式，取 `sha256:` 前缀的 64 位十六进制，即试采所验证的同一份配置。
- 记录：新增迁移 `133_metric_policy_apply_operations.sql`（`metric_policy_apply_operations`）。该表只是客户端意图日志，不是第二份策略/配置事实源；binding、revision 与 audit 仍在原事务、原表中。日志行与 binding 更新、审计插入在同一事务提交。
- 重放：同一 key + 同一意图再次提交时，在序列化的 policy 事务内读到已记录行，重新校验资源、目标 revision 与摘要后返回**记录的发布结果**（不改 revision、不写审计、不重复发布）。
- 冲突：同一 key 用于其他资源、其他目标 revision 或其他配置，返回 `POLICY_OPERATION_CONFLICT`（409）；已发布版本与审计均不变。
- 并发：policy 事务由既有 `metric_policy_lock` 串行化，重复并发请求的后者读到已提交日志行并重放，只产生一份 revision 与一条审计。
- 重启：日志行持久在 MySQL，新建 store/service 实例后仍可重放。
- 权限：重放前重新执行 `assertAccess`（管理权限 + 资源存在性）；`activate` 在试采前先做重放判定，已提交意图不再产生第二次试采 IO。权限被撤销时返回 `POLICY_FORBIDDEN`。
- 未知结果查询：新增 `GET /api/metrics/config/resources/{type}/{id}/operations/{key}`。该读取与发布共用同一 policy 锁，因此 `absent` 表示没有该 key 的发布在途，可安全重试；其他资源的 key 一律报 `absent`，不泄露。
- 契约：`MetricBindingChange` 增加可选 `operation_key`，新增 `MetricOperationState` 与对应路径；已运行 `pnpm contracts:generate` 并 `pnpm contracts:check` 通过。前端 `metric-configuration` 在发布时按意图生成 key，同一意图（相同请求体）在超时/失败重试时复用，成功或配置改变后换新。

未改 `activate` 的启用谓词、试采成功判定、必要指标决策、调度/事件/历史写入、解绑或切换逻辑；未调用 `reportApplied`，未启动 worker，未操作 3306。

## 验证

一次性 `mysql:8.4` 容器（`127.0.0.1:13306`，库名带进程号，结束 `DROP DATABASE`，容器已删除）。`METRICS_TEST_MYSQL_PORT` 未设置时整组用例跳过，不算通过。

命令与结果：

- `METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/apply-idempotency.mysql.test.ts`：`Test Files 1 passed (1)`、`Tests 8 passed (8)`，实际执行未跳过。
- `apps/db-ops-api` 下 `pnpm exec tsc --noEmit`：退出码 0。
- `METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/policy src/metrics/config`：27 个文件通过、10 个跳过（非 MySQL/浏览器条件用例）。
- `pnpm --filter slide-frontend typecheck`、`pnpm --filter slide-frontend build`、前端 `vitest run`（148 文件 / 1319 用例）全部通过。
- `pnpm contracts:check` 通过。

## 实证（一次性库）

| 步骤 | 结果 |
|---|---|
| 资源 1 以 `apply-intent-1` 发布兼容 pin，`expected_revision=0` | revision 1；试采摘要 `sha256:3d13046c…` 与日志行 `configuration_digest` 相同；审计 1 条 |
| 同一 key、同一意图再次发布 | 返回记录的发布（`published_at` 相同），binding payload 不变，审计仍 1，日志仍 1 |
| 同一 key 换资源 / 换目标 revision / 换配置 | 三次均 `POLICY_OPERATION_CONFLICT`(409)，binding、审计、日志行数不变 |
| 资源 2 并发两次同 key | 两次均 revision 1、`published_at` 相同，审计 1，日志 1 |
| 新建 store/service 后重放 + 查询 | 重放 revision 1 且无新审计；`operations/apply-intent-1` 为 `committed`，未用 key 为 `absent` |
| 只读演员重放 / `activate` 重放 / 无 scope 查询 | 均 `POLICY_FORBIDDEN`(403)，binding 与审计不变 |
| 过期 revision 的带 key 发布 | `POLICY_REVISION_CONFLICT`(409)，不写日志行，查询为 `absent` |
| 不带 key 的旧调用 | 正常发布 revision 2（`policy_enabled=false`），审计 +1，不写日志；过期 revision 仍 409 |

原始键值见 `apply-idempotency-20261028.json`。`run.head` 是执行测试时的提交 `57cea5013`。

## 边界与未完成

- 只在一次性库证明；未对 3306 或线上库执行，未部署，未做真实采集与浏览器验收。
- 幂等键只覆盖配置发布/应用启用这一意图；正式采集任务受理（`workflow_jobs`）、`reportApplied` 应用回执与解绑仍未接入同一 key，属原范围其他句子。
- 摘要对 `candidateFingerprint`（含 applicability 与能力证据推导结果）取哈希：若两次请求之间资源清单或能力有效性发生实质变化，重放会判为 `POLICY_OPERATION_CONFLICT` 而不是重放旧结果（安全但非静默成功），本次未单独构造该场景。
- 全量 `src/metrics` 套件并行运行时，`rollout/coordinator.mysql.test.ts` 与 `rollout/portfolio.mysql.test.ts` 的 4 个用例因 `BINDING_PAYLOAD_LEGACY_INVALID` 失败；已在基点 `c14b06a00` 的独立 worktree 上复现同样失败，属既有问题，与本包无关。同批全量运行中其余失败用例（`config/binding-path`、`config/flow`、`policy/store`、`snmp`、`database`、`storage`）逐个单跑均通过，是单容器并行负载导致的抖动。
- MAX-238 整体仍未完成（解绑预览/历史授权、可选项排除、正式采集追溯的未收句子等），保持 `in_progress`；本包不接受整单完成。
