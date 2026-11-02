# MAX-238：一次性库上证明绑定路径

2026-10-28。本包在 `METRICS_TEST_MYSQL_PORT` 的一次性库上，用现有 `recommendations`、`PolicyService.changeBinding` 和绑定读回，证明验收句「全授权模板、多选、固定版本、兼容原因、取消和空绑定路径可用；不同对象不串配置」。只准备两个资源行：实例 1（`db_type=mysql`、`db_version=8.0.46`）与服务器 3（`os_type=kylin`，现有库存可识别为 linux）。口令列留空；未调用 `trialCurrent`、`activate` 或 worker，因此不会连接真实主机。未改 `config/service.ts`、`policy/service.ts`、`policy/model.ts`、routes、registry、builtins、migration、前端或 `config/access.ts`。

## 结论：七条全部成立

测试实际执行并通过（1 passed，不是 `describe.skip` 跳过）。当前模型每个资源仍只有一个 `package` pin；本包的「多选」是同一资源的授权列表里有多个已发布模板，可以分别预览，未发布的那个不生效，一次 publish 仍然只保存一个 pin。未把「一次保存多个模板」做成新 schema。

## 1. 运行边界

| 项 | 值 |
|---|---|
| 分支 | `agent/15coder1/max-238` |
| 基点 | `6b17fe57d826a4cedb986c27ab87ca964d5defa6` |
| 测试提交 | `173906599` |
| 测试文件 | `apps/db-ops-api/src/metrics/config/binding-path.mysql.test.ts` |
| 证据 JSON | `docs/slide/development/MAX-238/binding-path-20261028.json`（测试写出） |
| 一次性平台库 | `127.0.0.1:13306`（`METRICS_TEST_MYSQL_PORT`，一次性 `mysql:8.4` 容器），库名 `max238_binding_path_<pid>`，测试结束 `DROP DATABASE`，容器跑完移除 |
| 资源行 | `instance:1`（`mysql` / `8.0.46`，状态 `active`+`available`）、`server:3`（`os_type=kylin`，`collection_enabled=1`） |
| 凭据 | 两行口令/凭据列留空；未解密、未打印任何口令或密钥 |
| 应用库 3306 | 未复核（`SLIDE_DEBUG_ENV_FILE` 未设置）；未新建凭据，未连接 3306 |

运行命令：

```bash
cd apps/db-ops-api
METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/binding-path.mysql.test.ts
```

## 2. 逐条结果

### 2.1 全授权模板

- 实例 `recommendations` 返回 20 个 `instance` 类型条目，与注册表 `instance` 集合逐项相同（含 `mysql-basic@1.0.0/1.1.0/2.0.0`、`mysql-diagnostics@1.0.0/1.1.0`、`mysql-representative@1.0.0`、自定义 SQL 包等）；不含 `linux-host`、`if-mib-basic`。
- 服务器 `recommendations` 返回注册表 `server` 全部 3 项（`linux-basic@1.0.0`、`linux-host@1.0.0/1.1.0`），不含 `mysql-diagnostics`。
- `recommended` 由兼容性与覆盖计算得出，本次为 `mysql-basic`，其 `compatibility='compatible'`；测试只断言推荐项兼容且唯一，不要求固定名字。
- 每个条目的 `compatibility` 是非空字符串，`checks` 非空。
- 只有 `instance:1` 只读权限的 actor 读取另一个实例 `instance:2` 得到 `POLICY_FORBIDDEN` / 403；读取 `server:3` 同样 403；读取自己的 `instance:1` 成功。

### 2.2 多选

对实例的两个不同兼容模板分别预览：`mysql-diagnostics@1.1.0`、`mysql-basic@1.1.0`，两次 `changeBinding(..., false)` 都返回 `published=false` 且各自 pin 正确。两次预览之后 `metric_policy_bindings` 中 `instance:1` 行数为 0，`status.binding.state='unbound'`、`published_revision=null`（revision 仍为 0，随后以 `expected_revision: 0` 发布成功即为证）。

