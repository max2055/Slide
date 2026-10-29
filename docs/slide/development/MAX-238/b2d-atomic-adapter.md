# MAX-238 B2D：内部原子事务适配核心

2026-10-27。本文件对应实现提交 `688e9657498630b5eb3e685e2fb8dc5e50bae794`，端口收敛 `f448a00206bdd8929d50be0dbdb891941329482a`（实现最终状态；下文文档提交只在其后追加）。已接受的 B2C 基线为 `26859b1196574831fe29acd266269874aef147d7`。**B2D-R1 最终能力时效补修**见 §7，实现提交 `4f312e6c3`，基线为 B2D 交付 HEAD `41f39dc8a0c0564e5a8fd96220338cdde65ae320`。**本包是未挂载的内部适配核心**：没有生产 store、路由、receipt issuer、DDL、运行时或真实采集；真实存储与读者接线见 `b2d-production-wiring.md`。

## 1. 允许文件与实际 diff

| 文件 | 变化 |
| --- | --- |
| `apps/db-ops-api/src/metrics/bindings/transaction-guard.ts` | 只追加显式 v2 入口：v2 receipt、v2 operation、完整查询、B2C 重算、执行性门禁、受信 application context。v1 入口、legacy、精确 replay、unknown 只查、R1 最终边界与同步时钟全部保留。 |
| `apps/db-ops-api/src/metrics/bindings/transaction-adapter.ts` | 新增内部 adapter：单次原子暂存意图、host 结算结果映射。 |
| `apps/db-ops-api/src/metrics/bindings/transaction-adapter.test.ts` | 新增 focused 测试（58 项）。 |
| `apps/db-ops-api/src/metrics/bindings/index.ts` | 一行内部 export。 |

未改 `policy/model.ts`、`policy/service.ts`、`policy/store.ts`、`policy/resolver.ts`、`config/*`、`scheduler/*`、`packages/*`、`runner`、`contracts/*`、路由、DDL、前端或事件历史；`resolve.ts`/`plan.ts` 只读调用。

## 2. v2 守卫协议（`prepareTemplateBindingMutationV2`）

请求仍只允许 `resource`、原始 `candidate`、`caller_key`、`receipt_id`；strict schema 拒绝任何 `resolution_identity`、`dependency_digest`、`candidate_digest`、receipt 内容或 `mode` 字段（无“预览模式”之类的虚构入口）。

信任来源全部来自事务视图：

- `applicationContext(resource)`：同视图的 `Resource`/group/inventory capabilities/受信 `at`，上一份 `application`（`status`/`applied_revision`/`resolution_identity`），以及审计 actor。
- `findOperationExact(caller_key)`：必须显式 `{complete:true, operation|null}`。裸 `null`、缺 `complete`、`complete:false` 或抛错都是“没有完整保证”，稳定拒绝 `TRANSACTION_OPERATION_UNAVAILABLE`；不得用审计窗口或截断 journal 证明不存在。
- `findReceiptConsumption(receipt_id)`：同样必须 `{complete:true, consumed:boolean}`；`consumed` 只来自 receipt 消费唯一性查询。
- 其余 `authorize`/`currentBinding`/`getTrialReceipt`/`mandatoryItems`/`serverNow` 沿用已接受 B2B 契约。

判定顺序：

1. 首次受信授权；`compileBindingCandidate` 重走 B1+B2A；资源身份一致。
2. legacy：共享最终授权/依赖边界后原样返回，不读 receipt/resolution，不产生任何写决定。
3. 读当前 `payload.binding`；`revision` 仍是唯一 CAS，目标 `base+1`。
4. 精确操作查询：
   - 先做与 resolution 无关的五项比较（caller key、resource、target、candidate digest、dependency digest、receipt）；
   - 再在同一事务重跑 `resolveTemplateBinding` → `buildTemplateCollectionPlan`，要求 `resolution_identity` 也一致；
   - 全部一致且 `committed` → replay；`unknown` → 只查原操作；任一不一致 → `TRANSACTION_OPERATION_CONFLICT`（同 key 跨 resource/target/candidate/resolution/receipt 都不是精确 replay）。
   - replay 仍要求当前可重算出的 resolution identity 一致：若当前 B2C 已因能力/参数/设置漂移而阻塞，按对应稳定码拒绝（不回写、不伪造 replay），调用方按 `caller_key` 查原操作；receipt 过期或 current revision 前进**不**影响 replay。
5. 新操作：CAS 通过后再重跑 B2C；非可执行一律拒绝：
   - `settings.enabled=false` → `TRANSACTION_RESOLUTION_DISABLED`；
   - unsupported/unknown 等 `blocking` 项 → `TRANSACTION_RESOLUTION_BLOCKED`（携结构化 item 定位）；
   - 无任何可执行步骤 → `TRANSACTION_RESOLUTION_EMPTY`。
