# MAX-238 B1：固定模板绑定的内部预检

2026-10-27。本包是 MAX-238 原范围中可独立实施的最小内部子集：只做固定 pin 的只读预检，不接入路由、存储、调度、正式采集或应用事务。B1 通过不代表 A06/A07/A09/A16/A20 或整项验收通过。

## 结论

- 新增未挂载模块 `apps/db-ops-api/src/metrics/bindings/`，提供 `preflightResourceBinding(input, port)`。
- 输入用既有 `ResourceBindingCandidateSchema` 校验；每个 pin 仅通过注入的 `getVersion(template_id, version)` 读取固定版本，核对身份、published 状态、pin hash、返回 hash 和按 `stable(aggregate)` 重算的 hash。
- 多 pin 结果保留每个模板自己完整的 item 身份 `(template_id, item_id)`、不可变 package release、参数 schema/defaults、trigger refs 和 source_chain，不扁平合并。
- 以 canonical `(metric.id, semantic_version)` 检测提供者重叠；所有重叠（含同值、不同 unit/dimension）显式拒绝，带双方 pin/item 和稳定机器码，不做后者覆盖前者。
- 成功结果只有 `kind: "legacy" | "template_preflight"` 且 `compiled: false`，不输出 applied/healthy/首样本/正式测试/CAS/授权结论。

## 基线与输入

| 项 | 值 |
| --- | --- |
| 本任务分支 | `agent/15coder1/max-238` |
| 起始 HEAD | `f782907e0cbcb2584a041703be52f9f20bc0b151` |
| 实现提交 HEAD | `6cbd8497635405550cc2c36b62c2db48077f9066` |

当前分支原先既无 `apps/db-ops-api/src/contracts/metrics/templates.ts`，也无 `apps/db-ops-api/src/metrics/templates/model.ts`，因此按准入包授予的精确例外，从 MAX237 已接受 T1 `1d7f9e1f9c5a1649a7791b995691b72f5b21f887` 逐字节提取，未修改内容：

| 提取文件 | git blob | 独立核对 |
| --- | --- | --- |
| `apps/db-ops-api/src/contracts/metrics/templates.ts` | `bdd455ccc218c9e8543eaee6ad5bc5686f414170` | 与 MAX236 REAL-C R1 `228c942ffe3bd3ad66d4e5a6eecdd0982efbf4c4` 同 blob；sha256 `76bcdfebd5af681e84453fc59e2da05b50f36ca2c8aeadecef8844e80c579a45` |
| `apps/db-ops-api/src/metrics/templates/model.ts` | `5b955b8e7a3d127fdf81e0943b37fd0b425098a5` | T1 实际内容；提供 `templateContentHash`、`canonicalKey` |

依赖的 `contracts/metrics/definitions.ts`、`contracts/metrics/index.ts`、`metrics/packages/model.ts` 在本分支与 T1 完全同 blob（`385ee8d4`、`0e20dc49`、`5628591d`），因此提取文件无需任何适配修改。

`TemplateRepository.getVersion` 是准确读端口；本模块只声明结构等价的最小接口 `TemplateVersionReadPort`，不读取 `MetricTemplateService.detail()` 的 current，也不提取 repository 实现。

## 允许文件的 diff

只新增以下文件，未修改任何既有文件、schema、路由、DDL、前端或生成契约：

- `apps/db-ops-api/src/contracts/metrics/templates.ts`（逐字节提取，未修改）
- `apps/db-ops-api/src/metrics/templates/model.ts`（逐字节提取，未修改）
- `apps/db-ops-api/src/metrics/bindings/index.ts`
- `apps/db-ops-api/src/metrics/bindings/preflight.ts`
- `apps/db-ops-api/src/metrics/bindings/preflight.test.ts`
- 本文档

未在 `contracts/metrics/index.ts`、`public-api.ts` 或生成契约中导出新符号；`contracts:check` 无差异。

## 行为实现要点

1. 输入为 `unknown`，先经 `ResourceBindingCandidateSchema.safeParse`；重复/乱序 pin、版本 0、revision 0、`template_pins: []` 且 `package: null` 均直接拒绝，不做静默去重、排序或补默认值。
2. 只有 `template_pins` 为空且 `package` 非空才进入 legacy 分支，原样保留 package 与 binding，不调用模板端口。
3. 每个 pin 串行按 `(template_id, version)` 读取；返回对象经 `TemplateVersionSchema` 再校验（含 composition 覆盖、collector release 与覆盖 release 一致）。`getVersion` 抛错统一收敛为 `PREFLIGHT_READ_FAILED`，不携带原始异常。
4. 输出 item 直接取自已校验的固定版本快照，带 `template_id`；相同 `item_id` 分属不同模板时仍是两个身份，不经 `item_id` 单键 map 合并。
5. canonical 重叠按身份键 `(id, semantic_version)` 分组，组内 ≥2 个提供者即冲突；同一模板内两个 item 命中同一 canonical metric 也保守报告。冲突按 canonical 排序，组内按 `(template_id, item_id)` 排序，稳定可复现。
6. 参数、trigger refs、source_chain 按 pin 原样保留；不计算 effective trigger、参数最终值、事件或评估。
7. 模块无 I/O、无数据库、无持久化、无随机、无时间依赖；不改输入和端口返回对象（zod parse 产出新对象）。

