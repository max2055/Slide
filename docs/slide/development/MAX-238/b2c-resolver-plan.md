# MAX-238 B2C：多模板参数/策略 resolver 与隔离 release 计划

2026-10-27。本包承接 Chief 已接受的 B2B-R1 `30e17892eb23124317d94805a158973d7970929c`，只做纯内部的多模板解析与隔离计划。它不接路由、存储、事务、scheduler runtime、runner 或正式采集，也不代表 MAX-238 整项验收通过。

## 结论

- 新增未挂载模块 `apps/db-ops-api/src/metrics/bindings/resolve.ts`，入口 `resolveTemplateBinding(binding, context, port, registry)`：消费原始 `payload.binding` 快照和受信 `resource/group/capabilities/at`，每次强制重走 B1 `preflightResourceBinding` 与 B2A `compileBindingCandidate`。
- legacy（无 `template_pins`）只返回 `legacy_delegate` 原样对象：不读模板、不解析参数/策略、不伪造多模板计划；空绑定仍由 B1 拒绝。
- 每个 pin 的参数只从其 `TemplateParameters.schema/defaults` 与内部 `binding.overrides.template_parameters[template_id][name]` 取得；默认值与最终值都按 schema 校验，覆盖值不会掩盖无效默认，同名参数跨模板隔离。
- 多 release 的同一资源设置按既有 package→group→resource 层级解析：默认一致时报出来源 release 集合；显式 group/resource set/toggle 消除差异；否则以 `RESOLVE_SETTING_CONFLICT` 列明字段与各 release 值拒绝，不选第一个/最后一个、不取 min/max。
- 兼容性/能力按每个准确 release 复用 `checkApplicability`、既有 capability 时效/资源/method 规则与 `resolveDecision`；unsupported/unknown 显式记录并阻止计划执行，不用模板名、参数或默认凭据冒充支持。
- 新增 `bindings/plan.ts`，入口 `buildTemplateCollectionPlan(resolution)`：只把选中且 `collect` 的 item 投到各 release 的独立步骤；跨 release 不合并，同 release 同 implementation 仅在有效参数一致时共享一次读取；不把 `package: null` 交给旧 `compilePlan`。
- 结果全部标记 `internal: true, persisted: false, applied: false`；没有任何生产 compiler、权限、CAS、试采应用、正式样本或健康结论。

## 基线与允许文件

| 项 | 值 |
| --- | --- |
| 承接 B2B-R1 HEAD | `30e17892eb23124317d94805a158973d7970929c` |
| 实现 + focused tests 提交 | `352c6cfad8f9f0ec1ff6424c47cbf367f11e1ae9` |
| 本文档提交 | 仅在其上追加本文档，见任务分支 HEAD |

相对基线只新增/修改以下允许文件；未改路由、事务 guard、模板/包契约、policy/model、service/store、config、scheduler service/store/runtime/lifecycle、runner、DDL、生成契约、前端、事件或历史：

- `apps/db-ops-api/src/metrics/bindings/resolve.ts`（新增）
- `apps/db-ops-api/src/metrics/bindings/resolve.test.ts`（新增）
- `apps/db-ops-api/src/metrics/bindings/plan.ts`（新增）
- `apps/db-ops-api/src/metrics/bindings/plan.test.ts`（新增）
- `apps/db-ops-api/src/metrics/bindings/index.ts`（仅新增两行 re-export）
- `apps/db-ops-api/src/metrics/policy/resolver.ts`（仅提取纯 helper；`resolvePolicy` 签名与行为不变）
- `apps/db-ops-api/src/metrics/scheduler/compiler.ts`（仅提取纯 helper；`compilePlan` 签名与行为不变）
- 本文档与 `b2c-transaction-wiring.md`

`contracts/metrics/templates.ts`、`metrics/templates/model.ts`、`policy/model.ts` 未修改；`OverridesSchema` 未扩大，`template_parameters` 只由多模板分支识别。

## 行为实现要点