6. 读 v2 receipt、受信 mandatory 列表、receipt 单次消费查询。
7. 最后一次异步授权复验，然后**同步**读受信 `serverNow`；其后无 await，依次校验 receipt 身份（receipt id、resource、base/target、candidate digest、**resolution identity**、dependency digest）、时间、逐项 read/transform/unit 与显式非必需排除，再执行 §7 的最终能力时效门禁。
8. 返回 `prepared`：`resolution`、`plan`、三个身份、上一份 application 与 actor，供 adapter 组意图。

v1 与 v2 的边界：

- v1 receipt schema 仍严格，缺 `resolution_identity` 的旧 receipt 不可能被 v2 使用；v2 的 `receipt_version: 2` 判别式让 v1 entry 的 strict schema 拒绝 v2 receipt，不做静默升级。
- v1 operation schema 同样严格；缺 `resolution_identity` 的旧记录在 v2 下是 `TRANSACTION_OPERATION_INVALID`，不会成为 replay。
- v1 入口的既有行为未改（原 79 项测试全部通过）。

## 3. 原子适配器（`applyTemplateBindingMutation`）

Host 只暴露：同视图读 + `templateVersions()`（必须绑定同一事务连接）+ `stageApplication(intent)` + `settleApplication(staged)`。adapter 不接受调用方另行传入模板 reader。

- legacy / replay / `operation_lookup_required`：原样返回，`stageApplication` 调用 0 次。
- `prepared`：恰好构建一个 `BindingApplicationIntent`、调用一次 `stageApplication`。意图包含：
  - 原始候选（`package:null`、固定 pins、`revision=target`），**不**把解析结果写回 binding；
  - 附属 `pending.plan`（B2C `TemplateCollectionPlan`）与 `resolution_identity`；
  - `application.status='pending'`，保留上一份 `applied_revision` 与 `previous_resolution_identity`；上一份有效计划不在意图内，写入者不得覆盖；
  - operation（五身份 + receipt + 状态）、receipt 消费、audit（含受信 actor 与决策时间）。
- host 显式拒绝（`{status:'rejected', code}`）→ `rejected`，零写入。
- staging 抛错/形状不明 → `commit_unknown`（`stage_unavailable`），不重试。
- 结算只认显式 `committed` 且 revision 等于目标 revision → `committed`；`rolled_back` → `rolled_back`；`unknown`、抛错、非法形状、错误 revision → `commit_unknown`（分别 `host_reported_unknown`/`settle_unavailable`/`settle_invalid`），返回“查询原操作”而不重发。
- `stage` 确认本身永远不等于 committed。

## 4. 验证（实现最终状态 `f448a0020`，Node v24.18.0 / pnpm 11.19.0）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings/transaction-adapter.test.ts` | 1 file / 58 passed | 0 |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings` | 6 files / 207 passed | 0 |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings src/metrics/policy src/metrics/scheduler src/metrics/packages src/contracts/metrics` | 16 passed + 4 skipped files；403 passed + 36 skipped | 0 |
| `pnpm --filter slide-api typecheck` | 无错误 | 0 |
| `pnpm contracts:check` | 无差异（本包未改契约） | 0 |
| `pnpm exec oxlint apps/db-ops-api/src/metrics/bindings` | 0 warnings / 0 errors | 0 |

focused 覆盖（真实 `PackageRegistry.install/get`、真实 `sealRelease`）：

- 完整原子意图：原始 binding、三身份、pending plan、上一 application 保留、audit actor、单次 stage/settle、四种状态各写 1 次；
- 每步拒绝（授权/取消/依赖/缺 binding/过期 revision/上下文/分辨率/receipt 时间/消费/clock）均零写；staging 抛错与结算回滚各状态不变；
- 同 key 跨 receipt/resource/target/candidate/resolution/dependency 六个方向的 collision；完整查询缺失/不完整/旧 v1 记录的稳定拒绝；
- receipt 已消费、并发重复 key（stage 显式拒绝）、replay 即使 receipt 过期且 current revision 前进、unknown 只查零再写；
- B2C 设置（group 覆盖）、参数、能力证据变化使 receipt 失效；unsupported 能力、settings disable、全 metric disable 分别阻塞；
- legacy 零调用；请求不能回填任何受信字段；输入与 registry 快照不变；
- 测试 fixture 明确区分内存事务模拟与 MySQL：只检验提交前后 binding/operation/consumption/audit 四类状态与写入计数，**不称** MySQL 事务、行锁或 CAS 已通过。

## 5. 明确未实现 / 未证明

- 未实现生产 `PolicyStore` 接线、MySQL 事务/行锁/唯一索引、receipt issuer、持久 operation/receipt 表、审计迁移、路由、activation 入口或运行时。
- 未运行 trial、未签发真实 receipt、未连接任何 DB/SSH/SNMP/凭据，未产生样本、正式历史、健康或“已应用”结论。
- 生产 host 承诺（同事务四记录原子提交、回滚、唯一约束、提交结果上报）只由端口契约定义，未由本包证明。
- 真实权限在提交瞬间的原子性仍需版本 fence/授权锁或提交前复验；本包保留 R1 “最终授权→同步时间→决策”边界，但不声称提交瞬间权限不变。
- 真实 receipt 的持久化、撤销、过期与旧行保留策略见 wiring 文档，DDL 未执行。