## 稳定机器码

| 代码 | 含义 |
| --- | --- |
| `PREFLIGHT_INPUT_INVALID` | binding 快照不符合既有候选 schema |
| `PREFLIGHT_READ_FAILED` | 读端口异常（原始异常不向外传递） |
| `PREFLIGHT_VERSION_MISSING` | 固定版本不存在（返回 null） |
| `PREFLIGHT_VERSION_INVALID` | 返回对象不符合 `TemplateVersionSchema` |
| `PREFLIGHT_VERSION_IDENTITY` | 返回对象的 template_id 或 version 与 pin 不一致 |
| `PREFLIGHT_VERSION_RETIRED` | 返回版本状态不是 published |
| `PREFLIGHT_CONTENT_HASH_MISMATCH` | pin hash、返回 hash、重算 aggregate hash 三者不一致 |
| `PREFLIGHT_CANONICAL_CONFLICT` | canonical metric 提供者重叠（`conflicts` 携带完整双方信息） |

## 验证证据（绑定实现提交 `6cbd8497635405550cc2c36b62c2db48077f9066`）

环境：本机 worktree，Node `v24.18.0`，pnpm `11.19.0`，`pnpm install --frozen-lockfile` 后运行。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| B1 focused | `pnpm --filter slide-api exec vitest run src/metrics/bindings/preflight.test.ts` | 1 file / 21 tests 全通过 |
| 受影响模块 | `pnpm --filter slide-api exec vitest run src/metrics/bindings/preflight.test.ts src/metrics/packages/packages.test.ts src/contracts/metrics/contracts.test.ts` | 3 files / 146 tests 全通过 |
| API typecheck | `pnpm --filter slide-api typecheck` | 通过，无输出错误 |
| 契约检查 | `pnpm contracts:check` | 通过（无生成差异） |
| 局部 lint | `pnpm exec oxlint apps/db-ops-api/src/metrics/bindings apps/db-ops-api/src/metrics/templates apps/db-ops-api/src/contracts/metrics/templates.ts` | 0 warnings / 0 errors |

未运行：全量测试重跑、MySQL 实机测试、真实采集、部署、模型 Provider 调用、子代理。本包无产品模型请求，不消耗 1000 万测试预算。

## 反例覆盖

focused tests 逐条断言业务结果与端口调用，不镜像实现：

- 有效双 pin、多 release：每个 item 带自身模板归属、release 与 per-pin 参数（同名 `interval_ms` 不同默认值保持分离）。
- 相同 `item_id` 分属两个模板：不碰撞、不合并。
- canonical 重叠：同值同 unit/dimension 拒绝；不同 unit/dimension 拒绝；`display_name` 不同仍按 canonical 身份拒绝；多冲突及组内提供者顺序稳定。
- 不同 `semantic_version` 不误判同一 identity。
- current 指针前进后仍读取固定 pin（端口只按 v1 调用，未以 v2 调用）。
- 缺失、retired、身份替换（模板或版本号）、pin hash 伪造、返回 hash 伪造、aggregate 参数篡改、端口异常。
- 端口异常错误中不含原始异常文本（含 `password=` 样例），且不存在部分成功返回。
- 重复 pin、乱序 pin、版本 0、revision 0、空绑定均经既有 schema 拒绝，端口零调用。
- legacy 分支不调用端口；非空 pin 时 legacy package 仅保留为兼容字段，不替代 pin；输出不含 applied/healthy/首样本/CAS/授权字样。
- 仅改 `source_chain` 的 actor/request 不改变 hash，预检仍通过。
- 输入与端口返回对象运行前后 JSON 完全一致；aggregate、items、triggers、collector release 未被改写。

## 未实现项与本包边界

以下均为后续准确包或既有归属，本包不声称已具备：

- revision 比较、并发原子 CAS、幂等键（资源 + 目标 revision + digest）：B2 及既有 `payload.binding` 事务。
- 测试结果 digest/revision、测试失效重校验、资源权限变化失效：B2 / 授权集成。
- 参数覆盖解析、effective trigger、评估与事件：MAX-239 / 后续 binder。
- package registry 实现核验与真正多 release 编译、scheduler wiring：B2；现有 `metrics/scheduler/compiler.ts` 仍只支持单 package，本包未改。
- 解绑预览、历史保留、未恢复规则停止评估：MAX-240。
- 模板发布/重试/回滚事务：MAX-237 既有实现。
- 冲突解决 UI、优先级、跨模板来源选择：不在 B1。

集成注意：输入必须是候选 schema 的完整形状。缺失 `template_pins` 键（而非显式空数组）会被 strict schema 拒绝；真实 legacy 负载的迁移或归一化属于 B2，本包不做静默补键。读端口不自带资源授权证明，调用方必须在接入时另验权限。

## 下一步最小事实

B2 需要：现有 `payload.binding` 的 CAS 读写路径与 revision 来源、测试配置与 digest 的存储位置、是否允许同一资源多个 release 的真实 compiler 输入，以及 shared wiring 的写入授权。缺少 wiring 只阻塞 B2 对应动作，不要求 MAX-236 整单完成。