1. **入口与身份**：`resolveTemplateBinding` 先校验受信 `resource`（`ResourceSchema`）、`at`（时间戳）、`group`（与 `binding.group_id` 精确一致）与 `capabilities`（逐个 `CapabilitySchema`），再调用 `compileBindingCandidate`；随后核对受信 resource 与候选 resource 的 type/id 一致。legacy 分支在参数/策略解析前返回，端口与 registry 均不访问。不读 `current` 指针、不 install、不改输入或 registry。
2. **参数准确解析**：schema 中每个参数（按名称排序）检查 spec 是否受支持（`boolean` 带 min/max、有限性、string 边界的非负整数性），随后校验默认值（即使有覆盖也校验），再校验覆盖值的 JS 类型、有限性、integer 性、min/max；string 的 min/max 解释为字符长度。缺默认且无覆盖为 `RESOLVE_PARAMETER_MISSING`；未选 template 或其参数为独立拒绝。输出每参数 `{name, type, default, override, effective, source}`，并带该 pin 的 `(template_id, version, content_hash)`。参数从不参与 cadence、SQL、SSH、凭据、implementation 或支持判定。
3. **有效策略与冲突**：`policy/resolver.ts` 提取 `defaultSettings`/`defaultSettingSources`/`applyPolicyLayer`/`validatePlatformSettings`/`collectorTimeouts`/`resolveItemCapability`。B2C 对每个 release 用同一组 group→resource 层得到该 release 的结果，再逐字段比较：全部一致 → 采用该值；package 默认 → 来源列出全部一致 release，platform 常量 → `{layer:'platform', id:'metrics-limits-v1'}`；显式层 → group/resource 来源与 revision；不一致 → `RESOLVE_SETTING_CONFLICT` 并列出每个字段的 `{release, value}`。物理 collector timeout 仍取 `min(collector.timeout_ms, settings.timeout_ms)` 并保留 min 规则来源。metric toggle 只允许选中 canonical metric，未知/未选由既有 `POLICY_UNKNOWN_METRIC` 拒绝（包装为 `RESOLVE_OVERRIDE_INVALID`）。
4. **兼容性与能力**：每个 release 运行既有 `checkApplicability`；每个 item 用 `resolveItemCapability`（既有 capability 时效/资源/method 规则与 applicability 覆盖）和既有 `resolveDecision` 得到 `collect/disabled/unsupported/capability_unknown`。unsupported 与 unknown 均进入 `excluded` 且 `blocking: true`，`executable` 为 false；显式 disable 不是 blocker。没有模板名/参数推断的 “supported”，也没有默认凭据。
5. **完整计划**：`buildTemplateCollectionPlan` 只投影 decision 为 `collect` 的 item；每步带准确 release pin、resource/revision、有效 settings 与来源、模板参数值/来源、applicability、capability、具体 dimensions、collector timeout 与 mapping（含按序 `steps`）。未选 metric/collector/derived 不进入 steps、queries、metric_keys、请求估计或预算。`resolveDecision`/`validateDimensions`（B2A）与 `validateBindings`（每 release 的 collection/policy/package/source 校验）均复用，未复制第二套规则。
6. **隔离与稳定身份**：步骤 key 为 `collector + method + implementation + 有效参数签名`；跨 release 永不合并，同 collector/implementation 出现在两个 release 时仍是两组；参数不同也不合并。`estimated_series_upper_bound` 按选中且非 disabled/unsupported 的具体 item 计数（每个绑定 item 恰为 1 条 series），不会把维度化 item 当泛发现模板，也不计入未选项。请求量仅为 `logical_reads` 估计。`templateResolutionIdentity` 覆盖 resource/revision、group 身份、pin/hash、全部参数（default/override/effective/source）、settings 与来源、metric 来源、未执行 trigger 引用、各 release/item 的 release、qualified 身份、dimensions、按序 mapping、capability 与 decision、excluded 与 executable；不包含 `at` 本身，pin/hash/参数/来源/依赖/兼容库存变化都会改变身份。
7. **错误与兼容**：所有本包拒绝是 `TemplateResolutionError`（稳定 code + `{pin, template_id, parameter, field, releases}` 结构化位置；冲突额外带 `conflicts`）；计划拒绝是 `TemplatePlanError`。registry/driver/port 文本、参数值和凭据不进入 message。失败不返回部分结果，输入、受信 context 与 registry 均不变。旧 `resolvePolicy`/`compilePlan` 的签名、默认行为与现有测试全部保留；本包 identity 不是 B2B `bindingCandidateDigest`，后续受测执行身份必须另行覆盖本次 resolved 语义。

## 稳定机器码