## 6. 下一最小事实

Chief 对准确 HEAD 做 B2D 终态复审；若接受，再按 `b2d-production-wiring.md` 核实现有 DDL/生产写/DB 授权，单独放行生产存储、receipt issuer 与旧读者 fence。MAX238 与父 MAX235 保持 `in_progress`；原五项/A06/A07/A09/A16/A20、A01–A22、四编码标准、D05/O02/O03 不缩减。

## 7. B2D-R1：最终能力时效门禁（实现提交 `4f312e6c3`）

基线 `41f39dc8a0c0564e5a8fd96220338cdde65ae320`；只改 `transaction-guard.ts` 与 `transaction-adapter.test.ts`，未改 adapter、`resolve.ts`/`plan.ts`、contracts、DDL、路由、运行时或任何共享文件。

### 7.1 缺陷

v2 入口把 `applicationContext.at` 交给 B2C 解析能力，最终授权之后只用 `serverNow` 校验 receipt 时效，没有按最终受信时间复核实际启用项的能力窗口，也没有拒绝未来的 `applicationContext.at`。因此：

- receipt 在 10 月 4 日才过期时，9 月 19 日就结束的能力仍可进入 prepared/stage（F1a：context 9 月 18 日、能力 9 月 19 日到期、最终 now 10 月 3 日）；
- `at` 与能力 `evaluated_at` 为 10 月 3 日 12 时、最终 now 为 10 月 3 日 0 时时，提前 12 小时的“未来证据”仍被接受（F1b）。

### 7.2 修复

`assertEnableTime(application, plan, now)` 位于最后一次异步授权与**同步** `serverNow` 之后、形成 prepared 决策之前，无后续 await：

1. 受信 `applicationContext.at` 必须可解析且不晚于最终 `now`；否则 `TRANSACTION_CONTEXT_TIME_INVALID`。未来的 context 也是唯一能让未来 inventory（`observed_at <= at` 但晚于 now）看起来受支持的入口，因此同一条规则拒绝。
2. 对 `plan.releases[].steps[].items[]`（即本次启用计划实际使用、`decision: 'collect'` 的每一项）校验 `evaluated_at <= now < valid_until`；不满足（含恰好等于 `valid_until`）则 `TRANSACTION_CAPABILITY_TIME_INVALID`，携排序后的 `{template_id, item_id, item_version}`，不携值、driver 或凭据。
3. 禁用/未选中项不进入任何 plan step，不引入新权限结论；既有 `blocking` 排除、settings disable、空计划仍在 B2C 阶段拒绝。
4. 门禁只作用于新 prepared 路径：精确 committed replay 仍零 stage，receipt 过期或 current revision 前进不触发重写；unknown 仍只返回原操作查询，不因时间问题重发；legacy 最终授权/依赖、v1 79 项、v2 三摘要/完整查询/collision/receipt 单次消费、同步 clock 异常与撤权/取消/依赖变化全部保留。
5. 修正原成功 fixture：默认能力窗口改为覆盖 context（`2026-09-18`）与最终 now（`2026-10-03`），不再用 9 月 19 日就到期的能力当作 10 月 3 日的合法成功前提；反例另以显式过期/未来窗口构造，没有靠改时间掩盖漏洞。

### 7.3 验证（实现 `4f312e6c3`，Node v24.18.0 / pnpm 11.19.0；均为底层命令真实退出码）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings/transaction-adapter.test.ts` | 1 file / 67 passed（原 58 + 9 新增） | 0 |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings` | 6 files / 216 passed | 0 |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings src/metrics/policy src/metrics/scheduler src/metrics/packages src/contracts/metrics` | 16 passed + 4 skipped files；412 passed + 36 skipped | 0 |
| `pnpm --filter slide-api typecheck` | 无错误 | 0 |
| `pnpm exec oxlint apps/db-ops-api/src/metrics/bindings` | 0 warnings / 0 errors | 0 |

契约未改，`contracts:check` 按准入复用既有结果，未重复运行。

反例闭合的可执行证据：将 `transaction-guard.ts` 临时还原为基线 `41f39dc8a` 后，同一测试文件为 5 failed / 62 passed——过期（F1a 形态）、读取期间过期、恰在边界到期、未来 context（F1b 形态）、未来 inventory 五条均实际失败（旧代码提交/暂存）；合法窗内成功、禁用项、replay 与 unknown 四条保持通过。恢复修复后 67 passed。

### 7.4 未证明

内存 fixture 仍只证明决策与零/单次写入计数；不称 MySQL 事务、CAS、行锁、真实能力探测、试采或生产应用已通过。生产 wiring、DDL、receipt issuer、共享读者与运行时接线仍须 Chief 接受 R1 后单独准入。

