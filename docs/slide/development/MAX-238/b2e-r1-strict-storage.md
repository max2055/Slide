# MAX-238 B2E-R1：严格存储快照与完整 operation 行

2026-10-27。承接 B2E 交付 HEAD `2d9e45f8d`（复审不接受，见 Chief `review.md` F1–F3），实现 + focused tests 提交 `6df4610f3bd090ad9becfc7eef18be55751e3005`，本文件为随后的文档提交。只允许并只改动四个 B2E 文件；`bindings/index.ts` 无需改动（`persistence-codec.js` 已整体导出，`BINDING_PAYLOAD_PACKAGE_ENVELOPE` 随之导出）。仍未挂载：未接路由/存储/调度/正式采集、无默认连接池、无 receipt issuer、未连接或执行任何真实数据库/DDL，未新增依赖，未 push。

## 1. 允许文件与实际 diff

| 文件 | 行数 | 变化 |
| --- | ---: | --- |
| `apps/db-ops-api/src/metrics/bindings/persistence-codec.ts` | 820 | 严格 `Resolved`/`TemplateCollectionPlan` 快照校验、快照身份交叉检查、`package-v1`、pins 边界、JSON 值边界。 |
| `apps/db-ops-api/src/metrics/bindings/persistence-codec.test.ts` | 671 | 真实 `resolvePolicy` 生成的 legacy `Resolved` fixture、完整 B2C plan fixture、C1–C5 回归。 |
| `apps/db-ops-api/src/metrics/bindings/mysql-host.ts` | 823 | 共用严格 stored operation 行校验（事务内查询与只读查询）、损坏消费行 fail closed。 |
| `apps/db-ops-api/src/metrics/bindings/mysql-host.test.ts` | 1135 | 真实 legacy `Resolved` 行 fixture、H1/H2/H4/H5 回归与 H3 合法对照。 |

guard/adapter/resolve/plan/preflight/compile、policy/contracts/packages/templates/scheduler/config/bulk/consumers/rollout/runner/routes/frontend、正式 migrations 均未改；B1–B2D-R1 证据未变复用。

```
f5cd0a64f08a1ee87b1eea4386c5f3a448925276ecb7540a78e3bd31191f1f01  persistence-codec.ts
74e92d1a8eaa380c2f4c3ee4ca932e4c7ef5f083f8a09c7494d70274b12ae91d  persistence-codec.test.ts
914708b91a9a4d1cc5d1218cbab49eb081a8004a754b177b42cc8e5591a4fc85  mysql-host.ts
292a7932401b1be663459a011c95aac4b8301a72362f25d91037e66ed77c3654  mysql-host.test.ts
```

## 2. F1：有效快照必须被真正证明

- **legacy `resolved` 结构**：新增 `LegacyResolvedSchema`，按 `policy/resolver.ts` 实际返回形状严格校验（`plan` 直接复用 `CollectionPlanSchema`；另有 `applicability`、`metric_templates`、`settings`、`platform_limits`、`sources`、`metric_sources`、`dependencies`、`collector_timeouts`、`impact`）。空对象、空壳或拼接对象一律 `BINDING_PAYLOAD_EFFECTIVE_INVALID`，不再被当作 effective。
- **身份交叉**：同一快照必须与行一致——`plan.binding.id === "type:id"`、`resource_type/resource_id` 与行 binding 相同、`config_revision === binding.revision`、`plan.binding.package` 与行 package 三个字段全等、`policy_id === 行 group_id`（无 group 时为 `resource:<key>`）、`plan.policy.id === plan.binding.policy_id`，且 `plan.policy` 与 `resolved.settings` 的七个共享字段一致。
- **B2C plan 形状**：新增 `CollectionPlanShapeSchema`，覆盖 `kind/internal/persisted/applied/executable/identity/resource/revision/settings/parameters/triggers/releases/steps/items/excluded/budget`，含 release/step/item 的 qualified 来源（`release_ref`、`timeout_source`、`pin`、`mapping`、`capability`）与预算数值。只有 `kind/identity/revision/resource` 四标签的 stub 稳定 `BINDING_PAYLOAD_PLAN_INVALID`。
- **各快照 resource**：pending plan 与行 binding.resource 比对；effective plan 也按行 resource 比对，因此跨资源 effective 计划被拒。
- **历史语义保留**：`applied_revision` 与上一份 effective 原样保留，pending 不提升、不标健康；plan 仍保留 base 身份的 `revision`，不改成 target。旧 template 历史快照不强制等于新 pins，只按其实际历史 resource/revision 校验。
- **host 写前拒绝**：绑定行无法通过校验时，guard 以 `TRANSACTION_BINDING_UNAVAILABLE` 失败关闭，`binding/operation/audit` 三次写均为 0，行原样保留。

