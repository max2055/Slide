# MAX-238 B2A：固定 release 实现校验与内部采集候选编译

2026-10-27。本包承接 Chief 已接受的 B1 `af4efc3af87874267afeaee35d6b6ff1a424be8b`，只做内部 release 实现核验与采集候选编译。它不接路由、存储、调度或正式采集，也不代表 B2B shared wiring 或 MAX-238 整项验收通过。

## 结论

- 在 `apps/db-ops-api/src/metrics/bindings/` 新增未挂载模块 `compile.ts`，提供 `compileBindingCandidate(input, port, registry)`。
- 入口强制调用 B1 `preflightResourceBinding`：pin、身份、published、content hash、canonical 重叠和 legacy 分支全部沿用 B1，不接受外部构造的“预检结果”。
- 对每个选中的 item，只在其 `collector_ref.package_release` 指向的**准确 release**中核验：`implementation_id` 对应的 collector 确实映射该 canonical metric（id + semantic_version），单位与已注册 definition 一致，dimensions 满足现有 definition 约束。
- 输出按“同 release + 同 collector + 同 implementation + 同 method”分组的内部采集候选；每个 item 保留固定 pin（版本 + hash）、qualified item identity、release pin、collector/implementation 与 mapping。
- 只纳入被选中 item 需要的 collector 和 mapping；不把 release 全部指标默认启用，不合并不同 release，不在同 collector id / implementation id 出现于两个 release 时串包。
- 成功结果只有 `kind: "template_candidate"` 且 `compiled: false`，不输出参数最终值、启用/cadence、凭据、授权、CAS、测试、applied、健康或首样本结论。

## 基线与允许文件

| 项 | 值 |
| --- | --- |
| 承接 B1 HEAD | `af4efc3af87874267afeaee35d6b6ff1a424be8b` |
| 实现 + focused tests 提交 | `4ed862b5cb98380278a07ca82381b4bb73fe7035` |
| 本文档提交 | 仅在其上追加本文档，见任务分支 HEAD |

相对 B1 HEAD 只新增/修改以下允许文件，未改路由、policy/store、compiler/runtime、DDL、生成契约、前端、事件或历史：

- `apps/db-ops-api/src/metrics/bindings/compile.ts`（新增）
- `apps/db-ops-api/src/metrics/bindings/compile.test.ts`（新增）
- `apps/db-ops-api/src/metrics/bindings/index.ts`（增加一行 re-export）
- 本文档

B1 的两个提取文件 `contracts/metrics/templates.ts`、`metrics/templates/model.ts` 未修改；`parsePackageReleaseRef`、`packageReleaseRef`、`canonicalKey` 直接复用。

## 行为实现要点

1. **入口唯一**：`compileBindingCandidate` 先 `await preflightResourceBinding(input, port)`。B1 的 `PREFLIGHT_*` 错误原样抛出；legacy 结果原样返回，不调用 registry，也不声称完成了多 release 编译。
2. **准确 release**：用 `parsePackageReleaseRef` 拆分 `item.collector_ref.package_release`，再 `registry.get({id, version, digest})` 与 `registry.catalog(pin)`。缺失、错 digest 或 registry 抛错统一收敛为 `CANDIDATE_RELEASE_UNAVAILABLE`，不 fallback current、其他版本或兼容 package，不另建字符串白名单。
3. **提供者归属**：provider 必须是该 release 内 `implementation_ref === item.collector_ref.implementation_id` 的 collector，且其已注册 mapping 的 metric 与 item canonical metric（id + semantic_version）一致。其它 collector、同 package 其它实现、全局同名 implementation 都不算提供者；`params_default` 从不读取。
4. **单位与维度**：canonical definition 取自 `registry.catalog(pin)`（canonical + 本 release extensions）；item unit 必须等于 definition unit；`validateDimensions`（既有契约规则）校验未知键、必需键、允许值与长度。任一失败整单拒绝。
5. **derived 最小缺口**：模板 item 只有 `collector_ref`，没有 derived 引用。若 metric 在 release 中仅为 derived 输出、没有 collector mapping，显式以 `CANDIDATE_DERIVED_UNREPRESENTABLE` 拒绝，不新增公开字段、不假定支持、不复制转换/派生引擎。
6. **分组**：key 为 `release_ref + collector.id + implementation_ref + method`。资源由单一 binding 固定；不同 release 不合并，同 collector/implementation id 出现在两个 release 时仍是两组，item 不会被挪到另一个 release。组内 mappings 只含被选中的映射，item 保留完整来源；组与组内顺序按稳定键排序。
7. **未解析来源**：每个 pin 的 `parameters`（schema/defaults）、`trigger_refs`、`source_chain` 放在 `unresolved` 下原样保留，语义是后续 resolver 的输入，不是有效设置或有效 trigger。
8. **无副作用**：不 install/变更 registry、不写存储、无 I/O、无随机、无时间依赖；只调用既有的 `get`/`catalog`（均返回 clone），失败不返回部分结果。

## 稳定机器码

所有本包拒绝都是 `BindingCandidateError`，`message` 等于 code；定位信息在结构化 `location: {pin, item, release}` 中，不依赖 message，也不透传 registry/driver 文本。

