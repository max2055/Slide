# MAX-238：一次性库上证明缺模板或凭据时有可恢复路径

2026-10-28。本包在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `recommendations` 读法、现有 `PolicyService.changeBinding` 和现有 `getInstancePassword`，证明验收句「缺模板或凭据时有可恢复路径」。只准备一个资源行：实例 1（`db_type=mysql`、`db_version=8.0.46`、`status=active` + `lifecycle_state=available`），口令列开始时留空；没有调用真实主机，没有调用 `activate`，没有调用 `trial`，没有调用 `databaseService.getConnection`，没有打开任何目标端口，没有使用 3306。

## 结论：两条全部成立

测试实际执行并通过（`Tests 1 passed (1)`，不是 `describe.skip` 跳过）。缺模板时后端拒绝没有留下半写，同一份推荐列表里那个真实 release 随后仍可发布；缺凭据时空白凭据读作空字符串，原 pin 与 revision 保留，补齐凭据后同一条绑定继续可用，无需重新发布。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `493f65681c341d6955c15ed011ef5ffdd74531fc` |
| 测试提交 | `c8e1232a7` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/recovery-path.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/recovery-path-20261028.json`（测试写出） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_recovery_path_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 资源行 | `instance:1`（`mysql` / `8.0.46`，`active` + `available`） |
| 凭据 | 开始时口令列为空；补齐时只在本测试进程内生成临时密钥，口令、密文、密钥都不打印、不写入证据 |
| 应用库 3306 | 未连接；本包不读写线上绑定或采集开关 |

运行命令：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/recovery-path.mysql.test.ts
```

## 2. 缺模板：拒绝后仍能选上一个真实模板

资源开始时未绑定：`state=unbound`、`published_revision=null`、绑定表 0 行。

- `recommendations` 对该资源类型返回 **8 个兼容的已发布 release**：`mysql-basic@1.0.0`、`mysql-representative@1.0.0`、`mysql-basic@1.1.0`、`mysql-diagnostics@1.0.0`、`mysql-diagnostics@1.1.0`、`mysql-custom-processlist-connections@1.0.0`、`mysql-custom-slow-query-snapshot@1.0.0`、`mysql-custom-existing-scalars@1.0.0`。pin 的 id、version、digest 全部从这次返回里读，没有写死推荐名字。
- 不带 `package` 去 publish（`expected_revision=0`）：被拒绝，错误 **`POLICY_PACKAGE_REQUIRED`（400）**。绑定行数仍是 **0**，审计行数不变，状态仍是 `unbound`——前一次拒绝没有留下半写。
- 再读一次 `recommendations`：刚才那个 release **仍在**返回里。
- 随后 publish 这个真实 pin（`mysql-basic@1.0.0`，digest `sha256:f35d9c93e1c63b080db59482018e0331e8500da8da5613fd8820988a12b57f1c`）：读回的 id、version、digest 与提交的 pin 一致，**revision 1**，绑定表 **1 行**。该 pin 与注册表里的同一 release digest 相同，不是本包新造的模板。

## 3. 缺凭据：原 pin 仍在，补齐后同一条绑定继续

| 读回 | 口令读数 | 绑定 pin | revision | 绑定行数 |
|---|---|---|---|---|
| 口令列为空 | `''`（空字符串，不是解密失败的 `null`） | `mysql-basic@1.0.0` | 1 | 1 |
| 只在该一次性库实例行写入 `encryptData` 结果后 | 非空字符串，并与本次进程内的临时口令一致 | `mysql-basic@1.0.0` | 1 | 1 |

- 空白凭据没有把 pin 清掉：补齐凭据前后 `binding.package` 与 `binding.revision` 逐字段相等。
- 补上凭据后读取成功，**不需要重新发布**才能留下这个 pin（没有第二次 publish，revision 仍是 1，绑定表仍 1 行）。
- 写入口令时只执行 `UPDATE database_instances SET password_encrypted = ? WHERE id = 1`，命中该一次性库；`getInstancePassword` 与 `encryptData` 使用同一把进程内临时密钥（进程原本没有 `ENCRYPTION_KEY` 时由测试用随机 32 字节在内存里生成）。
- 口令、密文与密钥都没有打印，也没有进入证据 JSON。

## 4. 产品代码未改

- 本包只新增测试与两份证据；`config/service.ts`、`policy/service.ts`、`policy/model.ts`、`resolver.ts`、`config/access.ts`、routes、registry、builtins、migration、前端均未改。内存与 MySQL 行为一致，不需要最小修改 `policy/store.ts`。
- `service.ts` 未改；**没有调用 `activate`**，没有改启用谓词，没有改「必要项失败阻止启用」判断，没有新增状态 blocker 枚举项（凭据不是 blocker）。
- **没有调用 `trial`**，没有调用 `databaseService.getConnection`，没有拨任何真实主机。
- **没有调用 3306**（一次性连接只指向 `127.0.0.1:13306`）；没有写 3306 业务表；没有改线上绑定或采集开关。
- **没有停写、复制、切换、回退、解绑**。
- 没有跑浏览器、worker 或全量测试；没有开子代理。

## 5. 验证命令与结果

```text
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/recovery-path.mysql.test.ts
Test Files  1 passed (1)
      Tests  1 passed (1)

pnpm exec tsc --noEmit
tsc_exit=0
```

一次性库已 `DROP DATABASE`；13306 的一次性容器已移除。本包不是生产发布、告警或整单验收；MAX-238 保持 **in_progress**。
