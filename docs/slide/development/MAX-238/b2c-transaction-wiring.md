# MAX-238 B2C 之后：事务适配字段级方案与共享接线准入

2026-10-27。本文件是 Chief `transaction-wiring-admission.md` 要求的字段级方案，基于 B2C 实现提交 `352c6cfad8f9f0ec1ff6424c47cbf367f11e1ae9`。**它不是已实现能力**：本包未建 adapter、未改 `policy/model.ts`/`service.ts`/`store.ts`/`config`/`scheduler`/`runner`，未新增 receipt 服务、DDL、路由或运行时。真实 adapter 待准确 B2C 验收后再由 Chief 放行文件与存储位置。

## 1. 唯一权威与字段映射

`payload.binding` 仍是唯一配置权威，`revision` 仍是唯一 CAS 权威。B2C 结果只作为**派生解析**，不写回 payload；`Published.resolved` 只是展示/执行快照，不是 receipt。

| B2C 输出（`resolveTemplateBinding` / `buildTemplateCollectionPlan`） | 目的位置 | 下一 adapter 的强制行为 | 当前状态 |
| --- | --- | --- | --- |
| `binding`（原始 `ResourceBindingCandidate`：`resource`、`package: null`、`group_id`、`overrides.template_parameters`、`template_pins`、`revision`） | `metric_policy_bindings.payload.binding` | 以 base `revision` + 1 保存**原始候选**，不保存解析结果覆盖 binding；同事务 CAS。 | 未实现 |
| `templates[]`：`pin`、参数 `{name, type, default, override, effective, source}` | 不单独持久化；由 `payload.binding.template_pins` + `overrides.template_parameters` + 同一事务内重读的模板版本重算 | 保存/预览/receipt 校验都必须在事务内重读 `TemplateRepository.getVersion(template_id, version)` 并重算；不能接受客户端缓存或“已 compiled”对象。 | 未实现 |
| `settings` / `sources` / `metric_sources` | 不持久化权威；由 `payload.binding` + group + release recommendations + platform limits 重算；快照可进 `Published.resolved` | 预览、保存不启用、trial、publish/activate 各自重算；不能把旧 `published.resolved` 当作本次 receipt 证据。 | 未实现 |
| `releases[].collectors[].items[]`、`decision`、`capability`、`applicability` | 执行投影；不写 payload | trial/publish 前按当前 `capabilities`、inventory、模板 pin 重算；unsupported/unknown 必须拒绝启用。 | 未实现 |
| `excluded[]`（`blocking: true`） | 阻止进入 pending/应用 | 有 blocking 项时只允许“保存不启用/预览”，不得签发应用 receipt；失败保留上一份有效 payload。 | 未实现 |
| `executable` | 启用门禁的输入之一 | `false` 时 `publish/activate` 拒绝（稳定 code，如 `POLICY_CAPABILITY_UNAVAILABLE`），不写 pending、不发正式请求。 | 未实现 |
| `templateResolutionIdentity(resolution)` | 受信 receipt 的执行身份字段（建议名 `resolution_identity`） | receipt 同时保存现有 `candidate_digest`（B2B，覆盖候选/依赖）、`resolution_identity`（本次 resolved 参数/设置/计划语义）和 `dependency_digest`；`prepareTemplateBindingMutation` 在同一事务重算三者并逐一比较。 | B2C 已提供 identity；receipt 字段未实现 |
| `revision` | B2B `base_revision`，目标 `revision + 1` | CAS 与 operation key 沿用 `bindingOperationKey(resource, target_revision, candidate_digest)`；`resolution_identity` 作为附加精确匹配，不替代 CAS。 | 未实现 |
| `resource` / `group`（`{id, revision}`） | `payload.binding.resource` / `payload.binding.group_id` + 依赖摘要 | 资源 type/id 精确一致；group 变更必须进入 `dependency_digest`，并让旧 receipt 失效（见 §4）。 | 未实现 |
| `platform_limits`、`budget`（`logical_reads`、`estimated_series_upper_bound`） | 预览/审计展示，不写 payload 权威 | 仅估计；不得写成真实负载、SLO 或正式样本结论。 | — |

B2B 已接受的 `prepareTemplateBindingMutation` 继续负责：受信授权、当前 binding 读取、revision/CAS、operation/caller-key、receipt 身份/时间/逐项覆盖和最终授权边界。B2C 只提供它缺少的**解析语义身份**与参数/设置/计划细节；不得用客户端 `compiled` 快照或旧 `candidateFingerprint` 代替。

## 2. 真实读者与唯一写者

| 角色 | 现有源码 | 对模板分支的要求 |
| --- | --- | --- |
| 唯一写者（目标） | `PolicyService.changeBinding` → `tx.saveBinding` + `tx.audit`；`changeGroup` → `tx.saveGroup` + 每成员 `saveBinding`/`audit` | 模板分支的写者只能有一个：同事务内完成 operation 查询/占用、receipt 校验、binding 保存、capability 重置、审计。legacy 单 package 仍由现有 `changeBinding` 路径独占，不双写。 |
| 读：预览/发布 | `policy/service.ts` `resolve`、`effective`、`binding` | 模板分支改用 B2C resolution；`Published.resolved` 只在成功保存后作为快照，不供 receipt 复用。 |
| 读：调度计划 | `scheduler/store.ts`（`compilePlan(published.resolved)`、调度时 `resolvePolicy` 重算） | 多 release 总包执行前必须由下一挂载包提供完整 B2C 计划与同事务 adapter；当前 `compilePlan` 只接受单 package。 |
| 读：执行 | `scheduler/service.ts`（`runPackage`、`published.resolved.settings`、capabilities） | 仍按单 package；不得把 B2C 计划直接交给 runner 或旧的 `credential_ref` 路径。 |
| 读：状态/激活 | `config/service.ts`（`ActivationGuard`/`trial`）、`config/status.ts`、`policy/routes.ts` | trial 必须基于本次重算的 resolution 与真实逐项 read/transform/unit 结果签发 receipt；不能用“some good sample”或 B2C 的 supported 代替。 |
| 读：其他 | `bulk/*`、`rollout/*`、`consumers/*`、`tools/policy.ts` | 经 `PolicyService` 读取；模板分支需要同步的字段/类型变化由下一 adapter 一次性放行，不在本包改。 |