| 代码 | 含义 |
| --- | --- |
| `CANDIDATE_RELEASE_UNAVAILABLE` | 准确 release 未安装、digest 不符或 registry 读取失败 |
| `CANDIDATE_TEMPLATE_NOT_EXECUTABLE` | 固定版本没有任何 item（只有 metadata），不构成可执行候选 |
| `CANDIDATE_IMPLEMENTATION_UNAVAILABLE` | 该 release 内没有 item 指定的 implementation 的 collector |
| `CANDIDATE_METRIC_UNAVAILABLE` | implementation 存在，但不提供该 canonical metric |
| `CANDIDATE_METRIC_UNDEFINED` | registry catalog 中找不到该 canonical definition（一致性保护） |
| `CANDIDATE_DERIVED_UNREPRESENTABLE` | metric 仅由 release 的 derived 输出提供，现有模板 item 形状无法表达 |
| `CANDIDATE_UNIT_MISMATCH` | item unit 与 canonical definition unit 不一致 |
| `CANDIDATE_DIMENSION_INVALID` | dimensions 违反已注册 definition 的未知键/必需键/允许值/长度约束 |

B1 自身错误（`PREFLIGHT_*`）继续以 `BindingPreflightError` 透传，归类与 payload 不变。

## 验证证据（绑定实现提交 `4ed862b5cb98380278a07ca82381b4bb73fe7035`）

环境：本机 worktree，Node `v24.18.0`，pnpm `11.19.0`，`pnpm install --frozen-lockfile` 后运行。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| B2A focused | `pnpm --filter slide-api exec vitest run src/metrics/bindings/compile.test.ts` | 1 file / 16 tests 全通过 |
| 受影响模块 | `pnpm --filter slide-api exec vitest run src/metrics/bindings/preflight.test.ts src/metrics/bindings/compile.test.ts src/metrics/packages/packages.test.ts src/contracts/metrics/contracts.test.ts` | 4 files / 162 tests 全通过 |
| API typecheck | `pnpm --filter slide-api typecheck` | 通过，无输出错误 |
| 契约检查 | `pnpm contracts:check` | 通过（无生成差异） |
| 局部 lint | `pnpm exec oxlint apps/db-ops-api/src/metrics/bindings apps/db-ops-api/src/metrics/templates apps/db-ops-api/src/contracts/metrics/templates.ts` | 0 warnings / 0 errors |

未运行：全量回归、MySQL 实机/真实采集、DB/SSH/部署、共享服务写入、模型 Provider 调用、子代理、CI 轮询。本包无产品模型请求，不消耗 1000 万测试预算，不动 MAX224 账本。

## 反例覆盖

fixture 全部通过既有 `sealRelease` + `PackageRegistry.install` 安装，成功路径不使用绕过 registry 的假对象；唯一一个 throwing registry 仅用于验证错误不泄漏，不用于证明可执行。

- **两 release / 不同模板同名 item**：`tpl-one/same` 与 `tpl-two/same` 分属不同 release，仍保留各自模板归属，不发生 item 合并。
- **同 release 共享 collector**：同一模板两个 item 落在同一 collector 时只有一组，两个 item 与两个 mapping 全部保留。
- **两 release 同名 collector/implementation 隔离**：`status` + `impl:fixture.main` 同时出现在两个 release，输出两组、各取自己的 release 与 mapping，不串包/覆盖。
- **固定旧版本**：同 package 安装 `1.0.0` 与 `2.0.0` 时 pin 旧版本，只读 `(template, 1)`，输出固定为 `1.0.0`。
- **缺失 / 错 digest release**：均 `CANDIDATE_RELEASE_UNAVAILABLE`，location 带准确 pin/item/release。
- **implementation 存在但不提供该 metric**：同 release 有该 implementation 的 collector，但 metric 由别的 collector 提供，不用别的提供者冒充。
- **错误 unit、维度缺失/未知/不在允许值**：分别 `CANDIDATE_UNIT_MISMATCH`、`CANDIDATE_DIMENSION_INVALID`。
- **未选择 collector 不进入结果**：只选一个 item 时结果没有未选 collector 及其 mapping；未 pin 的已安装 release 也不出现。
- **无法表达的 derived 来源**：显式 `CANDIDATE_DERIVED_UNREPRESENTABLE`。
- **空项目不冒充可执行**：只有 metadata 的固定版本显式拒绝。
- **B1 行为保留**：canonical 重叠仍由 B1 拒绝，且 registry 零调用；legacy 分支模板端口与 registry 均零调用。
- **异常无秘密 / 无部分成功**：throwing registry 的 `password=secret` 不进入 code/message；所有失败直接抛出，无结果返回。
- **输入与 registry 零变更**：成功与失败前后 binding 深比较一致、`registry.list()` 一致；重复调用输出深相等。
- **params_default 不生效**：带 `secret_sql`/`interval_ms` 默认值的 item 不改变输出，mapping 仍是 registry 中已校验的映射。

## 明确未实现与本包边界

- B2B shared wiring 未做：`policy/model.ts` 仍是单 package binding，`PolicyService.changeBinding` 的 revision CAS、测试 digest/revision 存储、权限失效与事务原子边界未接入；本包不写这些文件。
- 不是 production CollectorPlan / compiler：未做参数覆盖解析、effective trigger、cadence/启用/超时/预算/凭据决策、资源授权、测试凭证、CAS/幂等、调度、应用事务或回滚。
- 无正式健康/测试/授权/CAS/applied/首样本结论；不产生采集 I/O 或正式历史。
- derived 来源的支持需要后续契约决定（例如显式 derived 引用与 mapping 语义）；本包只记录缺口并拒绝。
- MAX-238 原五项、A06/A07/A09/A16/A20 及整批 A01–A22/四标准/D05/O02/O03 不因本包缩减或改称通过。

## 下一步最小事实

B2B 需要基于本包准确接口制定：`payload.binding` 的模板字段兼容与唯一权威、测试 digest/revision 的持久化与失效、权限一致性、CAS/事务原子边界，以及允许写入的 policy/store/runtime 文件所有权。缺少这些只阻塞 B2B，不要求 MAX-236 整单 done。
