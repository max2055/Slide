# MAX-238：一次性库上证明冲突与 revision 拒绝

2026-10-28。本包在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `PolicyService.changeBinding` 与现有试用重校验，证明验收句「冲突、并发 revision 更新、过期测试、权限变化均被后端拒绝，失败保留原有效版本」。只准备一个资源行：实例 1（`db_type=mysql`、`db_version=8.0.46`），口令列留空；采集 resolve 直接抛错，测试没有调用任何真实主机，没有使用 3306。未改 `config/service.ts`、`policy/service.ts`、`policy/model.ts`、`policy/store.ts`、routes、registry、builtins、migration、前端或 `config/access.ts`；`activate` 的启用谓词未改。

## 结论：四条全部成立

测试实际执行并通过（`Tests 1 passed (1)`，不是 `describe.skip` 跳过）。基线版本 `mysql-basic@1.1.0`，revision 1；四条都以该版（或其后已成功提交的版本）为「原有效版本」，失败没有把 revision 推进一版、也没有留下半写。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `77671acfc3689fa388d55e247640a2dbfa9da2b3` |
| 测试提交 | `5dd57cd08542f47326c90fd638dadfec57886f0f` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/conflict-cas.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/conflict-cas-20261028.json`（测试写出） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_conflict_cas_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 连接 | 两个独立连接池（`pool`、`pool2`），各自独立 admission；并发发布与「另一个连接推进 revision」都走第二个连接 |
| 资源行 | `instance:1`（`mysql` / `8.0.46`，状态 `active`+`available`） |
| 凭据 | 该行口令列留空；未解密、未打印任何口令或密钥 |
| 应用库 3306 | 未连接、未复核；本包不读写线上绑定或采集开关 |

运行命令：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/conflict-cas.mysql.test.ts
```

## 2. 逐条结果

### 2.1 冲突

把 `linux-host@1.1.0`（服务器模板，digest `sha256:b5797402…8d2f`）发到实例上 publish：请求被拒绝，错误 `POLICY_PACKAGE_RESOURCE`（400，属于允许的 `POLICY_PACKAGE_RESOURCE` / `PACKAGE_INCOMPATIBLE` 之一）。前后 revision 都是 1，读回 pin 仍是 `mysql-basic@1.1.0`，绑定表 1 行。

### 2.2 并发 revision

两个独立连接（`pool`、`pool2`）同时用 `expected_revision=1` publish 两个不同的兼容 pin：`mysql-diagnostics@1.1.0` 与 `mysql-diagnostics@1.0.0`。

- 恰好一个成功：本次 `pool` 胜出，revision 1 → 2，pin 为 `mysql-diagnostics@1.1.0`。
- 另一个被 `POLICY_REVISION_CONFLICT` / 409 拒绝。
- 读回只有胜者的 pin 和 revision 2；绑定表 1 行，审计只增加胜者的 1 条（`audit_delta=1`），败者没有留下半写。

胜负由谁先取得 `metric_policy_lock` 行锁决定，测试不假设固定连接获胜。

### 2.3 过期测试

当前版本 `mysql-diagnostics@1.1.0`、revision 2。

1. 对当前 pin 做 preview / trial（`overrides.enabled='disable'`，因此不解析 transport、不连接任何主机），记下候选指纹。
2. 试用重校验窗口里，另一个连接（`pool2`）用 `expected_revision=2` 推进一版（`interval_ms=45000`），revision 2 → 3。
3. `activate` 的 publish 用旧的 `expected_revision=2` → `POLICY_REVISION_CONFLICT` / 409。
4. 再以匹配的 revision 3 但旧候选指纹 publish → 同样 `POLICY_REVISION_CONFLICT` / 409。

试用本身 `persisted=false`、`decision=disabled`、`attempts=0`、`samples=0`；`metric_observations(stage=normalized)`、`alerts`、`alert_events`、`notification_records`、`metric_publications`、`metric_alert_state`/`metric_alert_transitions` 在试用前后都是 0，试用不写正式历史、不写告警。

失败后留下的仍是最后一次已成功提交的版本：revision 3、pin `mysql-diagnostics@1.1.0`、覆盖 `interval_ms=45000`，而不是旧候选（`enabled=disable`）。审计相对该窗口只增加推进那 1 条。

说明：本条的试用以 `enabled='disable'` 短路采集，未执行真实远程读取；本包证明的是「试用重校验 + 发布 CAS」这一句，不冒充真实采集，也不替代已接受的只读试采证据。

### 2.4 权限变化

- 无管理权限的 actor（`permissions=['instance:view']`、`instanceScopes={1:'read-only'}`）直接 publish → `POLICY_FORBIDDEN` / 403。
- 试用路径上，第二次 `currentActor` 检查改为空权限 actor：`activate` 在试用预览处被 `POLICY_FORBIDDEN` / 403 拒绝（`activation_checks=2`）。
- 两次 rejection 后 revision 仍为 3，pin 不变，绑定表 1 行，审计增量为 0。

## 3. 产品代码未改

- 本包只新增测试与两份证据；`config/service.ts`（`00b5aaf9…`）、`policy/service.ts`（`56ba0746…`）、`policy/model.ts`（`b1675afa…`）、`config/access.ts`（`4b520469…`）的 blob 与上一包一致；`policy/store.ts` 未改（没有出现「内存通过、一次性 MySQL 失败」的差异，因此不需要最小修复）。
- `service.ts` 未改。`activate` 的「必要项失败阻止启用」判断未改，没有为了通过去改启用谓词。
- **必需指标名单仍未定**，本包没有新增名单。
- 没有停写、复制、切换、回退或解绑；没有写 3306 业务表；没有改线上绑定或采集开关；没有跑浏览器、worker 或全量测试。

## 4. 验证命令与结果

```text
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/conflict-cas.mysql.test.ts
Test Files  1 passed (1)
      Tests  1 passed (1)

pnpm exec tsc --noEmit
tsc_exit=0
```

一次性库已 `DROP DATABASE`；13306 的一次性容器已移除，端口无监听。本包不是生产发布、告警或整单验收；MAX-238 保持 **in_progress**。