## 3. F2：明确兼容、不修正坏输入

- 顶层 `envelope: 'package-v1'` 与无 envelope 的 legacy 内容完全同义、严格读取、原样 roundtrip（`encodeBindingPayload` 逐字节还原，包含 envelope）；未知 envelope（`templates-v2`、`package-v2`）稳定 `BINDING_PAYLOAD_UNKNOWN_ENVELOPE`；`templates-v1` 与 legacy 各自的歧义/缺来源规则不变。
- `template_pins` 仅在属性确实缺失时默认 `[]`；显式 `null`/字符串/对象/数字一律 `BINDING_PAYLOAD_BINDING_INVALID`，`[]` 合法，`package` + 非空 pins 仍 `BINDING_PAYLOAD_AMBIGUOUS_SOURCE`。
- 对象输入在 `structuredClone` 之后做 JSON 值检查：`NaN`/`±Infinity`/`BigInt`/`undefined`/非普通对象/循环引用稳定 `BINDING_PAYLOAD_SHAPE_INVALID`；`JSON.parse('1e999')` 产生的 `Infinity` 同样拒绝。`encodeTemplatePendingPayload` 在 `JSON.stringify` 前做同一检查，避免把坏值静默改写成合法快照。

## 4. F3：operation 行完整可信度

- 单一 `operationRowOf(row, expectedCaller)` 供 `findOperationExact` 与 `lookupOperation` 共用：`caller_key` 必须是 host 写出的键空间（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`、UTF-8 字节 ≤255）且与查询键逐字节一致；`receipt_id` 同样非空且合法；`resource_type` 必须过 `ResourceTypeSchema`；`resource_id`/`target_revision` 必须为安全正安全整数（空串、小数、非有限、越界、坏编码一律不合法）；三个 digest 必须为 `HashIdSchema`；`status` 只能 `committed`/`unknown`。
- 任一条件不满足：事务内查询返回 `{complete:false}`（guard → `TRANSACTION_OPERATION_UNAVAILABLE`，零写）、只读查询返回 `{complete:false, operation:null}`；零行仍可 `complete:true/operation:null`，但不被当作可安全 mutation。
- 消费读取：多行或任一行 `caller_key` 损坏 → `{complete:false}`（guard → `TRANSACTION_RECEIPT_UNAVAILABLE`）；`classifyWriteFailure` 只在幸存行可完整读取时才报 `OPERATION_CONFLICT`/`RECEIPT_CONSUMED`，否则 `UNAVAILABLE`。
- 只读查询前先校验请求键可被存储表示，不取连接、不写 unknown、不重发、不复活取消。

## 5. 验证

实现最终状态 `6df4610f3`，Node v24.18.0 / pnpm 11.19.0，全部命令以真实退出码记录（`cmd > log 2>&1; echo EXIT=$?`，不经 `tail` 管道）。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/metrics/bindings` | 8 files / 284 passed | 0 |
| `npx vitest run src/metrics/bindings/persistence-codec.test.ts` | 1 file / 37 passed | 0 |
| `npx vitest run src/metrics/bindings/mysql-host.test.ts` | 1 file / 31 passed | 0 |
| `npx vitest run bindings policy scheduler ../../packages ../../contracts/metrics` | 14 passed + 3 skipped files；343 passed + 35 skipped | 0 |
| `pnpm --filter slide-api typecheck` | 无诊断 | 0 |
| `npx oxlint apps/db-ops-api/src/metrics/bindings` | 0 warnings / 0 errors | 0 |

