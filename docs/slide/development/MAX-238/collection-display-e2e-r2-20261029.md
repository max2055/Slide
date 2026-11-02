# MAX238-COLLECTION-DISPLAY-E2E-R2：原生模板链路的权限、租约与公开契约收口

2026-10-29。**一句话结论**：R1 已交付的真实业务链（既有 mysql3306 → 固定原生 v2 模板 → 真实只读采集 → 正式历史 → API/页面同观测）保持不变；本轮把这条链路执行路径补上**与既有 legacy 路径同等的实时 fence**，把模板绑定公开入口的授权改成**锁后实时重读**，修复 re-pin 的资源边界与真实调用者审计，并为 7 条公开路由登记了准确的 Fastify/OpenAPI/生成客户端契约。**这不是 MAX238 整单完成**：整单剩余范围见 §7。

机器证据：[collection-display-e2e-r2-20261029.json](collection-display-e2e-r2-20261029.json)。

## 1. 边界：哪些是真实、哪些是受控

| 类别 | 内容 |
|---|---|
| 真实 MySQL 事务 | 一次性容器 `mysql:8.4.10`（非 3306，`127.0.0.1:13318`），空库跑完整 migration；fence 用例读取的是真实 `metric_schedule` / `workflow_jobs` / `metric_attempts` / `metric_observations` 行 |
| 真实公开 handler | Fastify `inject` 打到 `registerMetricTemplateRoutes` 注册的真实路由，服务是真实 `TemplateBindingService`（仅外部的 actor 源、资源关系表、解析结果受控） |
| 受控反例 | actor 撤权/停用、资源越界、解析结果与 SQL 连接由测试注入；这些**不是**真实故障注入，也不冒充真实采集 |
| 复用（未重跑） | R1 的真实采集/正式发布/页面同值证据（HEAD `4e90fb681`）；本包未新增生产采集，也未写入目标 3306 |
| 未覆盖 | 服务器 3 不可达；全指标、24h、容量、完整迁移、通知触发、AI 前置均不在本轮 |

## 2. 调度执行 fence（新路径接入既有保护）

`MysqlScheduleStore` 新增 `validTemplate`，与已接受的 legacy `valid` 同构，并在 `commitTemplate` / `recordTemplateFailure` 的事务内使用：

- `ctx.signal.throwIfAborted()`（取消）；
- `instanceAccessLifecycle.assertAvailable`（资源生命周期）与 `assetCollectionEnabled(..., FOR UPDATE)`（采集启用）；
- 绑定行仍是这次执行的 revision；
- `workflow_jobs` 中**本 job** 处于 `running`、`lease_owner = ctx.workerId`、`fencing_token = ctx.fencingToken`、`lease_expires_at > NOW()`（`FOR UPDATE`）；
- `metric_schedule` 仍以 `(resource_key, revision, job_id)` 指向本 job；
- 提交末尾**再次**校验，任何在异步工作后发生的变化都会回滚本次写入（观察/raw/attempt/source-check/计数/cadence 一并）。

反例转失败→修正通过（真实 MySQL，12 例）：

| 场景 | 修正前 | 修正后 |
|---|---|---|
| 取消（signal 已 abort） | 仍返回 true 并写 cadence | 抛出、零写入 |
| 租约过期 / 非本 owner / 陈旧 token / job 非 running | 仍提交 | 返回 false，零写入 |
| 采集开关关闭 / 资源 deleting | 仍提交 | 返回 false，零写入 |
| schedule 行被改指向别的 job | 已拒绝 | 已拒绝 |
| 绑定 revision 被更新覆盖 | 已拒绝 | 已拒绝 |
| 失败记录在陈旧租约下 | 仍写 attempt | 抛 `SCHEDULE_STALE_EXECUTION`，零写入 |

`npx vitest run src/metrics/scheduler/template-fence.mysql.test.ts`：修正前 **8 failed / 4 passed**，修正后 **12 passed**。

## 3. 模板绑定公开入口的实时授权