| 代码 | 含义 |
| --- | --- |
| `RESOLVE_RESOURCE_INVALID` / `RESOLVE_RESOURCE_IDENTITY` | 受信 resource 形状无效 / 与 binding 的 type·id 不一致 |
| `RESOLVE_GROUP_INVALID` / `RESOLVE_GROUP_IDENTITY` | group 形状无效 / group_id 与受信 group 不一致或缺失 |
| `RESOLVE_AT_INVALID` / `RESOLVE_CAPABILITY_INVALID` | 受信时间或 capability 形状无效 |
| `RESOLVE_RELEASE_UNAVAILABLE` / `RESOLVE_RELEASE_RESOURCE` | 准确 release 读取失败 / release resource_type 与资源不一致 |
| `RESOLVE_RELEASE_INCONSISTENT` | 候选中的 collector 在准确 release 内找不到（一致性保护） |
| `RESOLVE_PARAMETERS_INVALID` | `template_parameters` 命名空间不是 `{template_id: {name: scalar}}` 形状 |
| `RESOLVE_PARAMETER_TEMPLATE_UNSELECTED` / `RESOLVE_PARAMETER_UNKNOWN` | 覆盖指向未 pin 的 template / 该 template 未声明的参数 |
| `RESOLVE_PARAMETER_MISSING` | 无默认值也无覆盖 |
| `RESOLVE_PARAMETER_SPEC` | schema 规格不受支持（boolean 带 min/max、非有限或非法 string 边界） |
| `RESOLVE_PARAMETER_DEFAULT_INVALID` / `RESOLVE_PARAMETER_TYPE` / `RESOLVE_PARAMETER_RANGE` | 默认值无效 / 覆盖类型错 / 覆盖越界、非整数或非有限 |
| `RESOLVE_OVERRIDE_INVALID` | group/resource 既有 OverridesSchema 拒绝（含 `POLICY_UNKNOWN_METRIC`，见 `rule`） |
| `RESOLVE_SETTING_CONFLICT` | 无显式决定且各 release 默认不一致（见 `conflicts`） |
| `RESOLVE_SETTINGS_INVALID` | 合并后不满足既有平台限制（见 `rule`：`POLICY_*`） |
| `RESOLVE_VALIDATION` | 该 release 不满足既有 `validateBindings` 契约 |
| `PLAN_INPUT_INVALID` / `PLAN_RELEASE_INCONSISTENT` / `PLAN_SERIES_BUDGET` | 非多模板结果 / 计划与 release 身份不一致 / 选中集合超过有效 series 预算 |

B1 的 `PREFLIGHT_*` 与 B2A 的 `CANDIDATE_*` 继续原样抛出。

## 验证证据（绑定实现提交 `352c6cfad8f9f0ec1ff6424c47cbf367f11e1ae9`）

环境：本机 worktree，Node `v24.18.0`，pnpm `11.19.0`，`pnpm install --frozen-lockfile` 后运行；每条命令以真实退出码记录，不以管道 `$?` 代表成功。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| B2C resolver focused | `pnpm --filter slide-api exec vitest run src/metrics/bindings/resolve.test.ts` | 1 file / 24 tests 全通过，exit 0 |
| B2C plan focused | `pnpm --filter slide-api exec vitest run src/metrics/bindings/plan.test.ts` | 1 file / 9 tests 全通过，exit 0 |
| bindings 模块 | `pnpm --filter slide-api exec vitest run src/metrics/bindings` | 5 files / 149 tests 全通过，exit 0 |
| 受影响模块 | `pnpm --filter slide-api exec vitest run src/metrics/bindings src/metrics/policy src/metrics/scheduler src/metrics/packages src/contracts/metrics` | 15 passed + 4 skipped files；345 passed + 36 skipped tests，exit 0 |
| 旧 resolver/compiler 行为 | 同上（`policy/resolver.test.ts`、`scheduler/compiler.test.ts` 未修改） | 全部原样通过 |
| API typecheck | `pnpm --filter slide-api typecheck` | 通过，无输出错误，exit 0 |
| 契约检查 | `pnpm contracts:check` | 通过（无生成差异），exit 0 |
| 局部 lint | `pnpm exec oxlint apps/db-ops-api/src/metrics/bindings apps/db-ops-api/src/metrics/policy/resolver.ts apps/db-ops-api/src/metrics/scheduler/compiler.ts` | 0 warnings / 0 errors |

未运行：全量回归、MySQL 实机、真实资源/DB/SSH/SNMP、负载或 SLO 实测、模型/Provider 调用、子代理、CI 轮询、部署。本包无产品模型请求，不消耗 1000 万测试预算，不动 MAX224 账本。

## 反例覆盖

fixture 全部经既有 `sealRelease` + `PackageRegistry.install` 安装并从 `get`/`catalog` 读取，不以 mock 冒充 release 存在性。

