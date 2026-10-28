# MAX238-APPLY-IDEMPOTENCY-R2：未知结果、锁后权限与原资源恢复

本包修正 R1 `d874ae663` 未接受的三项缺陷，并补齐 R2 要求的验证闭环与安全 PR 路径。整单 MAX238/MAX235 仍未完成：真实消费者依赖、最终集成 gate、真机采集与生产发布均未在本包放行。

- 任务分支：`agent/15coder1/max-238`（只追加，未切换/重置/改写任何已接受提交）
- 基点：`d874ae663bf914f0eac3fb0a4415fda934d89294`（R1 交付，未接受）
- 实现提交：`1a7cd24b41eebd58950a56240396e9ab47f19440`
- 测试与证据提交：本文件所在提交（新 HEAD 见交付评论）
- 未改：激活谓词、必要项名单、发布结果格式、migration、调度器、worker、前端其他组件、`config/access.ts`

## 修正内容

### 1. 未知结果不再被清成 absent

`MetricConfigurationService.activate` 按失败发生的阶段决定清理：

- `preview`（在任何目标 IO 之前）与 `trial-done`（试采已返回确定结论，未开始发布）→ 删除本意图自己的未提交占位，同 key 可重试。
- `trial`（试采边界抛出一般异常 / timeout / abort / 清理或连接故障）→ 占位保持 `pending`，不设 TTL，不声称跨崩溃远程 exactly-once。
- `publish` → 在锁内重读日志：`committed` 行即本意图丢失的响应，直接返回记录结果；仍为 `pending` 说明发布事务已回滚（日志行与 binding 同事务提交），才允许清除；读取失败保持 `pending`。

`PolicyService.failedOperation` 取代 R1 的无条件 `releaseOperation`；`releaseApplyOperation` 仍只删除同资源、同 `intent_digest`、`state='pending'` 的行。

### 2. 锁等待后使用实时权限

`beginOperation` / `changeBinding` / `replay` / `operation` 在 `assertAccess` 之后、进入 policy 串行区，再由 store 的 admission、连接获取和行锁等待之后重新读取实时主体并再次授权：

- 生产入口 `metricConfigurationService` 将 `actorContextService.revalidateActor`（或调用方 guard 的 `check`）传入这些边界；`activate` 在 `beginOperation` 与发布前都使用同一 guard。
- 已提交 key 的 replay、意图查询、发布前都不再使用请求到达时的 actor 快照。
- 无 reload 能力的调用方不新增权限查询，保持原行为。

### 3. 原资源与页面生命周期恢复

`metric-configuration`：

- 发布请求在发出前记录最小恢复信息（`sessionStorage`，按用户 id + 资源键隔离，只含 client key 与请求体，不含凭据/样本/机密）。
- 失败后只查询**原资源原 key**；视图已切换（generation 变化）的旧请求直接返回，不查询也不修改新资源状态。
- 同资源重新挂载/刷新时恢复该 key，只提供“查询发布结果”，不会静默生成新 key；显式新意图（不同 payload/revision/资源）才生成新 key。
- 只有明确、结构有效的 `absent` 才清除记录并允许重试；`pending`、查询失败与无效响应都按未知保守处理。

## 验证

所有证据绑定提交 `1a7cd24b4` 与被测文件哈希（见同名 `.json`，测试文件哈希在证据提交中）。

| 检查 | 结果 |
| --- | --- |
| `idempotency-r2.test.ts`（三项 Chief 反例 + 恢复契约，内存事务，无目标 IO） | 9 passed |
| `idempotency-recovery.test.ts` + `routes.test.ts`（R1 回归） | 23 passed |
| `src/metrics/config` + `src/metrics/policy` 模块（无 MySQL env） | 151 passed / 66 skipped |
| `apply-idempotency-r2.mysql.test.ts`（一次性 MySQL 13306、真实迁移） | 4 passed |
| R1/已接受 MySQL 包回归（`apply-idempotency`、`apply-idempotency-r1`、`publish-rejections`） | 16 passed |
| `src/metrics/bulk` + `src/metrics/rollout` | 33 passed / 36 skipped |
| API `tsc --noEmit` | 退出 0 |
| `contracts:check` | 退出 0（公开契约未变） |
| 前端 `tsc --noEmit` | 退出 0 |
| 前端 vitest（含组件 55 项） | 1326 passed |
| 前端 build（含 CSP 检查） | 通过 |
| Playwright MAX-238（chromium） | 4 passed |

一次性 MySQL 是 127.0.0.1:13306 上的独立容器（`mysql:8.4`），每个测试文件自建 schema、结束时 DROP，不访问 3306 或任何生产目标。

### 一次性 MySQL 覆盖

- 试采边界抛未知异常后，日志保持 `pending`；**真实第二个 OS 进程**（`node_modules/.bin/tsx` 子进程，独立 PID）读同一 schema，得到 `pending` 且同 key 重试返回 `POLICY_OPERATION_PENDING`；binding/audit 仍为 0。
- 发布事务被触发器阻断（确定回滚）后同 key 变为 `absent`，恢复后可正常发布 revision 1。
- 真实 HTTP（Fastify + 真实路由 + 真实 journal）：服务端提交后客户端中止响应 → 查询返回 `committed`；同 key 再 POST 返回记录结果，revision/audit 仍为 1。
- 真实 HTTP：试采被门控在途时客户端中止 → 查询返回 `pending`；同 key 再 POST 返回 409 `POLICY_OPERATION_PENDING`，试采次数仍为 1。

### 浏览器

真实 `metric-configuration` 组件经 Vite 代理调用真实 Fastify API 与一次性 MySQL journal（`apps/db-ops-api/e2e/max238-real-api-server.ts`，试采为受控 fixture）：

- committed：`route.fetch()` 让服务端完成提交后丢弃响应，组件查询原资源原 key 并恢复，只发生 1 次 activate。
- pending + 页面刷新：服务端已占位但未提交，组件刷新后仍显示“上次发布结果尚未确认”，只有“查询发布结果”，点击只发 GET，activate 仍为 1 次且试采次数不增。

## 未覆盖与限制

- 浏览器与 HTTP 测试的试采边界是受控 fixture（固定成功样本或门控）；不证明任何真实目标、真实采集或正式历史。API 的认证是固定 fixture admin，不覆盖真实登录/权限变更。
- “跨进程重启”用真实第二个 OS 进程读取同一 schema 证明 `pending` 持久且不可重试；没有在提交瞬间 kill 服务进程，不声称远程 exactly-once。
- 前端恢复记录只在同一标签页的 `sessionStorage` 内；换标签页或清空存储后不会自动恢复未知意图（不会因此重发同一 key，而是重新读取状态）。
- 旧的无 key `/api/metrics/policy/.../publish` 路由保持原行为（请求前一次 `assertAccess`），未接入本协议；本包的实时授权边界覆盖带 key 的 activate/intent 链路及其生产入口。
- 未改 migration、激活谓词、必要项名单、调度器、worker、生产目标与部署。

## 安全 PR

草稿 PR：https://github.com/max2055/Slide/pull/567，发布分支 `agent/15coder1/max-238-release`，基 `origin/main` `e11f6ba2e` 的单个独立提交。排除 `CLAUDE.md`（工作区运行规则）与 `attachments/`（协调交接材料），不复用含 qualification 运行快照的原分支祖先；未合并、未部署。
