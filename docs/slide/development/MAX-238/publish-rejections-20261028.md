# MAX-238：一次性库上证明发布被拒绝时 revision 不动，两个对象不串配置

2026-10-28。本包补验收句「冲突、并发 revision 更新、过期测试、权限变化均被后端拒绝，失败保留原有效版本」里还没单独收过的输入，并补「不同对象不串配置」。只用现有 `PolicyService.changeBinding` 和现有 `MetricConfigurationService.status`，在一次性库上证明：过期 revision、只读演员、过期候选指纹、不兼容的已发布 release 四种发布都被后端拒绝，且已发布 revision 与 pin 不动；资源 2 的发布不改变资源 1 的绑定与启用覆盖。未调用 `activate` 或 `reportApplied`，未启动 worker，未新造幂等应用键。

## 结论：五步与跨资源一步全部成立

在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，测试实际执行并通过（1 passed）。第 1 步读到的兼容已发布 pin 是 `mysql-basic@1.0.0`（digest `sha256:f35d9c93…`），revision 为 1；此后所有拒绝都停在这份 revision 与 pin 上。

| 步 | 动作（`changeBinding`） | 结果 | 拒绝后的 `published_revision` | 拒绝后的 `binding.package` | `application` | `effective_enabled.policy_enabled` |
|---|---|---|---|---|---|---|
| 1 | 资源 1 发布兼容 `enabled` pin，`expected_revision=0` | 成功，revision 1 | 1 | `mysql-basic@1.0.0` | `pending` | `true` |
| 2 | 同一 pin 再发布，`expected_revision=0` | `POLICY_REVISION_CONFLICT`（409） | 1 | `mysql-basic@1.0.0` | `pending` | `true` |
| 3 | 只读演员发布，`expected_revision=1` | `POLICY_FORBIDDEN`（403），审计行 1 → 1 | 1 | `mysql-basic@1.0.0` | `pending` | `true` |
| 4 | 管理演员发布，`expected_revision=1`，候选指纹传不同字符串 | `POLICY_REVISION_CONFLICT`（409） | 1 | `mysql-basic@1.0.0` | `pending` | `true` |
| 5 | 切换到 `compatibility='incompatible'` 的已发布 release（`mysql-basic@2.0.0`），`expected_revision=1` | `PACKAGE_INCOMPATIBLE`（422） | 1 | `mysql-basic@1.0.0` | `pending` | `true` |

- **第 1 步**：发布后 `resolved.settings.enabled` 为 `true`，`status()` 读到 `published_revision=1` 与同一 pin。`application='pending'` 是发布尚未应用确认的现有读数，不是本包失败。
- **第 2 步**：`expected_revision=0` 已被消费，后端在 revision CAS 处拒绝；`published_revision` 没有从 1 前进到 2，pin 未变。
- **第 3 步**：只读演员沿用现有只读形状（`permissions` 只有 `instance:view`，`instanceScopes[1]='read-only'`），在 `assertAccess` 被拒绝；对资源 1 的 `metric_policy_audit` 行数前后都是 1，这次拒绝没有新增审计行。
- **第 4 步**：revision 是当前的 1，但传入的候选指纹与当次实际指纹不同，后端在候选指纹比较处拒绝，`published_revision` 与 pin 不动。
- **第 5 步**：当次 `recommendations` 里第一份非 `compatible` 的已发布 release 是 `mysql-basic@2.0.0`（`incompatible`），切换到它被 `PACKAGE_INCOMPATIBLE` 拒绝；`published_revision` 仍是 1，pin 仍是第 1 步那一份。实际错误码已写入证据 JSON，未按预期改产品代码。
- **跨资源**：资源 2 插入独立实例行后，用同一兼容 pin 发布并带 `overrides.enabled='disable'`，其 `published_revision=1`、`binding.package` 为同一 pin、`effective_enabled.policy_enabled=false`（`source='resource'`）。随后资源 1 的 `status()` 仍是 `published_revision=1`、同一 pin、`policy_enabled=true`，资源 2 的 disable 覆盖没有串到资源 1。

`CAPABILITY_UNKNOWN`、`AWAITING_SAMPLE`、`APPLICATION_PENDING` 是现有状态的如实读数，不是本条验收的失败项；测试只断言本条要求的行为。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `86101d6dafba7b8d60297d970f5171807d29fc26` |
| 测试提交 | `19aa0a73c` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/publish-rejections.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/publish-rejections-20261028.json`（测试写出，`run.head` 记录执行时 HEAD，即基点） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_publish_rejections_<pid>`，测试结束 `DROP DATABASE`，容器跑完删除 |
| 资源行 | 只用 `instance:1` 与 `instance:2`，一次性库里 `status='active'` + `lifecycle_state='available'`；不连任何已纳管目标 |
| pin | 从当次 `recommendations` 的兼容已发布 release 读出（本次 `mysql-basic@1.0.0`），未写死推荐名字 |
| 应用库 | 未连接；未对 3306 发语句 |
| 未调用 | `activate`、`reportApplied`、worker、trial、任何采集；未插入 attempt / observation / publication |

运行命令：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/publish-rejections.mysql.test.ts
```

验证结果：`Test Files 1 passed (1)`、`Tests 1 passed (1)`，测试实际执行（未跳过）；`pnpm exec tsc --noEmit` 退出码 0。

## 2. 修改范围

- 新增测试 `apps/db-ops-api/src/metrics/config/publish-rejections.mysql.test.ts`。
- 新增证据 `docs/slide/development/MAX-238/publish-rejections-20261028.json` 与本文件。
- 未改 `status.ts`、`config/service.ts`、`policy/service.ts`、`policy/store.ts`、routes、registry、builtins、migration、前端，也未改已有测试和旧证据；未做幂等应用键，未改 `request_id` 语义。
