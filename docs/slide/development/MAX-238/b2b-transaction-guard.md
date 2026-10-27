# MAX-238 B2B：应用前事务决策与受信测试凭证守卫

2026-10-27。本包承接已接受的 B1 `af4efc3af87874267afeaee35d6b6ff1a424be8b` 与 B2A `78c841e7c45cacb42fcfc6fd16fc2076700ccd0d`，只做内部“候选是否仍是受测对象、能否进入待应用事务”的决策守卫。它不接生产存储、不发行真实试采凭证、不应用、不启用；也未改动 `policy`/`store`/`config`/`scheduler`/路由/DDL/生成契约/前端/事件/历史。接线图见 `b2b-transaction-wiring.md`。

## 结论

- 在 `apps/db-ops-api/src/metrics/bindings/` 新增未挂载模块 `transaction-guard.ts`，提供 `prepareTemplateBindingMutation(request, transaction, templates, registry)`。
- 入口先执行受信授权检查，再**强制重新调用 B2A `compileBindingCandidate`**；B1/B2A 的稳定拒绝原样透传，请求自带的 `compiled`/`validated`/`candidate_digest`/`passed`/receipt 内容一律拒绝，旧 candidate 快照不能证明当前状态。
- 当前状态只来自受信事务视图：现有 per-resource `payload.binding` 是配置事实，其 `revision` 是唯一 CAS 权威；比较资源身份与 `expected_revision`，目标 revision = expected + 1，并要求安全整数。
- 候选摘要 `bindingCandidateDigest`（内部格式版本 `max238.binding-candidate.v1`）绑定资源、base/target revision、固定 pin/hash/release、qualified item、collector/mapping、完整 `package`/`group_id`/`overrides`、B2A unresolved 来源和受信服务端配置依赖摘要。它只排序真正的集合；mapping steps 等有语义顺序的数组保持原顺序。
- 请求最多提供 `receipt_id`；完整 receipt 只能经受信端口查询。端口缺失、查找失败、抛异常、结构不可验证均拒绝，没有默认成功。
- 输出只有四种：`prepared`（待写决策，未持久化/未接受）、`replay`（精确已提交操作，原回执，不新增 revision）、`operation_lookup_required`（未知受理结果，只能查原操作）、`legacy_delegate`（原单 package 流程）。不输出 applied/healthy/正式采集成功。

## 基线与允许文件

| 项 | 值 |
| --- | --- |
| 承接 B2A HEAD | `78c841e7c45cacb42fcfc6fd16fc2076700ccd0d` |
| 实现 + focused tests 提交 | `dd0a5e8ba` |
| 本文档提交 | 仅在其上追加本文档，见任务分支 HEAD |

相对 B2A HEAD 只新增以下允许文件，未改 B1/B2A 已接受源码：

- `apps/db-ops-api/src/metrics/bindings/transaction-guard.ts`（新增）
- `apps/db-ops-api/src/metrics/bindings/transaction-guard.test.ts`（新增）
- `apps/db-ops-api/src/metrics/bindings/index.ts`（增加一行 re-export）
- `docs/slide/development/MAX-238/b2b-transaction-wiring.md`、本文档

复用既有实现：`compileBindingCandidate`（B2A）、`preflightResourceBinding`（B1）、`stable`（`packages/model`）、`ResourceBindingCandidateSchema`/`ResourceRefSchema`/`HashIdSchema`/`TimestampSchema`（既有契约）、`PackageRegistry` 真实安装 fixture。没有第二套 package/registry/引擎。

## 行为实现要点