## 3. 同一事务内的顺序（下一 adapter 的字段级契约）

1. `reloadActor` / `assertCurrent` / `beforeRequest`：重新确认 actor 与资源管理权限（沿用 `config/service.ts` 的 `ActivationGuard` 边界）；trial 的真实 IO 在锁外。
2. 进入 `PolicyStore.transaction`：`metric_policy_lock` 串行、同 connection。
3. 读当前 `payload.binding`（唯一配置事实）与 `payload.revision`；读 group、members、capabilities；重读模板版本与 release registry。
4. 重跑 B1 → B2A → B2C（`resolveTemplateBinding` + `buildTemplateCollectionPlan`）：得到参数、settings、逐项 decision、`resolution_identity`。
5. 读 `metric_policy_audit`/operation（按 `caller_key` 精确查询原操作，见 §5）；已 committed → 只回放原 receipt，不重复写；`unknown` → 只返回“查询原操作”，不自动重发。
6. 读并校验 receipt：`candidate_digest`（B2B）+ `resolution_identity`（B2C）+ `dependency_digest` + base/target revision + resource + 逐项 read/transform/unit 覆盖和显式非必需排除。
7. 再次 `assertCurrent` + 受信 `serverNow`（同步读取，签发与消费都不得用客户端时间）；receipt 过期/时间倒置/身份不符 → 稳定拒绝。
8. 同事务保存：`saveBinding(next, resetCapabilities)` + `saveCapabilities`（如适用）+ `audit`；`next.binding` 为原始候选、`revision = base + 1`，`next.resolved` 为本次快照，`application.status = 'pending'`，`applied_revision` 保留上一有效值。
9. 任一步失败 → 事务回滚，旧 published/application、group、capabilities、registry 全部不变。
10. commit 结果未知 → 先按原 `caller_key`/operation 查询确认；不得以截断后的 caller-key 视作新操作重放。

## 4. group 变化与 receipt 失效

- `changeGroup` 现在同时提升 group `revision` 与 `policy_revision`，并重算每个成员；模板分支必须保持“组变更 = 成员配置变更”的语义。
- `dependency_digest` 必须包含：group id + revision + overrides、成员资源权限版本/可见性、模板 pin 集合、inventory 兼容结论、credential-reference 版本。任一变化都使旧 receipt 失效。
- 组变更后旧 `published.resolved` 仍可能留作历史快照，但**不能**被当作 receipt 仍有效的证据；消费 receipt 时必须重读 group 与成员权限。
- 成员权限复验：对组的每个成员重新 `assertAccess(actor, resource, write)`；不能因组内多数可管理就放宽。

## 5. 存储位置、唯一性与保留边界（缺口，非实现）

- 现有 `metric_policy_bindings.payload` 可承载 `binding`/`resolved`/`application`；`metric_policy_audit.payload` 可承载一次操作的配置与结果。
- 现有 operation/receipt **没有**独立主键或唯一约束：`audits(target, requestId)` 读取 `metric_policy_audit`，默认只 `LIMIT 100`，按 `request_id` 也只 `LIMIT 1`；这**不能**证明“不存在”某个操作。
- 若将来要求可靠唯一性（同 `caller_key` 至多一次、receipt 只能消费一次、commit 未知可精确查询），现有结构不足。需要的准确缺口：
  1. operation 表或列：`caller_key` 唯一键 + `resource_key` + `target_revision` + `candidate_digest` + `resolution_identity` + `status(committed|unknown)` + `receipt_id`，或等价唯一索引；
  2. receipt 表或 payload 唯一键：`receipt_id` + `resolution_identity` + `dependency_digest` + `items/exclusions` + 过期时间；
  3. 查询接口：按 `(resource_key, caller_key)` 精确取 1 条，不依赖 100 条审计窗口；
  4. 保留/清理策略与审计合规边界。
- 上述 DDL/存储位置**尚未放行**。本包不建第二表、不建内存生产 store、不把有限审计读取当成唯一性证明；由 Chief 核实授权后决定。
- 前端/API 不新增字段；`payload.binding.overrides.template_parameters` 仅内部多模板分支识别。

## 6. 明确未实现

- 未实现真实 adapter、同事务 `PolicyStore` 读写、operation/receipt 持久化、唯一约束、审计写入、DDL、路由或运行时挂载。
- 未实现 trial issuer、`ActivationGuard` 接线、真实逐项 read/transform/unit 结果或 receipt 签发。
- 未实现多 release runtime/service/store/runner 的总包原子执行与提交；`scheduler/*` 仍只读单 package。
- 未执行任何真实 DB/SSH/SNMP/凭据访问、负载或正式采集；没有“已应用/健康/首样本”结论。
- B2C/R1 的接受不放行 239–245 的真实集成；本文件只是下一阶段的准入事实。