- **两 release 同名 collector/implementation 隔离**：`fixture-a` 与 `fixture-b` 的 `status` + `impl:fixture.main` 各自成组，item 不跨 release。
- **selected-only**：未选 mapping（`beta`/`delta`）和未 pin 的 `fixture-a@2.0.0` 不出现在 resolution、steps、queries、metric_keys 或预算中。
- **参数同名隔离**：两个模板都在 schema/defaults 声明 `batch_size`，覆盖只改一个模板；另一个保持默认。
- **默认、覆盖与恢复继承**：有覆盖 → `source: override`；移除覆盖 → 恢复 `source: default`；结果确定。
- **类型/边界/未知/缺失**：覆盖未知参数、错误类型、非整数 integer、越 min/max、`Infinity`、string 长度越界、boolean 类型错误分别拒绝；boolean spec 带 min、未选 template、缺默认、无效默认（即使有覆盖）分别拒绝；`template_parameters` 非对象形状拒绝。
- **设置冲突与显式解决**：两 release 推荐 interval 60000/90000 → `RESOLVE_SETTING_CONFLICT` 列出字段与两 release 值；resource override 30000 → 来源 resource+revision；group override 10000 → 来源 group+revision。未知 metric toggle 与 group 级 `template_parameters` 拒绝；合并后违反平台 timing → `RESOLVE_SETTINGS_INVALID`（`rule: POLICY_TIMING`）。
- **group/资源身份**：binding 资源 id/type 与受信 resource 不一致、group 缺失/错配、非法 group 形状、非法 `at`、非法 capability/资源 shapes 全部稳定拒绝。
- **具体 dimensions**：`delta` 的 `{mount, device}` 原样保留；mapping `steps` 顺序保留。
- **unsupported/unknown/future/expired/适用性**：无 capability → `capability_unknown`（`capability_not_probed`）；`status: unsupported` → `unsupported`；未来/过期 capability → `capability_expired_or_future`；engine 不匹配 → applicability unsupported → item unsupported；缺 engine 属性 → unknown。以上均 `executable: false` 并列入 `excluded`。
- **源变化身份**：参数覆盖、resource 设置覆盖、capability 库存、trigger 引用、pin 版本变化都改变 `templateResolutionIdentity`；同一语义在不同 `at` 下身份不变。
- **legacy/零变更**：legacy 不调用模板端口与 `registry.get`；空绑定与 canonical 重叠仍由 B1 拒绝；成功与失败前后 binding、受信 context、registry 深比较一致；重复调用结果深相等。
- **计划隔离**：两 release 各自独立 plan；不同参数 → 2 steps/2 queries/120 logical reads/h，相同参数 → 合并 1 step/1 query/60；disabled metric 排除且预算为 1；整体 disable → 无 step、0 请求、0 series、非 executable；unsupported/unknown → 无 step、blocking；超预算 → `PLAN_SERIES_BUDGET`；legacy/`null` → `PLAN_INPUT_INVALID`；修改 plan 不影响 resolution。

## 明确未实现与本包边界

- 未挂载：没有路由、HTTP 契约、权限或 actor 校验、revision CAS、idempotency key、事务或审计写入。
- 不是生产 compiler：`scheduler/compiler.ts` 仍只消费单 package `Resolved`；没有多 release 总包原子执行、runtime/service/store/runner 接线，也没有应用事务或回滚证明。
- 未发行/校验真实测试凭证，未运行 trial，未访问凭据或目标；`excluded`/`blocking` 是内部判定，不是正式试采结论。
- 未持久化：`template_parameters` 仍只存在于候选 payload 的内部命名空间，`policy/model.ts` 未改；没有 DDL、第二张表或内存生产 store。
- `templateResolutionIdentity` 不是 B2B `bindingCandidateDigest`，也不是受信 receipt；它不是真实负载、SLO、首样本或健康结论。
- MAX-238 原五项、A06/A07/A09/A16/A20 及整批 A01–A22/四标准/D05/O02/O03 不因本包缩减或改称通过。

## 下一步最小事实

事务接线方案见 `b2c-transaction-wiring.md`：B2C 输出 → `payload.binding` 唯一 revision → receipt 执行身份 → 同一 `PolicyStore` 事务的读/校验/保存/幂等/审计顺序。真实 adapter、存储位置放行、受信 receipt issuer、trial 与多 release 执行仍待 Chief 在 B2C 验收后决定；不要求 MAX-236 整单 done。