- `TemplateBindingService` 新增注入式 `reload`（生产接 `actorContextService.revalidateActor(actor, actor.requestId)`）；未接线时 `live()` 直接失败关闭（503），绝不回落到请求 actor。
- `trustedInputs.authorize` 在 host 取到 `metric_policy_lock` 之后重读实时 actor，再判 `canManageResource`；guard 的“决策前再读”因而也是新快照，不是同一个旧 `ActorContext`。拒绝时 host 回滚，不产生 revision/audit/receipt/publication 或远程 IO。
- `trial` 在拿到资源锁**之后、远程请求之前**重读并重新判权；`apply` 内被吊销的 session 以 401 复述，权限拒绝映射为 403。
- 回归（真实公开 handler，8 例；对旧源码运行 **6 failed / 2 passed**，修正后 8 passed）：
  - 试采锁等待期间撤权 → 403，`access.resolve` 从未调用，顺序断言 `reserve` 早于重读；
  - 试采锁等待期间 session 停用 → 401，无远程请求；
  - 越界（`resourceBoundary` 不含该实例）→ preview/trial/apply 全部 403，且未触达存储；
  - apply 在策略锁之后撤权 → 403，`lock` 早于重读，`rollback` 且无 `commit`、无写语句；
  - apply 锁内 session 停用 → 401，无写；
  - 未接实时 actor 源 → 503（失败关闭），无写。

## 4. re-pin 的资源边界与真实调用者

- 公开 `POST /api/metrics/templates/:templateId/repin` 先 `assertAccess(actor, resource, write)`（资源关系存在 + live `canManageResource`），再读取 inventory；`metric:manage` 不再能单独越过资源边界。
- `repinTemplateVersion` 接受 `actor`：HTTP 路径用**真实调用者**写 `source_chain.actor_id` / `request_id`（版本审计），维护身份 `userId=0` 仅保留给没有调用者的离线迁移；未扩大任何权限。
- 回归：真实调用者写入版本 source_chain（`actor_id=7`、`request_id=req-238`）；离线调用仍为 `actor_id=0`。修正前第一条失败。

## 5. 公开契约（7 条路由）

新增 `contracts/metrics/template-bindings.ts` 作为唯一来源，同时供 OpenAPI、生成客户端与 Fastify 路由 `schema` 使用：

| 路由 | operationId | 请求 | 响应 |
|---|---|---|---|
| GET `/api/metrics/templates` | listMetricTemplates | — | `TemplateCatalog` |
| GET `/api/metrics/templates/{templateId}/versions/{version}` | getMetricTemplateVersion | — | `TemplateVersionDetail` |
| POST `/api/metrics/templates/{templateId}/repin` | repinMetricTemplateVersion | `TemplateRepinBody` | `TemplateRepinResponse` |
| GET `/api/metrics/template-bindings/{type}/{id}` | getMetricTemplateBinding | — | `TemplateBindingStatus` |
| POST `…/preview` | previewMetricTemplateBinding | `TemplateBindingRequest` | `TemplateBindingPreview` |
| POST `…/trial` | trialMetricTemplateBinding | `TemplateTrialRequest` | `TemplateTrialResponse` |
| POST `…/apply` | applyMetricTemplateBinding | `TemplateBindingApplyRequest` | `TemplateBindingApplyResponse` |

- 清单防漏：测试用 `onRoute` 采集**真实注册**的路由（GET/POST，排除 Fastify 自动生成的 HEAD），与 OpenAPI 的模板路径集合**双向相等**；任一路由漏登记或文档多出都会失败。
- 序列化防丢字段：真实注册 + 代表性 status/preview 载荷经 Fastify 序列化后**逐字段相等**（含嵌套 `plan.releases[].steps`），证明响应 schema 不会静默丢数据。
- `pnpm contracts:check` 通过（`docs/slide/openapi.json`、`frontend/src/api/generated/public-api.ts` 已重新生成）；API 与前端 typecheck 均通过。

## 6. 本次执行的检查

| 检查 | 结果 |
|---|---|
| `METRICS_TEST_MYSQL_PORT=13318 vitest run src/metrics/scheduler/template-fence.mysql.test.ts` | 12 passed（修正前 8 failed） |
| `vitest run src/metrics/templates/` | 80 passed / 22 skipped（含 binding-service 8、repin 3） |
| `vitest run src/metrics src/contracts`（同容器并行） | 94 files passed、1074 tests passed / 43 skipped；`storage.mysql` 与 `policy/store.mysql` 因并行负载 5s 超时，单独重跑 22 passed |
| `pnpm --filter slide-api exec tsc --noEmit` | 通过 |
| `pnpm --filter slide-frontend typecheck` | 通过 |
| `pnpm contracts:check` | 通过 |

未执行：真实采集/页面重跑（复用 R1，未受影响）、压测、部署。

## 7. 仍缺（不属于本轮）

- 绑定应用状态：R1 已披露 `application` 仍为 `pending/applied_revision 4`，而正式 rollout 已到 `revision 5`；本轮未伪造 applied，也未放宽 codec/启用谓词。
- 全指标 `good`、历史窗口阈值、停用/解绑后的历史授权、改名/版本身份、SLO 与真实容量、服务器 3 链路、24h 稳态。
- 整单 MAX238 仍 `in_progress`；本轮可提交当前链路复核。
