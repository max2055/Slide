# MAX238-APPLY-IDEMPOTENCY-R3：公开入口授权闭环与 fixture 所有权清理

本包修正 R2 `17621094f` 未接受的两项缺陷：公开 policy 路由的锁后实时授权，以及浏览器 fixture 的越界容器清理。整单 MAX238/MAX235 仍未完成：真实目标、正式 history/event 链、消费者依赖与生产发布都不在本包放行。

- 任务分支：`agent/15coder1/max-238`（只在 `17621094f` 上追加，未切换/重置/改写已接受提交）
- 基点：`17621094f2a44ddd11dc943f0381b7d1b25e797a`（R2 交付，未接受）
- 实现提交：`7fced4d7b`；测试与证据提交：本文件所在提交（新 HEAD 见交付评论）
- 未改：激活谓词、必要项名单、可选指标排除策略、发布结果格式、调度器、worker、migration、其他前端组件

## 1. 公开 policy 入口的锁后实时授权

R2 只给 config 的生产入口接线了 `actorContextService.revalidateActor`；`registerMetricPolicyRoutes` 仍使用请求到达时的 actor 快照。真实 `POST /api/metrics/policy/resources/:type/:id/publish` 接受 `operation_key`，因此带 key 的 committed replay 可从该公开入口绕过锁等待期间的撤权。R2 文档中“旧无 key 路由不属于本协议”的表述不成立，本包更正。

- `registerMetricPolicyRoutes` 新增 `reload` 参数，默认即生产实现 `actor => actorContextService.revalidateActor(actor, actor.requestId)`（与 config 路由一致）；`server.ts` 不传参数即接入真实会话源。
- 每个公开入口在进入串行事务、取得连接并等到 policy 行锁之后，先重读实时主体再授权：
  - `GET /resources/:type/:id`（binding）、`/effective`、`/audit`
  - `POST /resources/:type/:id/preview`、`/publish`（含 keyed replay 与新 keyed mutation）
  - `GET /groups`、`/groups/:id`、`/groups/:id/access`、`POST /groups/:id/preview|publish`
- `PolicyService` 的 `binding/audits/effective/group/groups/groupPermissions/changeGroup` 接受可选 `check`；无 `check` 的调用方（内部 reader、bulk 预览）保持原行为，不新增身份查询。
- 会话撤销抛出的 `ActorAuthenticationError` 映射为 401 `POLICY_AUTH_REQUIRED`（与 config 路由一致），不再落入 500；资源/管理权限撤销仍为 403 `POLICY_FORBIDDEN`。
- 授权检查发生在读取 binding、审计、journal 和任何写入之前；拒绝不增加 binding/revision/audit/publication/journal，也不发起远程试采。
- 身份查询由独立连接读取用户/权限表，policy 行锁在 `metric_policy_lock` 单行上；`withPolicyAdmission` 仍在连接签出前排队，避免等待者占用锁持有者需要的连接。

config 入口（activate、keyed intent 查询）在 R2 已接入；本包用真实 HTTP 复验其在撤销后的拒绝。

## 2. fixture 只清理自己创建的资源

`frontend/e2e/max238-real-api.sh` 此前按 `name=max238-e2e-` 前缀批量删除，`max238-idempotency-real-api.spec.ts` 的 `afterAll` 同样删除全部同前缀容器；并行工作树的有效容器也会被删。

- 每次运行生成唯一 nonce，容器名为 `max238-e2e-<nonce>`，并写入标签 `slide.max238.owner=<nonce>`；启动日志记录 nonce、容器名、PID、cwd、一次性 MySQL 端口与 API 端口。
- 清理只针对本次运行的确切句柄，且删除前用 `docker inspect` 校验标签等于本次 nonce；标签不符时拒绝并返回非零。删除后再 `inspect` 确认已消失，失败打印 `FAILED` 并置非零退出，不假报成功。
- 启动时若同名确切句柄已存在，只记录并退出，不删除；其他 `max238-e2e-` 残留仅以确切名称和 owner 记录，绝不按前缀清扫。
- `MAX238_E2E_CONTAINER`/`MAX238_E2E_NONCE` 传给 API fixture；其 `shutdown` 也只删除标签匹配的确切容器。
- 浏览器测试的 `afterAll` 从 `/__test/handle` 取得本次句柄与 nonce，再调用脚本的 `--cleanup <name> <nonce>`，与启动器使用同一校验逻辑；API 已不可达时不扫描前缀。
- 只使用本运行的一次性容器（`127.0.0.1::3306` 随机端口，脚本显式拒绝 3306），schema 由测试自建并 DROP。

