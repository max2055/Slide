# MAX238-COLLECTION-DISPLAY-E2E-R3：请求前执行围栏、逐次读取的实时授权与原子 re-pin

2026-10-30。**一句话结论**：R1 的真实采集链与 R2 的提交事务/公开入口授权保持不变；本轮补上 review 两个独立反例所指向的**执行路径**——模板调度在解析凭据与每次实际读取前都使用与 legacy 同等的实时 job fence，native trial 在每次真实读取前与 receipt 持久化前重读可信 actor 与资源边界，re-pin 的整个发布链放入一个 MySQL 事务并在每个写入前重读实时授权，拒绝时无 draft/item/version/current/audit 残留。**这不是 MAX238 整单完成**，也未声称生产环境撤权已演练。

机器证据：[collection-display-e2e-r3-20261030.json](collection-display-e2e-r3-20261030.json)。

## 1. 边界：哪些是真实、哪些是受控

| 类别 | 内容 |
|---|---|
| 真实 MySQL 事务 | 一次性容器 `mysql:8.4.10`（`127.0.0.1:13319`，非 3306），空库跑完整 migration；re-pin rollback 读取的是真实 `metric_templates_v2` / `metric_template_drafts` / `metric_template_versions` / `metric_template_item_versions` 行 |
| 真实公开 handler | Fastify `inject` → `registerMetricTemplateRoutes` → 真实 `TemplateBindingService` → 真实 `repinTemplateVersion` / `MetricTemplateService` / `MySqlTemplateRepository` / 真实事务 |
| 受控边界 | actor live 源、资源 inventory、资源关系表、collector transport 由测试注入；这不是生产故障注入，也不冒充生产撤权演练 |
| 受控调度器 | `template-request-fence.test.ts` 用受控 store/access/collector 驱动**已注册的真实 handler**，断言请求边界的调用顺序；真实 store 的 fence 另在真实 MySQL 上验证 |
| 空观察的限度 | 调度单测返回空行，只证明“租约失效后不再发起读取/不提交”，**不冒充真实样本的回滚负载**；真实样本链复用 R1 |
| 复用（未重跑） | R1 的既有 mysql3306 实例1 → 原生 v2 → 真实只读样本 → 正式历史 → API/页面同值（HEAD `4e90fb681`）；本包未新增生产采集，未写入目标 3306 |
| 未覆盖 | 服务器 3、全指标、24h、容量、迁移演练、通知恢复、AI 闭环；生产 worker 配置、停用/解绑、部署均未触碰 |

## 2. 调度执行：请求前 fence（原反例：`liveLease=false → remoteCalls 1 / fenceReads 0`）

`MysqlScheduleStore` 新增公开 `assertCurrentTemplate`，与 legacy `assertCurrent` 同构：

- `ctx.signal.throwIfAborted()`（取消）；
- `instanceAccessLifecycle.assertAvailable`（资源生命周期）与 `assetCollectionEnabled(..., FOR UPDATE)`（采集启用）；
- 绑定行仍是本次执行的 revision；
- `workflow_jobs` 中本 job `running`、`lease_owner = ctx.workerId`、`fencing_token = ctx.fencingToken`、`lease_expires_at > NOW()`（`FOR UPDATE`）；
- `metric_schedule` 仍以 `(resource_key, revision, job_id)` 指向本 job。

`MetricScheduler.runTemplate` 在三个位置使用它：

1. **`access.resolve` 之前**（凭据解析也可能等待锁）；
2. `check()` 内——即每次实际远程请求/重试之前（runner 的 guarded transport 与 `collect` 包装都会调用）；
3. 每个 release 的 IO 之后、下一 release 之前，以及失败记录/提交之前。

因此 begin 之后租约或 revision 变化时，**后续目标读取不会发出**；即使最后 commit 本会拒绝，也不能撤销已发出的请求这一 R2 缺陷被消除。在途 `unknown`/互斥、已接受的取消语义、生产 worker 配置均未改动。

回归（受控 store/access/collector，驱动真实注册 handler）：

| 场景 | R2 代码 | R3 |
|---|---|---|
| begin 后租约失效 | 发出 1 次读取、fenceReads 0 | **0 次读取**，fenceReads ≥ 1，无提交、无 committed 事件 |
| 第一个 release 读取中租约失效 | 继续第二个 release 读取并提交 | 仅已发出的 1 次读取；第二个 release 不开始，无提交 |

修正前用 R2 `service.ts` 重跑本套件：**2 failed / 0 passed**；修正后 **2 passed**。
真实 MySQL 另加 4 例（`assertCurrentTemplate` 在租约过期/绑定 revision 被覆盖/schedule 被改指向时分别抛 `SCHEDULE_STALE_EXECUTION` / `SCHEDULE_SUPERSEDED`）；`template-fence.mysql.test.ts` 由 12 例增至 **16 passed**。