1. **入口唯一**：`prepareTemplateBindingMutation` 先 `safeParse` 严格请求结构，再读取受信授权；随后 `await compileBindingCandidate(candidate, templates, registry)`。B1/B2A 错误（`PREFLIGHT_*`、`CANDIDATE_*`）以原类型原 code 透传，且在任何 transactional 读/写决策之前发生。
2. **身份与 CAS**：`compiled.binding.resource`、请求资源、受信 current 资源三者必须一致；`compiled.binding.revision` 是 expected，受信 `current.revision` 必须相等；目标 = expected + 1，超出安全整数即 `TRANSACTION_REVISION_CONFLICT`。创建首个绑定（current 不存在）不在本包范围，显式 `TRANSACTION_BINDING_MISSING`；解绑/空绑定另由显式流程接线。
3. **候选摘要**：`bindingCandidateDigest(candidate, target, dependencyDigest)` 使用 `node:crypto` + `stable`，输出 `sha256:<64 hex>`。覆盖项见上；`stable` 只对对象键排序，数组保持输入顺序，而 pin/collector/item 的规范顺序由既有 schema 与 B2A 保证。摘要只声明候选身份，不声明已解析执行计划。
4. **受信 receipt**：`BindingTransactionPort.getTrialReceipt(receiptId)` 返回完整 receipt，内含资源、base/target revision、候选 digest、依赖摘要、服务端签发/过期时间、逐项 `phases.read/transform/unit` 结果与 `optional_exclusions`。请求体不携带任何 receipt 事实。结构不符 → `TRANSACTION_RECEIPT_INVALID`。
5. **逐项覆盖**：selected item 来自 B2A 编译结果；mandatory 清单来自受信端口（`mandatoryItems`），端口缺席时默认**全部 selected item 必需**。每个 selected item 必须全部 `read/transform/unit` 通过，或属于受信非必需项且在 receipt 中显式排除；外来项、重复项、伪造排除、缺项、任一阶段失败均拒绝。没有试采执行器，也不因“别的 item 有 good sample”放行。
6. **权限与异步边界**：`authorize(resource)` 在候选/receipt 读取前调用一次，在全部异步工作（编译、current、操作、receipt、mandatory、服务端时间）之后、形成决策之前再次调用。撤权 → `TRANSACTION_FORBIDDEN`，取消 → `TRANSACTION_CANCELLED`，依赖摘要变化 → `TRANSACTION_DEPENDENCY_CHANGED`。不接受 caller actor snapshot；端口异常 → `TRANSACTION_AUTH_UNAVAILABLE`。
7. **幂等**：内部操作键 `bindingOperationKey = type:id#target@digest`；`findOperation(caller_key)` 同时承担 caller key 碰撞检查。精确已提交操作 replay 原回执（不新增 revision、不重读 receipt，即使受信 current 已等于目标 revision）；同 key 不同资源/目标/digest → `TRANSACTION_OPERATION_CONFLICT`；状态 `unknown` 只返回 `operation_lookup_required`，绝不自动重发。replay 前仍需当前授权，跨资源信息不进入结果或错误。
8. **待写决策**：`prepared` 输出准确 `current`、`next`（revision = target）、base/target revision、候选 digest 和 pending 回执身份；`prepared: true, persisted: false, applied: false`。只有未来在同一事务内完成重读、校验、`saveBinding`、回执与审计后才可报告 accepted pending。
9. **兼容**：旧 payload 缺失 `template_pins` 与显式空数组按同一 legacy 语义读取（仅补 `[]`，不丢 `package`/`group_id`/`overrides`/`revision`）；legacy 候选返回 `legacy_delegate`，不做 digest、不收 receipt、不写决策，原单 package 流程继续拥有它。无 pins 且无 package 由既有 schema 拒绝；`template_pins` 非空时 package 只作为被摘要把覆盖的既有字段，不作为 release 回退，也不把模板 envelope 送入单 package 的 `PolicyService`/`compilePlan`。

## 稳定机器码

所有本包拒绝都是 `BindingTransactionError`；`message` 等于 code，逐项覆盖错误另带排序后的 `items`（仅 `template_id/item_id/item_version`）。端口/driver 文本、receipt 内容与凭据不会进入错误。

| 代码 | 含义 |
| --- | --- |
| `TRANSACTION_INPUT_INVALID` | 请求结构不符（含客户端自带 validated/digest/passed/receipt 内容） |
| `TRANSACTION_BINDING_UNAVAILABLE` / `TRANSACTION_BINDING_INVALID` / `TRANSACTION_BINDING_MISSING` / `TRANSACTION_BINDING_IDENTITY` | 受信 current 读取失败 / 不可解析 / 不存在 / 属于别的资源 |
| `TRANSACTION_REVISION_CONFLICT` | 受信 revision 与 expected 不符，或目标 revision 非安全整数 |
| `TRANSACTION_AUTH_UNAVAILABLE` / `TRANSACTION_FORBIDDEN` / `TRANSACTION_CANCELLED` / `TRANSACTION_DEPENDENCY_CHANGED` | 授权端口不可用 / 撤权 / 取消 / 配置依赖身份变化 |
| `TRANSACTION_OPERATION_UNAVAILABLE` / `TRANSACTION_OPERATION_INVALID` / `TRANSACTION_OPERATION_CONFLICT` | 操作查询失败 / 记录不可验证 / caller key 碰撞 |
| `TRANSACTION_RECEIPT_UNAVAILABLE` / `TRANSACTION_RECEIPT_NOT_FOUND` / `TRANSACTION_RECEIPT_INVALID` / `TRANSACTION_RECEIPT_MISMATCH` | 端口缺失或抛错 / 查不到 / 结构不符 / 资源-revision-digest-依赖不匹配 |
| `TRANSACTION_RECEIPT_ITEMS_INVALID` | 缺项、外来项、重复项、阶段失败、伪造排除或覆盖不全（带 `items`） |
| `TRANSACTION_RECEIPT_TIME_INVALID` / `TRANSACTION_RECEIPT_EXPIRED` | 无效/未来签发时间或倒序过期 / 已过期 |
| `TRANSACTION_TIME_UNAVAILABLE` / `TRANSACTION_MANDATORY_UNAVAILABLE` / `TRANSACTION_MANDATORY_INVALID` | 服务端时间端口不可用 / mandatory 端口不可用 / mandatory 含外来或重复项 |