只 publish `mysql-diagnostics@1.1.0`：返回 `published=true`、revision 1；读回 binding 的 `package` 就是该 pin，binding JSON 中不出现另一个模板 `mysql-basic` 的 id（`binding_contains_other=false`）。

### 2.3 固定版本

- publish 读回的 `id`、`version`、`digest` 与提交的 pin 完全一致：`mysql-diagnostics` / `1.1.0` / `sha256:785a03fc…7250f`。
- 同名另一版本 `mysql-diagnostics@1.0.0` 已安装且 digest 为 `sha256:55bb3cf6…3642`，读回版本仍是 `1.1.0`，未被当成已选版本。
- 把 digest 改成 `sha256:bbbb…bbbb`（64 位十六进制）再 publish：请求被拒绝，错误 `PACKAGE_PIN`；revision 前后都是 1（表内 payload 复核）。

### 2.4 兼容原因

把 `linux-host@1.1.0` 的 pin 发到实例上 publish，请求被拒绝，错误码 `POLICY_PACKAGE_RESOURCE`（400，属于允许的 `POLICY_PACKAGE_RESOURCE` / `PACKAGE_INCOMPATIBLE` 之一）；实例 binding 不变（仍为 `mysql-diagnostics@1.1.0`，revision 1）。

recommendations 中的不兼容项共 12 个（如 `mysql-basic@2.0.0`：`db.version` 只支持 `9.6`；其余引擎的 representative/diagnostics 包：`db.engine` 不支持），每一项 `checks` 非空且含 `status='unsupported'`，`compatibility` 非空。

注册表没有草稿版本：证据写 `draft_release_fixture: absent`，未造草稿类型。

### 2.5 取消

`mysql-basic@1.1.0` 预览成功返回（`published=false`、pin 正确）后不调用 publish：`status.binding.state='unbound'`、`published_revision=null`，`metric_policy_bindings` 行数为 0。取消选择本身不产生新绑定。

### 2.6 空绑定

首次 publish 前，`status` 读回 `state='unbound'`、`published_revision` 为空，绑定表 0 行。首次 publish 不带 `package` 被拒绝，错误码 `POLICY_PACKAGE_REQUIRED`（400）；之后资源仍 unbound、绑定表仍 0 行。

### 2.7 不同对象不串配置

实例 publish `mysql-diagnostics@1.1.0`，服务器 publish `linux-host@1.1.0`（`expected_revision: 0`，revision 0 → 1）。再读两边：

| 资源 | package | version | digest | revision |
|---|---|---|---|---|
| `instance:1` | `mysql-diagnostics` | `1.1.0` | `sha256:785a03fc…7250f` | 1 |
| `server:3` | `linux-host` | `1.1.0` | `sha256:b5797402…8d2f` | 1 |

`instance:1` 的 binding JSON 不含 `linux-host`，`server:3` 的 binding JSON 不含 `mysql-diagnostics`；两边的 `resource` 各自指向自己。

## 3. 产品代码未改，必需指标名单本次未定

- `git diff 6b17fe57d..173906599` 只新增测试文件；本证据提交只新增 JSON 与本文。`config/service.ts`、`policy/service.ts`、`policy/model.ts`、routes、registry、builtins、migration、前端、`config/access.ts` 都未改；没有为了通过而改产品。
- **必需指标名单仍未定**：本包没有加必需指标名单，也没有改 `activate`。
- **没有调用 `activate`**（也没有 `trialCurrent`、worker、浏览器或全量测试）；未测停写、复制、切换、回退、解绑或真实 SNMP。
- 应用库未复核：`SLIDE_DEBUG_ENV_FILE` 未设置。一次性库已 `DROP DATABASE`，13306 容器已移除、端口无监听。

## 4. 验证命令与结果

```text
pnpm exec vitest run src/metrics/config/binding-path.mysql.test.ts
Test Files  1 passed (1)
      Tests  1 passed (1)

pnpm exec tsc --noEmit
tsc_exit=0
```

本包不是生产发布、告警或整单验收；MAX-238 保持 **in_progress**。