## 3. native trial：每次真实读取前重读实时授权（原反例：只在 reserve 后刷新一次）

`TemplateBindingService.trial` 定义统一的 `authorize()`：`reload` 实时 actor → `assertAccess(live, ref, write)`（资源管理边界 + 关系存在）。调用点：

- 拿到资源锁之后（原有）；
- `access.resolve` 之后、第一条请求之前；
- 每个 release 的 `before_request`（guarded transport 的每次 query/exec/SNMP 调用、适配器重试都经过）与 IO 之后；
- **receipt 持久化之前**。

撤权/吊销/越界/无实时源一律失败关闭，不再发起远程 IO、不写 receipt、不产生 binding/audit/publication。真实成功与必要项谓词、codec、`activate` 启用谓词均未放宽。

回归（真实 Fastify handler + 受控 transport）：撤权发生在解析之后 → 403、远程读取 0、无写语句；撤权发生在第一次读取期间 → 恰好 1 次在途读取、第二个 release 不开始、无 receipt 写入。

## 4. re-pin：实时授权 + 单事务原子发布（原反例：撤权仍 200、currentVersion 2）

- 公开 handler 只保留 `metric:manage` 入口检查；发布编排移入 `TemplateBindingService.repin`：先验 `assertAccess`（资源边界），读 inventory，再在**一个 MySQL 事务**中执行 `repinTemplateVersion`（item 版本、draft、version、current 指针与 source_chain 审计同一事务）。
- `repinTemplateVersion` 新增 `authorize`：只读分析全部完成后重读一次，随后在**每个写入之前**（item 版本、draft、版本发布、`setCurrent`）重读；写入按重读后的 actor 审计，不再只替换 `actor0`。离线维护调用不传 `authorize`，仍使用既有维护身份，行为不变。
- 拒绝（403/401/503）时事务回滚，不留 draft/item/version/current/audit 残留。

回归：

| 层 | 覆盖 | 结果 |
|---|---|---|
| 真实公开 handler（InMemory 版本存储 + 受控授权） | 只读分析后撤权 403、session 吊销 401、资源收窄 403、无实时源 503、正常成功 200（版本 2、current 2、审计 actor=7），且每次写入前紧邻一次实时重读 | binding-service 套件 **15 passed**（R2 为 8） |
| 真实 MySQL 8.4.10 + 真实事务/仓库 | 在 `setCurrent` 边界撤权 → 403，回读 versions `[1]`、current 1、template/draft revision 与 aggregate 不变、item 版本仍为 1；session 吊销 → 401 且无残留；全部边界通过 → 版本 2、current 2、审计 actor=7 | `repin-authorization.mysql.test.ts` **3 passed** |

## 5. 本次执行的检查

| 检查 | 结果 |
|---|---|
| `vitest run src/metrics/scheduler/template-request-fence.test.ts` | 2 passed（R2 代码上 2 failed） |
| `METRICS_TEST_MYSQL_PORT=13319 vitest run src/metrics/scheduler/template-fence.mysql.test.ts` | 16 passed |
| `METRICS_TEST_MYSQL_PORT=13319 vitest run src/metrics/templates/repin-authorization.mysql.test.ts` | 3 passed |
| `vitest run src/metrics/templates src/metrics/scheduler src/contracts`（无 DB） | 12 files passed / 7 skipped；171 passed / 68 skipped |
| `METRICS_TEST_MYSQL_PORT=13319 vitest run src/metrics/templates src/metrics/scheduler` | 13 files passed / 4 skipped；143 passed / 25 skipped |
| `vitest run src/metrics src/contracts`（无 DB） | 67 files passed / 48 skipped；935 passed / 202 skipped |
| `pnpm --filter slide-api exec tsc --noEmit` | 通过 |
| `pnpm --filter slide-frontend typecheck` | 通过 |
| `pnpm contracts:check` | 通过（无生成差异） |

一次性容器：`mysql:8.4.10`，容器名 `max238r3-mysql`，镜像与 R2 相同；仅本任务使用，结束后删除。未连接共享 3306，未启动远程 SQL/模型/服务。

## 6. 提交与仍缺

- 任务分支 `agent/15coder1/max-238`：实现+测试 `8bea2073b`（基点 `9bce33001`，仅追加）。
- 草稿 PR567 产品提交 `d7e35e435`（父 `6be40c0c1`），base `main`；本证据文档随后作为同 PR 的文档提交追加。未 watch/merge/deploy，未 push 原风险任务祖先。
- 绑定应用状态仍按真实报告：R1 的 `application` 为 `pending/applied_revision 4`，正式 rollout 已到 `revision 5`；本轮未伪造 applied、未放宽 codec/启用谓词。
- 全指标 `good`、历史窗口阈值、停用/解绑后的历史授权、改名/版本身份、SLO/容量、服务器 3、24h、迁移演练、通知恢复、AI 闭环仍属原范围，整单 MAX238 保持 `in_progress`。