## 3. 验证

一次性 MySQL：本运行专属容器 `mysql:8.4`，`127.0.0.1` 随机端口（本证据为 54383，非 3306），测试自建 schema 并在结束 DROP；不连业务库、不连目标。

| 检查 | 结果 |
| --- | --- |
| `vitest run src/metrics/policy/routes.test.ts` | 13 passed（10 原有 + 3 锁后授权） |
| `vitest run src/metrics/config/apply-idempotency-r3.mysql.test.ts` | 4 passed |
| `METRICS_TEST_MYSQL_PORT=54383 vitest run src/metrics/config src/metrics/policy --maxWorkers=3` | 32 文件 / 212 passed，10 文件 / 12 skipped |
| `vitest run src/metrics/bulk src/metrics/rollout` | 33 passed / 36 skipped |
| API `tsc --noEmit` | 退出 0 |
| `contracts:check` | 退出 0（公开契约未变） |
| 前端 `tsc --noEmit` | 退出 0 |
| Playwright MAX-238（chromium，真实组件→Vite 代理→真实 Fastify→一次性 MySQL journal） | 4 passed |

### 公开入口撤权（一次性 MySQL、真实迁移、真实路由、真实 journal）

- 已提交 key 的 replay：第一次 HTTP 发布 revision 1、audit 1；第二次同 key 在事务 admission 处等待时撤权 → HTTP 403，`revalidateActor` 被调用，binding/revision/audit/journal 行完全不变。
- 新 keyed intent：请求前撤权 → 403，无 journal；等待中撤权 → 403，无 journal/binding/audit；恢复授权后同 key 可正常发布 revision 1（key 未被消耗）。
- 无 key 发布、preview、binding/effective/audit 读取在等待中撤权全部 403，计数不变。
- config：live 撤权时 activate 在任何试采前 403（trial 0 次、journal 缺失、audit 0）；已提交后 intent 查询在等待中撤权 → 403 且不返回 journal 内容。
- 路由单元反例直接使用 Chief 的公开 publish replay 形态：不传 reload 参数注册生产路由，spy `actorContextService.revalidateActor`，撤权后 403、审计仍 1、revision 仍 1。

## 4. 修复涉及的既有测试漂移

`conflict-cas.mysql.test.ts` 的“过期测试”用例用固定 `guardChecks === 6` 定位 trial 与 publish 之间。R2 在 trial 内部新增了锁后 `live` 检查，使第 6 次检查落在外层 trial 事务持锁期间：另一连接 `changeBinding` 等到 `innodb_lock_wait_timeout`，随后 trial 超时返回 failed，activate 成功，用例失败。该失败在 R2 交付 `17621094f` 的干净归档树即可复现（与 R3 改动无关），不是本包引入。

本包只改测试定位方式：以 trial spy 记录“trial 已返回”作为注入点，在 trial 之后、publish 之前的 pre-publish `currentActor` 处推进 revision，恢复用例原本描述的语义。生产代码与该用例的断言不变；修复后该用例与整模块通过。

## 5. 未覆盖与限制

- 浏览器与 HTTP 测试的试采边界仍是受控 fixture（固定成功样本或门控）；认证是固定 fixture admin。不证明真实登录、真实目标、真实采集或正式 history/event 链。
- “等待锁”用 store admission gate 模拟；真实 MySQL 上的锁由同一 `MysqlPolicyStore` 执行，但未在生产规模并发下压测。
- 未在提交瞬间 kill 进程，不声称远程 exactly-once；pending 仍不可重试。
- 前端恢复记录只在同一标签页 `sessionStorage`；换标签页不会自动恢复未知意图。
- 未改激活谓词、必要指标名单、可选排除策略、调度器、worker、migration、部署；整单未验收。

## 6. 安全 PR

草稿 PR：https://github.com/max2055/Slide/pull/567，发布分支 `agent/15coder1/max-238-release`，基 `origin/main` `e11f6ba2e` 的独立提交；R3 以新提交追加在同一 PR，排除 `CLAUDE.md` 与 `attachments/`，不复用含 qualification 运行快照的原分支祖先。未合并、未部署。