`contracts:check` 与旧模块未变，按复审沿用 B2E 记录；未跑 CI、全仓全量、真实 DB、模型或资源操作。

### 5.1 Chief 9 反例

将 Chief 两个证据文件原样复制为 `bindings/chief-{codec,host}.test.ts` 后定向运行：**1 failed | 9 passed**，底层退出码 1。唯一失败是 C1——其 fixture 使用 `resolved: {plan:{revision:4}, settings:{enabled:true}}` 的简化空壳，被 F1 严格校验稳定拒绝（`BINDING_PAYLOAD_EFFECTIVE_INVALID`）。这正是复审预先要求的替换点（“C1旧测试fixture本身很简化…不能为了保留这种空壳fixture放松结构校验”），故本包以真实 `resolvePolicy` 生成的 `Resolved` 覆盖 C1 语义：

| Chief 反例 | 本包稳定回归 | 结果 |
| --- | --- | --- |
| C1 `package-v1` 准入 | 真实 `Resolved` 的 `package-v1` 读取、`source=package`、roundtrip 逐字节等价；歧义/缺来源/多余键仍拒 | 通过 |
| C2 显式坏 pins | `'bad'`/`null`/对象/数字 → `BINDING_PAYLOAD_BINDING_INVALID`；缺失 → `[]`；`[]` 合法 | 通过 |
| C3 空 `resolved` | `{}`/`{plan:{...}}`/`null` → `BINDING_PAYLOAD_EFFECTIVE_INVALID` | 通过 |
| C4 四标签假 plan | 四标签或删除任一必需字段 → `BINDING_PAYLOAD_PLAN_INVALID` | 通过 |
| C5 跨资源 effective | 另一资源 plan → `BINDING_PAYLOAD_EFFECTIVE_INVALID` | 通过 |
| H1 空有效计划仍提交 | host 拒绝（`TRANSACTION_BINDING_UNAVAILABLE`），四逻辑状态零写，行原样 | 通过 |
| H2 损坏 operation 完整成功 | `complete:false`/`operation:null`；含 8 类损坏字段 | 通过 |
| H4 真实 legacy 计划错 revision | host 拒绝，零写 | 通过 |
| H5 真实 B2C 计划跨资源 | `decodeBindingPayload` 抛 `BindingPersistenceError` | 通过 |
| H3 合法对照 | 真实 `Resolved` + 真实 B2C 计划 → `committed`，快照原样结转 | 通过 |

另加：损坏 operation 行在事务内 fail closed（`TRANSACTION_OPERATION_UNAVAILABLE`，零写）、损坏消费行不当作已消费（`TRANSACTION_RECEIPT_UNAVAILABLE`）、同一真实 B2C 计划作为本行自身 effective template 快照被接受。

## 6. 未完成与限制

- 真实 MySQL 唯一键、锁等待、deadlock、`JSON_EXTRACT`、commit 时序仍未验证；未做真实 CAS/回滚演练、真实权限/inventory 端口、负载、部署或生产启用。
- `metric_policy_operations` / `metric_policy_trial_receipts` 仍只在候选 SQL 文档中；fixture 不是真实事务或权限保证。
- 所有读者仍未接线（见 `wiring-gates.md`）；B2F 逐文件 writer/base 由 Chief 在本包接受后另定。
- MAX238 与父 MAX235 保持 `in_progress`；原五项/A01–A22/四编码标准/D05/O02/O03 不缩减。