B1 `BindingPreflightError`、B2A `BindingCandidateError` 继续以原类型透传。

## 验证证据（绑定实现提交 `dd0a5e8ba`）

环境：本机 worktree，Node `v24.18.0`，pnpm `11.19.0`，`pnpm install --frozen-lockfile` 后运行。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| B2B focused | `pnpm --filter slide-api exec vitest run src/metrics/bindings/transaction-guard.test.ts` | 1 file / 63 tests 全通过 |
| 受影响模块 | `pnpm --filter slide-api exec vitest run src/metrics/bindings src/metrics/packages/packages.test.ts src/contracts/metrics/contracts.test.ts` | 5 files / 225 tests 全通过 |
| API typecheck | `pnpm --filter slide-api typecheck` | 通过，无输出错误 |
| 契约检查 | `pnpm contracts:check` | 通过（exit 0，无生成差异） |
| 局部 lint | `pnpm exec oxlint apps/db-ops-api/src/metrics/bindings` | 0 warnings / 0 errors |

未运行：全量回归、MySQL 实机/真实采集、DB/SSH/部署、共享服务写入、模型 Provider 调用、子代理、CI 轮询。本包无产品模型请求，不消耗 1000 万测试预算，不动 MAX224 账本。

## 反例覆盖

fixture 全部用既有 `sealRelease` + `PackageRegistry.install` 安装真实 release；受信端口按调用计数，只在需要时提供 receipt/mandatory 方法。

- **受信 receipt 入口**：端口缺席、抛错（`password=secret` 不进入错误）、查不到、结构不符（未知字段/缺 phases/非布尔 phase/缺 digest）分别拒绝。
- **时间**：未来签发、过期、expires 早于 issued、服务端时间不可解析，分别拒绝。
- **覆盖**：失败阶段、缺必需项、外来项、重复项、伪造排除、排除未知项、既合格又排除，均 `TRANSACTION_RECEIPT_ITEMS_INVALID` 并带准确 item。
- **可选项**：只有受信 mandatory 清单 + 显式排除才放行；排除受信必需项被拒绝；mandatory 含外来/重复项被拒绝。
- **跨维度**：receipt 绑定另一个 receipt id/资源/base revision/target revision/候选 digest/依赖摘要均 `TRANSACTION_RECEIPT_MISMATCH`；pin 内容 hash 被篡改由 B1 `PREFLIGHT_CONTENT_HASH_MISMATCH` 拒绝，且未读 current/receipt。
- **身份与 revision**：缺 current、别的资源、candidate 资源不符、过期 revision、目标溢出，分别拒绝。
- **权限 TOCTOU**：可变端口构造“异步后撤权”“异步后取消”“依赖摘要变化”，均在形成决策前拒绝；首次拒绝时未读候选/receipt。
- **幂等**：已提交精确重试 replay（含 current 已等于 target）；同 caller key 不同 digest/资源/目标/caller key 冲突；未知状态只返回查原操作且不重读 receipt；replay 前撤权仍拒绝。
- **摘要**：固定 pin/hash/参数默认/overrides/group/package/依赖摘要变化都会改变 digest；对象键顺序不改变；重复计算稳定。
- **失败零变更**：拒绝前后请求深比较一致、registry 列表一致；成功与失败均无写入口。

## 明确未实现与本包边界

- **receipt issuer 与持久化未接线**：`BindingTransactionPort.getTrialReceipt` 只是契约，没有生产实现；本包不签发凭证、不消费凭证、不落库。
- 未接 `PolicyService.changeBinding`/`MysqlPolicyStore`/`ActivationGuard`/`compilePlan`；不运行 DDL、不写共享服务。
- `bindingCandidateDigest` 只是候选身份，不是 `candidateFingerprint`（解析后执行输入）的替代，也不是完整 multi-release `CollectorPlan`。
- 真实 MySQL 锁/CAS、事务原子性、权限提交瞬间一致性、试采执行、正式应用、首样本健康与解绑流程均未验证。
- MAX-238 原五项/A06/A07/A09/A16/A20 与整批 A01–A22/四标准/D05/O02/O03 不因本包缩减或改称通过；本包通过只代表未挂载内部守卫。

## 下一步最小事实

需要 Chief 在终态复审中据源码决定：唯一 revision 与旧 payload 的存储表示、receipt 签发/消费位置与保留期、事务内幂等/审计/权限复验顺序、完整 multi-release resolver 与文件唯一写者。缺少这些只阻塞接线，不要求 MAX-236 整单 done。
