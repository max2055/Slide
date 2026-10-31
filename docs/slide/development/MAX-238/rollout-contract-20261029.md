# MAX-238：把 rollout 测试夹具改回真实生产者写出的行

2026-10-29。本包处理旧 CI run 40732529727 的两个分片失败：分片 6 的 job 122972501816 在 `portfolio.mysql.test.ts` 报 1 项 `BINDING_PAYLOAD_LEGACY_INVALID`，分片 8 的 job 122972501786 在 `coordinator.mysql.test.ts` 报 3 项 `BINDING_PAYLOAD_EFFECTIVE_INVALID`。两者都来自 MAX238 严格绑定读者触达后的关联门禁。未改生产 codec、路由、调度器、worker、迁移或前端；未重跑 CI，未删除或跳过断言。

## 结论：测试写的是不存在的存储形态，不是兼容缺陷

在一次性库上先用真实发布者证明：`PolicyService.changeBinding` → `resolvePolicy` → `MysqlPolicyStore.saveBinding` 写出的完整 `Published`（键为 `binding` / `resolved` / `published_at` / `application`）被同一个 `readLegacyPublished` / `decodeBindingPayload` 接受；两个测试原来手写的稀疏值（只有 `binding`、`application`，`resolved` 只有 `{settings:{enabled:true}}`，没有 `published_at`）被拒。真实作者产物没有被拒，因此这是测试夹具问题，不是 codec 兼容缺陷；生产源码未动。

| 阶段 | 结果 |
|---|---|
| 修复前（同一一次性库，`METRICS_TEST_MYSQL_PORT=13306`） | 2 failed；4 failed / 1 passed：coordinator 3 × `EFFECTIVE_INVALID`，portfolio 1 × `LEGACY_INVALID` |
| 修复后（同一库，同一命令） | 3 files passed；6 passed（coordinator 3、portfolio 2、contract 1） |

## 改动

- `apps/db-ops-api/src/metrics/rollout/coordinator.mysql.test.ts`：绑定行改由 `resolvePolicy` 产出的完整 `Published` 经 `MysqlPolicyStore.saveBinding` 写入；观察值的 `versions.package_id/package_version` 改用真实 pin（`mysql-basic@1.0.0`）；三条原失败断言未动。
- `apps/db-ops-api/src/metrics/rollout/portfolio.mysql.test.ts`：三个资源的绑定行同样由真实 resolver 产出并经真实 store 写入，再用既有的 `reportApplied` 走应用状态；`metric_rollout` / `metric_rollout_resources` 行与原测试一致。
- `apps/db-ops-api/src/metrics/rollout/legacy-published-contract.mysql.test.ts`（新增）：在一次性库上真实发布、真实应用，证明 legacy 无 envelope 行、显式 `package-v1` 载体、applied/effective 快照三者可由同一读者读回；损坏、拼接、未知 envelope 与模板行仍然按稳定错误码拒绝。

## 契约证据（`rollout-contract-20261029.json`）

| 场景 | 结果 |
|---|---|
| 真实发布后的行键 | `binding`、`resolved`、`published_at`、`application`；无 `envelope`；`readLegacyPublished` 与发布返回值相等 |
| 真实 `reportApplied(1)` 后 | `effective.source='package'`、`revision=1`、`resolution_identity=null`，`plan.binding.config_revision=1`，settings 与顶层 `resolved.settings` 一致 |
| 再发布 revision 2 | `application={status:'pending', applied_revision:1}`；`effective=null`，`effective_missing=true`（不把上一 revision 的快照冒充新 revision） |
| 显式 `package-v1` | `source='package'`；binding 与 effective 与无 envelope 行相等 |
| 旧稀疏行 / settings 被改 / 外来 plan / revision 错位 | `LEGACY_INVALID` / `EFFECTIVE_INVALID` / `EFFECTIVE_INVALID` / `EFFECTIVE_INVALID` |
| 未知 envelope / 模板 envelope 带 package / 非法 JSON | `UNKNOWN_ENVELOPE` / `AMBIGUOUS_SOURCE` / `INVALID_JSON` |

## 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 实现提交 | `f562cc3b0` |
| 一次性库 | `max238_legacy_contract_*` / `max85_coordinator_*` / `max85_portfolio_*`，均在 afterAll 删除 |
| 容器 | `max238-rollout-1793230293-9666`（ID `e5f67a7b…e9396e87`，owner `15coder1`，nonce `1793230293-9666`），端口 `127.0.0.1:13306`，MySQL 8.4.10 |
| 未做 | 未写 3306、未启动 collector/worker、未挂路由、未调用真实目标、未改生产 codec |

## 回归

- `src/metrics/rollout` + `src/metrics/bindings` + `src/metrics/policy`：425 passed、1 skipped、1 failed；唯一失败是 `policy/store.mysql.test.ts` 首个迁移用例在并行负载下 5s 超时，单独重跑 9 passed，与本包改动无关。
- `npx tsc --noEmit`（`apps/db-ops-api`）：无输出。
- 源码未改生产文件，故复用既有 contracts 结论；未重复浏览器/幂等全量。

## 剩余

- PR 567 需从干净已审 head `74115f22f` 追加本包提交并更新描述；本记录提交时尚在追加流程中。
- 本包只收敛这两处测试门禁，MAX238 整单仍 `in_progress`；真实采集、history/event 与整单 UI 验收不在本包。
