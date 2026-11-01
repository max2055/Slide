# MAX238-NATIVE-CONFIGURATION-FLOW-R3：探测可恢复、证据收尾授权与不可恢复写

2026-10-30。**一句话结论**：本轮修正 R2 复审列出的五条真实缺陷——显式探测被旧证据挡住、证据事务最后读回未授权、存储不可用时仍发出不可恢复写、查询旧意图清掉新草稿、测试资源按 PID/前缀推定所有权；每条都有“先失败→修正→回归”的测试，以及真实 MySQL 8.4（非 3306）/真实 Fastify/真实 Chromium 证据。R2 未整体接受，整单仍 `in_progress`。

## 1. 分支与范围

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-238`（基点 `634e67a94`，只在 `634e67a94` 之上追加） |
| 未改写 | 未 amend/rebase/reset `634e67a94` 之前任何提交，未切换任务分支 |
| 迁移 | 无新增/修改迁移；`136_metric_capability_evidence.sql` 复用 |
| 未触碰 | MAX240 query/storage/formal-store、activate 谓词/必要项名单、strict codec、共享 3306 |

## 2. 五条修正

### 2.1 显式探测不再被过期/损坏证据挡住

`binding-service.ts` 的 `probe()` 现在以 `recover = true` 解析上下文：`bootstrapCapabilities()` 先读证据，只有 `CAPABILITY_EVIDENCE_EXPIRED` / `CAPABILITY_EVIDENCE_INVALID` 被当作“可以重新真实探测”，存储错误（`UNAVAILABLE`）仍然失败；读取后**始终**重新执行有界只读探测并通过同一身份的 upsert 原子替换。消费路径（preview/trial/apply）不变，继续拒绝过期/损坏证据（503）。旧证据不改日期、不当 supported，也不要求用户改草稿来绕过 key。

回归：`binding-service-probe.test.ts` 的 `R3: an expired evidence row …`、`R3: a corrupt evidence row …`、`R3: an unreadable evidence store …`；真实库 `first-binding.real.test.ts` 的 `R3: an expired evidence row is a refusal to consume but is replaced by a real re-probe`（真实表内把 `expires_at` 改到过去 → preview 503 `CAPABILITY_EVIDENCE_EXPIRED` → probe 200 → 同一行被替换 → preview `executable=true`）。

### 2.2 证据事务的每一个等待边界都在同一连接上重新授权

`capability-evidence.ts` 的 `writeCapabilityEvidence()` 现在在 **admission、连接/事务开始、UPSERT 行锁等待、SELECT 读回之后** 都调用同一连接上的 live 授权，最后一读发生在 COMMIT 之前；任何拒绝都会回滚，已有行保持不变。COMMIT 失败不再归入“不可用”，而是新的 `CAPABILITY_EVIDENCE_COMMIT_UNKNOWN`（仍非成功）。`assertAccess(..., executor)` 在同一连接上校验资源关系。

证据身份新增两项复用边界：

- `target_identity`：由平台自己的目标行（host/port/user/database + 加密凭据列的指纹）计算，目标被改写或凭据轮换即换身份（`bindings/target-identity.ts`）；
- `actor_id`：执行探测的主体进入 key，另一主体不能消费。

`dependencyDigest` 也纳入 `target_identity`，所以试采与应用之间的凭据/目标变化会让 receipt 依赖不一致。

回归：`capability-evidence.test.ts` 的“读回后撤权回滚”“COMMIT unknown”“target/actor 身份隔离”；真实库 `R3: a grant revoked after the real read-back leaves zero rows in the real database`（真实 writer + 真实 MySQL：第 4 次授权拒绝 → `evidence_key` 行数 0；正常授权 → 1 行）；真实库 `R3: a rewritten credential row is a different evidence identity`（真实行改 `password_encrypted` → 旧证据不被消费 → 再探测写第二行）。

### 2.3 没有可靠持久意图就不发写

前端 `rememberIntent()` 先把“主体 + 资源 + 意图 + key + 草稿版本”写入 `sessionStorage`，**写成功才允许发出 `/apply`**；`setItem` 失败（QuotaExceeded 等）时直接拒绝、保留草稿并显示可读错误。`validIntents()` 对任意坏条目整体判为损坏（不再 filter 静默丢弃），读取失败/损坏都阻止写。同标签页内存副本只用于当前 tab 的查询，不再冒充页面刷新恢复；主体无法读取时用本页 token 隔离，避免把旧主体请求投影到新人。

回归：`native-template-configuration.test.ts` 的 `R3: an intent that cannot be made durable is never sent…`、`R3: a same-tab reload keeps the queryable intent…`、`R3: a corrupt stored intent array…`。真实浏览器见 §3 案例 B。

### 2.4 旧意图的 committed 只结算旧意图

`lookup()` 不再以“查询开始时的 draftVersion”比较，而是与 **该 intent 记录创建时的 draft** 比较；因此查询前已存在的新编辑、查询期间的新编辑都会保留，旧 committed 只把旧 key 结算为已提交，不修改 `settings/parameters/dirty/preview`，也不把旧 revision 投影成新意图成功。所有调用点（apply 失败、commit_unknown、restorePending、pending 查询）都传入原草稿版本。

回归：`R3: a committed answer for an old intent never clears edits made before the query`、`R3: an edit made while the recovery query is in flight is preserved too`；R2 的迟到 preview 回归保留。

### 2.5 测试资源所有权

新增 `apps/db-ops-api/src/testing/owned-fixture.ts`：run 随机 nonce、**先写 handle**（记录 `server_uuid/port/schema/owner/state`）、`CREATE DATABASE` 之前从不 DROP、已存在即拒绝；清理时重新核验 handle 与活服务器身份，DROP 后核验消失，任何未知都非零并保留 handle。

- `first-binding.real.test.ts` 不再 `DROP DATABASE IF EXISTS` PID 名，平台库与目标库都走 owned fixture，`afterAll` 逐项清理并保留失败 handle；
- `config-lifecycle-20261030/seed.ts` 同理，目标 schema/用户改为 nonce 派生（用户名为 nonce 摘要，满足 MySQL 32 字符限制），失败路径清理仅限 handle 证明的本 run 资源；
- 容器/进程仍由 R5 的 nonce 标签 + 精确 ID + 记录 PID 管理，本页脚本不按端口/名称扫描，也不 kill 任意同名进程。

回归：`src/testing/owned-fixture.test.ts` 6 项（含另一台服务器拒绝、planned 不删、删除无法核验保留 handle）。

## 3. 真实证据

### 3.1 真实 MySQL + 真实 Fastify

`apps/db-ops-api/src/metrics/templates/first-binding.real.test.ts`，一次性 MySQL 8.4（容器按 nonce 标签与精确 ID 管理，端口非 3306，真实只读目标用户仅 `SELECT + PROCESS`）：

| 场景 | 结果 |
|---|---|
| 空 binding/空 capability → 真实探测 → preview → trial → 首绑 revision 1 | 通过；operation/audit 各 1 |
| 并发首绑 | 恰好 1 committed、1 409 |
| 失败探测 | 证据 0 行、binding 0 行 |
| **R3 过期证据被重新探测替换** | preview 503 → probe 200 → 同一行替换 → preview executable |
| **R3 凭据行改写后旧证据不被消费** | preview `executable=false` → probe 200 → 证据 2 行 |
| **R3 读回后撤权零行落库** | 真实 writer 拒绝 → `evidence_key` 0 行；正常写 → 1 行 |

`6 passed`。

### 3.2 真实浏览器（Chromium 1440×900 → Vite → Fastify → 一次性库）

`docs/slide/development/MAX-238/r3-browser/flow.mjs`，机器证据 `browser-evidence.json`，截图 `a-durable-refresh-1440.png`、`b-storage-refusal-1440.png`：

| 场景 | 结果 |
|---|---|
| A：`/apply` 已到达服务器但 HTTP 响应被丢弃，`/operations` 恢复查询也不可用 | 写前 sessionStorage 已有 pending 意图（`has_draft=true`）；页面刷新后 `unresolved=0`、`pending=false`、binding `template/revision=1`；数据库 operations=1、audits=1（无重复 revision/audit） |
| B：`sessionStorage.setItem` 抛 QuotaExceeded | `/apply` 请求数 **0**、页面显示“拒绝本次发布”、草稿仍在；operations/audits 维持 1/1，未新增 binding |

边界：真实 API 在一次性库上启动其自身的指标调度器（会 tick），目标库用户只读；未连接生产/共享 3306，未部署。

### 3.3 门禁

| 检查 | 结果 |
|---|---|
| API `tsc --noEmit` | 通过 |
| 前端 `tsc --noEmit` | 通过 |
| `src/metrics/{templates,bindings,policy}` vitest | **495 passed / 47 skipped** |
| 前端受影响组件 | **22 passed**（`native-template-configuration.test.ts`） |
| 前端全量 vitest | 1351 passed / 1 failed：`metric-configuration.test.ts` 在并发负载下 5s 超时，单跑 **4/4 通过**，与本包改动无关联（未改该文件/该组件） |
| 前端 build + CSP | 通过（CSP check passed for 2 production scripts） |
| `contracts:check` | 通过 |

## 4. 未覆盖与限制

- 真实 API 的一次性环境会启动其内部调度器；不构成生产 worker/部署，已如实记录。
- 前端全量套件的一条超时是并发负载下的复现性限制，单文件通过，未删断言/未 skip。
- 证据只覆盖本包触达：探测刷新、证据收尾授权、持久意图缺失拒绝、旧意图查询、测试资源所有权；不重跑已接受的 78602s 正式采集链、不改 MAX240。
- 未合并、未部署；MAX238/MAX235 保持 `in_progress`。
